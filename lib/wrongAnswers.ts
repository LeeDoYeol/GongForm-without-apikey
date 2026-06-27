import { collection, addDoc, getDoc, getDocs, deleteDoc, doc, updateDoc, query, where, documentId } from 'firebase/firestore';
import { db } from './firebase';

export interface WrongAnswer {
  id: string;
  userId: string;
  shortformId: string;
  projectId: string;
  folderId?: string | null; // 선택적 (그룹용)
  title: string;
  script: string;
  wrongAt: string;
  hasSimilarGenerated?: boolean;
  /** 원본 카드의 importance (1~10). 누락 시 5로 간주. 복습 간격 계산에 사용 */
  importance?: number;
  // 간격 반복(Spaced Repetition)
  /** 맞춘 연속 횟수. 틀리면 0으로 리셋 */
  correctStreak?: number;
  /** @deprecated 옛 버전 호환용. 새 코드는 correctStreak 사용 */
  reviewCount?: number;
  /** 최근 복습 시각 (ISO) */
  lastReviewedAt?: string | null;
  /** 다음 복습 예정 시각 (ISO). 없으면 wrongAt+1일로 간주 */
  nextReviewAt?: string;
  /** 가장 최근에 "틀림" 처리된 시각 (ISO). 같은 날 회복 판정용 */
  lastWrongAt?: string | null;
  /**
   * 틀리기 직전의 correctStreak 스냅샷.
   * 같은 날(YYYY-MM-DD) 안에 다시 맞추면 이 값 + 1로 streak를 복구해서 "오늘 잠깐 틀린 거" 패널티를 면해준다.
   */
  streakBeforeWrong?: number | null;
}

/**
 * 다음 복습 간격(일) 계산.
 * - 틀렸을 때(wasCorrect=false): 무조건 1일 후
 * - 맞췄을 때:
 *   - 첫 정답(streak 1): 2일
 *   - streak 2+: importance에 따라 유동적
 *     (중요도 10 → 자주, 1 → 드물게)
 */
function nextIntervalDays(
  correctStreak: number,
  importance: number,
  wasCorrect: boolean,
): number {
  if (!wasCorrect) return 1; // 틀리면 무조건 1일 후
  if (correctStreak <= 1) return 2; // 첫 정답 후 2일
  // streak 2부터: base step × importance scale
  // base[i] = streak (i+2)에서 맞춘 직후의 일수
  const baseSteps = [5, 10, 21, 45, 90, 180];
  const step = Math.min(correctStreak - 2, baseSteps.length - 1);
  const base = baseSteps[step];
  // importance scale: 10 → 0.6배 (자주), 5 → 1.0배, 1 → 1.4배
  const imp = Math.max(1, Math.min(10, importance));
  const scale = 1 + (5 - imp) * 0.08;
  return Math.max(2, Math.round(base * scale));
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// 로컬(=한국) 자정 기준 YYYY-MM-DD. ISO timestamp를 .slice(0,10)하면 UTC 날짜가 나와서
// 한국 시간 새벽 0시 ~ 오전 9시 사이에 한 행동이 어제로 잡히는 문제 → 로컬 기준으로 통일.
function localDayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function saveWrongAnswer(
  userId: string,
  shortformId: string,
  projectId: string,
  title: string,
  script: string,
  folderId: string | null = null,
  importance: number = 5,
): Promise<void> {
  const existing = await getDocs(
    query(collection(db, 'wrongAnswers'), where('userId', '==', userId), where('shortformId', '==', shortformId))
  );
  const wrongAt = new Date().toISOString();
  const nextReviewAt = addDaysISO(wrongAt, 1); // 첫 강제 복습은 1일 후
  if (!existing.empty) {
    // 이미 등재된 카드를 다시 틀린 경우: streak 리셋, 1일 후로 재예약.
    // 단, 같은 날 안에 다시 맞출 경우를 대비해 직전 streak를 stash.
    const docRef = existing.docs[0].ref;
    const existingData = existing.docs[0].data();
    const todayKey = localDayKey(new Date(wrongAt));
    const prevStreak = (existingData.correctStreak as number | undefined)
      ?? (existingData.reviewCount as number | undefined)
      ?? 0;
    const prevStash = existingData.streakBeforeWrong as number | undefined;
    const prevLastWrongAt = existingData.lastWrongAt as string | undefined;
    const wrongAgainSameDay = prevLastWrongAt && localDayKey(new Date(prevLastWrongAt)) === todayKey;
    // 오늘 이미 stash가 있으면 그대로 유지 (틀림→맞춤→틀림 시 원본 streak 보호)
    const newStash = wrongAgainSameDay && prevStash !== undefined && prevStash !== null
      ? prevStash
      : prevStreak;
    await updateDoc(docRef, {
      correctStreak: 0,
      lastReviewedAt: wrongAt,
      nextReviewAt,
      importance,
      lastWrongAt: wrongAt,
      streakBeforeWrong: newStash,
    });
    return;
  }
  await addDoc(collection(db, 'wrongAnswers'), {
    userId,
    shortformId,
    projectId,
    folderId: folderId ?? null,
    title,
    script,
    wrongAt,
    importance,
    correctStreak: 0,
    lastReviewedAt: null,
    nextReviewAt,
  });
}

export async function getWrongAnswers(userId: string): Promise<WrongAnswer[]> {
  const snap = await getDocs(query(collection(db, 'wrongAnswers'), where('userId', '==', userId)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as WrongAnswer))
    .sort((a, b) => b.wrongAt.localeCompare(a.wrongAt));
}

// 오늘 복습할 항목.
// - nextReviewAt <= 지금  → 아직 due
// - 오늘 이미 복습한 항목도 같은 날 동안은 리스트에 유지 (사용자 시각적 확인용)
// - legacy: nextReviewAt 없으면 wrongAt + 1일로 간주
// - 실제로 존재하는 shortform만 남김 (삭제된 shortform을 가리키는 orphan wrongAnswer 제외)
//   → 플레이어가 자동 드롭하는 항목과 화면 카운트 불일치 방지
export async function getDueReviews(userId: string): Promise<WrongAnswer[]> {
  const all = await getWrongAnswers(userId);
  const nowMs = Date.now();
  const todayKey = localDayKey(); // YYYY-MM-DD (로컬/한국 기준)
  const candidates = all.filter((w) => {
    const nextIso = w.nextReviewAt ?? addDaysISO(w.wrongAt, 1);
    if (new Date(nextIso).getTime() <= nowMs) return true;
    if (w.lastReviewedAt && localDayKey(new Date(w.lastReviewedAt)) === todayKey) return true;
    return false;
  });
  if (candidates.length === 0) return [];

  // 실제 존재하는 shortform id만 추려냄 (Firestore in 쿼리 30개 제한 → 배치)
  const sfIds = Array.from(new Set(candidates.map((c) => c.shortformId)));
  const existing = new Set<string>();
  for (let i = 0; i < sfIds.length; i += 30) {
    const batch = sfIds.slice(i, i + 30);
    const snap = await getDocs(
      query(collection(db, 'shortforms'), where(documentId(), 'in', batch))
    );
    snap.docs.forEach((d) => existing.add(d.id));
  }

  return candidates
    .filter((c) => existing.has(c.shortformId))
    .sort((a, b) => {
      // 미완료(오늘 아직 안 본) 우선, 그 안에서 next가 과거인 순
      const aReviewedToday = !!a.lastReviewedAt && localDayKey(new Date(a.lastReviewedAt)) === todayKey;
      const bReviewedToday = !!b.lastReviewedAt && localDayKey(new Date(b.lastReviewedAt)) === todayKey;
      if (aReviewedToday !== bReviewedToday) return aReviewedToday ? 1 : -1;
      const an = a.nextReviewAt ?? addDaysISO(a.wrongAt, 1);
      const bn = b.nextReviewAt ?? addDaysISO(b.wrongAt, 1);
      return an.localeCompare(bn);
    });
}

/**
 * 복습 결과 기록. wasCorrect=true면 streak 증가 후 importance 기반 간격, false면 streak 리셋 후 1일.
 * 단, 같은 날 안에 "틀림 → 맞춤" 흐름이면 streak를 stash에서 복구해 패널티를 면해준다.
 */
async function applyReviewOutcome(id: string, wasCorrect: boolean): Promise<void> {
  const ref = doc(db, 'wrongAnswers', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  const currentStreak =
    (data.correctStreak as number | undefined)
    ?? (data.reviewCount as number | undefined) // legacy fallback
    ?? 0;
  const importance = (data.importance as number | undefined) ?? 5;
  const now = new Date().toISOString();
  const todayKey = localDayKey();
  const lastWrongAt = data.lastWrongAt as string | undefined;
  const stashedStreak = data.streakBeforeWrong as number | undefined;
  const wrongToday = !!(lastWrongAt && localDayKey(new Date(lastWrongAt)) === todayKey);

  if (wasCorrect) {
    // 오늘 안에 틀림 직후 다시 맞춘 경우: streak를 stash 값 + 1로 복구.
    // 그 외엔 평소처럼 현재 streak + 1.
    const baseStreak = wrongToday && stashedStreak !== undefined && stashedStreak !== null
      ? stashedStreak
      : currentStreak;
    const newStreak = baseStreak + 1;
    const interval = nextIntervalDays(newStreak, importance, true);
    await updateDoc(ref, {
      correctStreak: newStreak,
      lastReviewedAt: now,
      nextReviewAt: addDaysISO(now, interval),
      // 회복했으므로 stash 클리어
      lastWrongAt: null,
      streakBeforeWrong: null,
    });
  } else {
    // 틀림: 직전 streak를 stash해서 같은 날 회복 가능하도록 보존.
    // 단, 오늘 이미 stash가 있으면 유지 (원본 streak 보호).
    const newStash = wrongToday && stashedStreak !== undefined && stashedStreak !== null
      ? stashedStreak
      : currentStreak;
    const interval = nextIntervalDays(0, importance, false);
    await updateDoc(ref, {
      correctStreak: 0,
      lastReviewedAt: now,
      nextReviewAt: addDaysISO(now, interval),
      lastWrongAt: now,
      streakBeforeWrong: newStash,
    });
  }
}

/**
 * 복습 완료(맞춤) 처리. 하루 한 번만 카운트 증가.
 * - 오늘 이미 복습한 항목은 무시 (중복 advance 방지)
 */
export async function markReviewed(id: string): Promise<void> {
  const ref = doc(db, 'wrongAnswers', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const todayKey = localDayKey();
  const lastReviewed = snap.data().lastReviewedAt as string | undefined;
  if (lastReviewed && localDayKey(new Date(lastReviewed)) === todayKey) return;
  await applyReviewOutcome(id, true);
}

/**
 * 복습에서 틀림 처리. streak 리셋, 1일 후 재복습. 즉시 반영 (dedup 없음).
 */
export async function markReviewedWrong(id: string): Promise<void> {
  await applyReviewOutcome(id, false);
}

export async function deleteWrongAnswer(id: string): Promise<void> {
  await deleteDoc(doc(db, 'wrongAnswers', id));
}

export async function deleteWrongAnswersByShortformIds(shortformIds: string[]): Promise<void> {
  if (shortformIds.length === 0) return;
  // Firestore `in` 쿼리는 최대 30개 → 청크 단위로 나눠서 처리
  for (let i = 0; i < shortformIds.length; i += 30) {
    const chunk = shortformIds.slice(i, i + 30);
    const snap = await getDocs(
      query(collection(db, 'wrongAnswers'), where('shortformId', 'in', chunk))
    );
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  }
}

export async function markAsGenerated(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => updateDoc(doc(db, 'wrongAnswers', id), { hasSimilarGenerated: true })));
}
