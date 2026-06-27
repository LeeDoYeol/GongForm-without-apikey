// 일일 학습 활동 카운터: 타입별 (개념·예시·OX·오답) 학습 횟수 집계.
// Firestore: dailyActivity/{uid_YYYY-MM-DD} { concept, example, quiz, wrong, updatedAt }
import { doc, getDoc, increment, setDoc } from 'firebase/firestore';
import { db, auth } from './firebase';

export type ActivityKind = 'concept' | 'example' | 'quiz' | 'wrong';

export interface DailyActivity {
  concept: number;
  example: number;
  quiz: number;
  wrong: number;
}

const EMPTY: DailyActivity = { concept: 0, example: 0, quiz: 0, wrong: 0 };

// 로컬(=한국) 자정 기준 YYYY-MM-DD. UTC를 쓰면 한국에서 오전 9시에 하루가 바뀜.
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const docId = (uid: string) => `${uid}_${todayKey()}`;

const listeners = new Set<(d: DailyActivity) => void>();
let cachedToday: { date: string; data: DailyActivity } | null = null;

export function subscribeDailyActivity(cb: (d: DailyActivity) => void): () => void {
  listeners.add(cb);
  if (cachedToday?.date === todayKey()) cb(cachedToday.data);
  return () => { listeners.delete(cb); };
}

function notify(d: DailyActivity): void {
  cachedToday = { date: todayKey(), data: d };
  for (const l of listeners) {
    try { l(d); } catch {}
  }
}

/** 활동 1회 카운트 (fire-and-forget) */
export function recordActivity(kind: ActivityKind): void {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const id = docId(uid);
  const ref = doc(db, 'dailyActivity', id);
  // 옵티미스틱 캐시 업데이트 (UI 즉시 반영)
  const cur = cachedToday?.date === todayKey() ? cachedToday.data : { ...EMPTY };
  const next = { ...cur, [kind]: cur[kind] + 1 };
  notify(next);
  // Firestore 증가
  setDoc(
    ref,
    {
      userId: uid,
      date: todayKey(),
      [kind]: increment(1),
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  ).catch(() => {});
}

// 지난 N일 활동 (오늘 포함): 가장 최근 날짜부터 내림차순으로 N개 반환.
// 키 형식 YYYY-MM-DD로 정확히 매칭. 없는 날은 EMPTY로 채움.
export async function getRecentActivity(
  userId: string,
  days: number,
): Promise<Array<{ date: string; activity: DailyActivity }>> {
  const dates: string[] = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    // 로컬(=한국) 기준 dayKey, todayKey()와 동일 포맷이어야 docId 매칭됨
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const results = await Promise.all(
    dates.map(async (date) => {
      try {
        const snap = await getDoc(doc(db, 'dailyActivity', `${userId}_${date}`));
        if (!snap.exists()) return { date, activity: { ...EMPTY } };
        const data = snap.data() as any;
        return {
          date,
          activity: {
            concept: data.concept ?? 0,
            example: data.example ?? 0,
            quiz: data.quiz ?? 0,
            wrong: data.wrong ?? 0,
          },
        };
      } catch {
        return { date, activity: { ...EMPTY } };
      }
    }),
  );
  return results;
}

/** 특정 날짜 활동 조회 (캘린더 선택용) */
export async function getActivityForDate(userId: string, date: string): Promise<DailyActivity> {
  try {
    const snap = await getDoc(doc(db, 'dailyActivity', `${userId}_${date}`));
    if (!snap.exists()) return { ...EMPTY };
    const data = snap.data() as any;
    return {
      concept: data.concept ?? 0,
      example: data.example ?? 0,
      quiz: data.quiz ?? 0,
      wrong: data.wrong ?? 0,
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function getTodayActivity(userId: string): Promise<DailyActivity> {
  try {
    const snap = await getDoc(doc(db, 'dailyActivity', `${userId}_${todayKey()}`));
    if (!snap.exists()) {
      const data = { ...EMPTY };
      notify(data);
      return data;
    }
    const data = snap.data() as any;
    const result: DailyActivity = {
      concept: data.concept ?? 0,
      example: data.example ?? 0,
      quiz: data.quiz ?? 0,
      wrong: data.wrong ?? 0,
    };
    notify(result);
    return result;
  } catch {
    return { ...EMPTY };
  }
}
