import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';

export interface StreakData {
  currentStreak: number;
  longestStreak: number;
  lastStudyDate: string | null;
  totalStudyDays: number;
  studyDates: string[];
}

const EMPTY: StreakData = {
  currentStreak: 0,
  longestStreak: 0,
  lastStudyDate: null,
  totalStudyDays: 0,
  studyDates: [],
};

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr() { return toDateStr(new Date()); }
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toDateStr(d);
}

// 숫자 필드는 NaN/Infinity/문자열 등 비정상 값을 0으로 정규화.
// 과거 마이그레이션/버그로 corrupted 값이 들어간 경우 UI(StatCard 등)에서 NaN 렌더 방지.
function safeNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export async function getStreakData(userId: string): Promise<StreakData> {
  const snap = await getDoc(doc(db, 'userStats', userId));
  if (!snap.exists()) return { ...EMPTY };
  const data = snap.data() as Partial<StreakData>;
  return {
    currentStreak: safeNum(data.currentStreak),
    longestStreak: safeNum(data.longestStreak),
    lastStudyDate: data.lastStudyDate ?? null,
    totalStudyDays: safeNum(data.totalStudyDays),
    studyDates: data.studyDates ?? [],
  };
}

export interface StudySessionResult {
  data: StreakData;
  isNewSession: boolean; // 오늘 첫 번째 학습인지 여부 (마일스톤 표시 조건)
}

export async function recordStudySession(userId: string): Promise<StudySessionResult> {
  const ref = doc(db, 'userStats', userId);
  const snap = await getDoc(ref);
  const data: StreakData = snap.exists() ? (snap.data() as StreakData) : { ...EMPTY };

  const today = todayStr();

  // 오늘 이미 학습했으면 스킵 (마일스톤 재표시 방지)
  if (data.lastStudyDate === today) {
    const dates = data.studyDates ?? [];
    if (!dates.includes(today)) {
      const patched: StreakData = { ...data, studyDates: [...dates, today] };
      // merge: 같은 userStats 문서의 totalXP/lastXpDate(레벨 시스템) 보존
      await setDoc(ref, patched, { merge: true });
      return { data: patched, isNewSession: false };
    }
    return { data, isNewSession: false };
  }

  const newStreak = data.lastStudyDate === yesterdayStr() ? data.currentStreak + 1 : 1;

  const updated: StreakData = {
    currentStreak: newStreak,
    longestStreak: Math.max(newStreak, data.longestStreak),
    lastStudyDate: today,
    totalStudyDays: data.totalStudyDays + 1,
    studyDates: [...(data.studyDates ?? []), today],
  };

  // merge: 같은 userStats 문서의 totalXP/lastXpDate(레벨 시스템) 보존
  await setDoc(ref, updated, { merge: true });
  return { data: updated, isNewSession: true };
}

export function getMotivationalMessage(streak: number): string {
  if (streak === 0) return '오늘 첫 학습을 시작해보세요!';
  if (streak === 1) return '시작이 반이에요! 내일도 함께해요 💪';
  if (streak < 4) return '좋은 습관이 만들어지고 있어요 ✨';
  if (streak < 7) return '어느새 며칠째! 포기하지 마요 🎯';
  if (streak === 7) return '일주일 달성! 대단해요 🎉';
  if (streak < 14) return '2주가 눈앞이에요! 계속해요 🚀';
  if (streak === 14) return '2주 연속 달성! 진짜 대단해요 👑';
  if (streak < 30) return '한 달이 다가오고 있어요! 거의 다 왔어요 🏆';
  if (streak >= 30) return '한 달 이상! 당신은 학습의 신 🔥';
  return '계속 공부해요!';
}

export function getMilestoneInfo(streak: number): { isNew: boolean; label: string } | null {
  const milestones: Record<number, string> = {
    1: '🌱 첫 학습',
    3: '🌿 3일 연속',
    7: '🎯 일주일',
    14: '👑 2주 연속',
    30: '🏆 30일 달성',
    60: '💎 60일 달성',
    100: '🔥 100일 달성',
  };
  if (milestones[streak]) return { isNew: true, label: milestones[streak] };
  return null;
}
