// 데이터 모델 v2 마이그레이션
// 기존 (3계층): folder → project → shortform
// 신규 (2계층): project → shortform (folder는 선택적 그룹)
//
// 변경 내용:
// - 모든 shortform이 projectId를 가지도록 보정 (기존 orphan은 폴더명으로 자동 프로젝트 생성)
// - 기존 project는 그대로 top-level로 격상 (folderId는 선택적 그룹 정보로 유지)
// - 기존 folder는 그대로 (선택적 그룹으로 살아남음)
// - userMeta/{userId}.migrated_v2 = true 로 마킹

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';

export async function migrateUserDataV2(userId: string): Promise<void> {
  const metaRef = doc(db, 'userMeta', userId);
  const meta = await getDoc(metaRef);
  if (meta.exists() && meta.data()?.migrated_v2) return;

  // 1. 모든 사용자 자료 조회
  const [sfsSnap, projsSnap, foldersSnap] = await Promise.all([
    getDocs(query(collection(db, 'shortforms'), where('userId', '==', userId))),
    getDocs(query(collection(db, 'projects'), where('userId', '==', userId))),
    getDocs(query(collection(db, 'folders'), where('userId', '==', userId))),
  ]);

  const allSfs = sfsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const projectIds = new Set(projsSnap.docs.map((d) => d.id));
  const folderTitleMap = new Map<string, string>();
  foldersSnap.docs.forEach((d) => folderTitleMap.set(d.id, (d.data() as any).title ?? '폴더'));

  // 2. orphan 숏폼: projectId 없거나 존재하지 않는 프로젝트 참조
  const orphans = allSfs.filter((sf) => !sf.projectId || !projectIds.has(sf.projectId));

  // 3. 폴더별 그룹화 (folderId 없는 것은 '__no_folder__'로)
  const orphansByFolder = new Map<string, any[]>();
  for (const sf of orphans) {
    const fid = sf.folderId ?? '__no_folder__';
    if (!orphansByFolder.has(fid)) orphansByFolder.set(fid, []);
    orphansByFolder.get(fid)!.push(sf);
  }

  // 4. 각 폴더의 orphan 숏폼들을 위해 자동 프로젝트 생성
  for (const [folderId, sfs] of orphansByFolder.entries()) {
    const realFolderId = folderId === '__no_folder__' ? null : folderId;
    const title =
      realFolderId && folderTitleMap.has(realFolderId)
        ? folderTitleMap.get(realFolderId)!
        : '기본 자료';

    const projRef = await addDoc(collection(db, 'projects'), {
      folderId: realFolderId,
      userId,
      title,
      order: 0,
      createdAt: serverTimestamp(),
    });

    await Promise.all(
      sfs.map((sf) =>
        updateDoc(doc(db, 'shortforms', sf.id), {
          projectId: projRef.id,
        })
      )
    );
  }

  // 5. 마이그레이션 완료 마킹
  await setDoc(metaRef, { migrated_v2: true, migratedAt: serverTimestamp() }, { merge: true });
}
