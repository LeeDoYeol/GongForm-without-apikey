// 학습자 프로필: 첫 설정(B)에서 수집한 관심 과목·학년·하루 목표.
// Firestore: userPrefs/{uid} 문서에 머지 저장 (기존 aiSettings도 같은 문서 사용 → merge:true 필수).
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';

export interface LearnerProfile {
  subjects?: string[];     // 예: ['국어', '수학']
  grade?: string;          // 예: '고1'
  dailyGoal?: number;      // 하루 숏폼 목표 개수
}

export async function getLearnerProfile(userId: string): Promise<LearnerProfile> {
  try {
    const snap = await getDoc(doc(db, 'userPrefs', userId));
    if (!snap.exists()) return {};
    const data = snap.data() as any;
    return {
      subjects: Array.isArray(data.subjects) ? data.subjects : undefined,
      grade: typeof data.grade === 'string' ? data.grade : undefined,
      dailyGoal: typeof data.dailyGoal === 'number' ? data.dailyGoal : undefined,
    };
  } catch {
    return {};
  }
}

export async function saveLearnerProfile(userId: string, patch: LearnerProfile): Promise<void> {
  await setDoc(doc(db, 'userPrefs', userId), patch, { merge: true });
}

// B의 과목·학년 목록, UI에서 재사용.
export const SUBJECTS: { key: string; glyph: string }[] = [
  { key: '국어', glyph: '가' },
  { key: '영어', glyph: 'A' },
  { key: '수학', glyph: 'π' },
  { key: '과학', glyph: '⚗' },
  { key: '사회', glyph: '◎' },
  { key: '한국사', glyph: '史' },
];

export const GRADES: string[] = ['중1', '중2', '중3', '고1', '고2', '고3', '대학생', '기타'];
