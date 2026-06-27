// 레벨/경험치(XP) 시스템: 학습 행동마다 XP 적립.
// Firestore: userStats/{userId}에 totalXP, lastXpDate 필드 추가.
// 레벨 공식: 3구간 지수 곡선. 후반 꼬리가 너무 가팔라지는 걸 완화하려고 r을 단계적으로 낮춤.
//   Lv   1~100: r=1.03 (K1=2200)        → Lv 100 ≈ 40,081 XP
//   Lv 100~200: r=1.02                  → Lv 200 ≈ 424,461 XP
//   Lv 200~   : r=1.015                 → Lv 300 ≈ 2,424,174 XP
// 각 경계에서 한 레벨당 비용이 끊김 없이 이어지도록 K2/K3는 자동 산출.
// 헤비 사용자(1,400 XP/일) 기준: Lv 100 ≈ 29일, Lv 200 ≈ 10개월, Lv 300 ≈ 4.7년.
import { doc, getDoc, increment, setDoc, updateDoc } from 'firebase/firestore';
import { db, auth } from './firebase';

export type XpReason =
  | 'shortform_watched'
  | 'quiz_correct'
  | 'quiz_wrong'        // 0 XP — 기록만
  | 'example_correct'
  | 'example_wrong'
  | 'note_saved'
  | 'review_correct'
  | 'daily_first'
  | 'streak_milestone'
  | 'project_generated';

export const XP_TABLE: Record<XpReason, number> = {
  shortform_watched: 5,
  quiz_correct: 10,
  quiz_wrong: 0,
  example_correct: 15,
  example_wrong: 0,
  note_saved: 0,  // 비활성화 — 단순 저장으로 XP 지급 안 함
  review_correct: 15,
  daily_first: 50,
  streak_milestone: 100,
  project_generated: 30,
};

export interface LevelInfo {
  level: number;            // 현재 레벨
  totalXP: number;          // 누적 XP
  xpInCurrentLevel: number; // 현재 레벨에서 쌓은 XP
  xpNeededForNext: number;  // 다음 레벨까지 필요한 XP (현재 레벨 끝까지)
  progress: number;         // 0..1 (현재 레벨 진척률)
}

// 구간별 ratio. 후반으로 갈수록 완만하게 → 만렙 사냥 꼬리를 너무 비현실적으로 만들지 않음.
const R1 = 1.03;
const R2 = 1.02;
const R3 = 1.015;
const K1 = 2200;

// 경계 1 (L99→L100 한 칸 비용)을 segment 2의 첫 한 칸과 일치시키려고 K2 도출.
// segment N의 마지막 한 칸 = K_N · r_N^(boundary-1) · (r_N − 1)
// segment N+1의 첫 한 칸 = K_{N+1} · (r_{N+1} − 1)
// 두 값을 같게 두면 경계에서 비용이 끊김 없이 이어짐.
const F100 = K1 * (Math.pow(R1, 100) - 1);
const STEP_AT_100 = K1 * Math.pow(R1, 99) * (R1 - 1);
const K2 = STEP_AT_100 / (R2 - 1);

const F200 = F100 + K2 * (Math.pow(R2, 100) - 1);
const STEP_AT_200 = K2 * Math.pow(R2, 99) * (R2 - 1);
const K3 = STEP_AT_200 / (R3 - 1);

function xpForLevel(level: number): number {
  if (level <= 0) return 0;
  if (level <= 100) {
    return Math.round(K1 * (Math.pow(R1, level) - 1));
  }
  if (level <= 200) {
    return Math.round(F100 + K2 * (Math.pow(R2, level - 100) - 1));
  }
  return Math.round(F200 + K3 * (Math.pow(R3, level - 200) - 1));
}

export function computeLevel(totalXP: number): LevelInfo {
  const xp = Math.max(0, Math.floor(totalXP));
  // 구간별 역함수로 추정치 계산 후 라운딩 영향 선형 보정.
  let approx: number;
  if (xp < F100) {
    approx = Math.log(xp / K1 + 1) / Math.log(R1);
  } else if (xp < F200) {
    approx = 100 + Math.log((xp - F100) / K2 + 1) / Math.log(R2);
  } else {
    approx = 200 + Math.log((xp - F200) / K3 + 1) / Math.log(R3);
  }
  let N = Math.max(0, Math.floor(approx) - 1);
  while (xpForLevel(N + 1) <= xp) N++;
  const level = Math.max(1, N + 1); // 시작 레벨 1 (0 XP일 때 level 1)
  const curBase = xpForLevel(level - 1);
  const nextBase = xpForLevel(level);
  const xpInCurrentLevel = xp - curBase;
  const xpNeededForNext = nextBase - curBase;
  const progress = xpNeededForNext > 0 ? xpInCurrentLevel / xpNeededForNext : 0;
  return { level, totalXP: xp, xpInCurrentLevel, xpNeededForNext, progress };
}

// 로컬(=한국) 자정 기준 YYYY-MM-DD.
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface AwardResult {
  awarded: number;          // 실제로 적립된 XP (중복 등으로 0일 수 있음)
  previousLevel: number;
  newLevel: number;
  leveledUp: boolean;
  info: LevelInfo;
}

/**
 * XP 지급. daily_first는 하루 1회만, streak_milestone은 호출자가 dedup 책임.
 * 그 외 reason은 호출 횟수만큼 누적.
 */
export async function awardXP(
  userId: string,
  reason: XpReason,
  multiplier = 1,
): Promise<AwardResult> {
  const base = XP_TABLE[reason] ?? 0;
  const amount = Math.max(0, Math.round(base * multiplier));

  const ref = doc(db, 'userStats', userId);
  const snap = await getDoc(ref);
  const prevData: any = snap.exists() ? snap.data() : {};
  const prevXP = (prevData.totalXP as number | undefined) ?? 0;
  const previousLevel = computeLevel(prevXP).level;

  // daily_first dedup
  if (reason === 'daily_first') {
    if (prevData.lastXpDate === todayKey()) {
      return {
        awarded: 0,
        previousLevel,
        newLevel: previousLevel,
        leveledUp: false,
        info: computeLevel(prevXP),
      };
    }
  }

  if (amount <= 0) {
    return {
      awarded: 0,
      previousLevel,
      newLevel: previousLevel,
      leveledUp: false,
      info: computeLevel(prevXP),
    };
  }

  const newTotal = prevXP + amount;
  const newLevel = computeLevel(newTotal).level;

  const patch: any = { totalXP: increment(amount) };
  if (reason === 'daily_first') patch.lastXpDate = todayKey();

  try {
    if (snap.exists()) {
      await updateDoc(ref, patch);
    } else {
      await setDoc(ref, { totalXP: amount, ...(reason === 'daily_first' ? { lastXpDate: todayKey() } : {}) }, { merge: true });
    }
  } catch {}

  const result: AwardResult = {
    awarded: amount,
    previousLevel,
    newLevel,
    leveledUp: newLevel > previousLevel,
    info: computeLevel(newTotal),
  };
  emitXpEvent(reason, amount, result);
  return result;
}

// 레벨업 / XP 적립 이벤트 알림: UI 토스트 등에서 사용
type XpEventListener = (e: { reason: XpReason; awarded: number; result: AwardResult }) => void;
const xpListeners = new Set<XpEventListener>();
export function subscribeXpEvents(cb: XpEventListener): () => void {
  xpListeners.add(cb);
  return () => { xpListeners.delete(cb); };
}
function emitXpEvent(reason: XpReason, awarded: number, result: AwardResult): void {
  for (const l of xpListeners) { try { l({ reason, awarded, result }); } catch {} }
}

/** 현재 로그인한 사용자에게 XP 지급 (편의 함수, fire-and-forget) */
export function awardXpForCurrentUser(reason: XpReason, multiplier = 1): void {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  awardXP(uid, reason, multiplier).catch(() => {});
}

/** 현재 사용자의 레벨 정보 fetch (홈 화면 등에서) */
export async function getLevelInfo(userId: string): Promise<LevelInfo> {
  try {
    const snap = await getDoc(doc(db, 'userStats', userId));
    const total = snap.exists() ? ((snap.data() as any).totalXP as number | undefined) ?? 0 : 0;
    return computeLevel(total);
  } catch {
    return computeLevel(0);
  }
}
