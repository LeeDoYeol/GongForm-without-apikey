import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where, increment } from 'firebase/firestore';
import { db } from './firebase';

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todayDateStr(): string {
  return toDateStr(new Date());
}

export async function addStudySeconds(userId: string, seconds: number): Promise<void> {
  if (seconds < 1) return;
  const date = todayDateStr();
  const ref = doc(db, 'studyTime', `${userId}_${date}`);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { seconds: increment(seconds) });
  } else {
    await setDoc(ref, { userId, date, seconds });
  }
}

export async function getStudyTimeMap(userId: string): Promise<Record<string, number>> {
  const q = query(collection(db, 'studyTime'), where('userId', '==', userId));
  const snap = await getDocs(q);
  const map: Record<string, number> = {};
  snap.docs.forEach((d) => {
    const data = d.data() as { date: string; seconds: number };
    map[data.date] = (map[data.date] ?? 0) + data.seconds;
  });
  return map;
}

export function formatStudyTime(seconds: number): string {
  if (seconds < 60) return `${seconds}초`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}분 ${s}초` : `${m}분`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}시간 ${rm}분` : `${h}시간`;
}
