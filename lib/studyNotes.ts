import { collection, addDoc, getDocs, deleteDoc, doc, updateDoc, query, where } from 'firebase/firestore';
import { db } from './firebase';

export type StudyNoteType = 'concept' | 'quiz' | 'example';

export interface StudyNote {
  id: string;
  userId: string;
  shortformId: string;
  projectId: string;
  folderId?: string | null; // 선택적 (그룹용)
  type?: StudyNoteType; // 원본 shortform의 타입 (구 데이터는 없을 수 있음)
  title: string;
  script: string;
  savedAt: string;
  hasSimilarGenerated?: boolean;
}

export async function saveStudyNote(
  userId: string,
  shortformId: string,
  projectId: string,
  title: string,
  script: string,
  folderId: string | null = null,
  type: StudyNoteType = 'concept',
): Promise<void> {
  const existing = await getDocs(
    query(collection(db, 'studyNotes'), where('userId', '==', userId), where('shortformId', '==', shortformId))
  );
  if (!existing.empty) return;
  await addDoc(collection(db, 'studyNotes'), {
    userId,
    shortformId,
    projectId,
    folderId: folderId ?? null,
    type,
    title,
    script,
    savedAt: new Date().toISOString(),
  });
}

export async function getStudyNotes(userId: string): Promise<StudyNote[]> {
  const snap = await getDocs(query(collection(db, 'studyNotes'), where('userId', '==', userId)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as StudyNote))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function deleteStudyNote(id: string): Promise<void> {
  await deleteDoc(doc(db, 'studyNotes', id));
}

export async function deleteStudyNotesByShortformIds(shortformIds: string[]): Promise<void> {
  if (shortformIds.length === 0) return;
  // Firestore `in` 쿼리는 최대 30개 → 청크 단위로 나눠서 처리
  for (let i = 0; i < shortformIds.length; i += 30) {
    const chunk = shortformIds.slice(i, i + 30);
    const snap = await getDocs(
      query(collection(db, 'studyNotes'), where('shortformId', 'in', chunk))
    );
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  }
}

export async function markStudyNoteAsGenerated(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => updateDoc(doc(db, 'studyNotes', id), { hasSimilarGenerated: true })));
}
