// 복습 세션: 오늘의 남은 복습 큐를 AsyncStorage에 저장.
// 홈에서 복습 시작 시 큐 저장 → 플레이어가 카드 볼 때마다 큐에서 제거 →
// 다시 홈 진입 시 큐에 남은 게 있으면 그대로 이어서 시작.
//
// Firestore의 lastReviewedAt/nextReviewAt만으로는 "오늘 본 항목 vs 안 본 항목" 판단이
// 부정확해질 수 있어 (간격 계산 미스/캐시 등) → 별도 큐로 명확한 source of truth 유지.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@gongform/reviewSession/v1';

export interface ReviewSession {
  date: string; // YYYY-MM-DD — 오늘 날짜 외엔 만료로 간주
  // 병렬 배열, i번째는 같은 카드
  shortformIds: string[];
  reviewDocIds: string[];
  projectIds: string[];
}

// 로컬(=한국) 자정 기준 YYYY-MM-DD.
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function loadReviewSession(): Promise<ReviewSession | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReviewSession;
    if (parsed.date !== todayKey()) return null; // 어제 세션 → 무효
    if (!Array.isArray(parsed.shortformIds) || parsed.shortformIds.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveReviewSession(session: Omit<ReviewSession, 'date'>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ ...session, date: todayKey() }));
  } catch {}
}

export async function removeFromReviewSession(shortformId: string): Promise<void> {
  try {
    const cur = await loadReviewSession();
    if (!cur) return;
    const idx = cur.shortformIds.indexOf(shortformId);
    if (idx < 0) return;
    cur.shortformIds.splice(idx, 1);
    cur.reviewDocIds.splice(idx, 1);
    cur.projectIds.splice(idx, 1);
    if (cur.shortformIds.length === 0) {
      await AsyncStorage.removeItem(KEY);
    } else {
      await AsyncStorage.setItem(KEY, JSON.stringify(cur));
    }
  } catch {}
}

export async function clearReviewSession(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch {}
}
