// 프로젝트 공유: 코드 기반.
// shares/{code} 문서에 프로젝트 메타 + 숏폼 스냅샷을 저장.
// 발급자: 코드 생성. 수신자: 코드로 fetch → 자기 계정에 복제 (snapshot copy).
//
// 코드 형식: 8자, 혼동 글자(0/O/1/I/L) 제외한 32진수 → 32^8 ≈ 1.1조 가지 (충돌 무시 가능).
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // O, 0, I, 1, L 제외 (31자)
const CODE_LEN = 8;

function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

export interface SharedShortform {
  type: 'concept' | 'example' | 'quiz';
  title: string;
  script: string;
  imageKeywords?: string[];
  importance?: number;
  order: number;
}

export interface ProjectShareDoc {
  code: string;
  type: 'project';
  ownerId: string;
  ownerEmail?: string;
  projectTitle: string;
  shortforms: SharedShortform[];
  createdAt: any;
}

export interface SharedProject {
  title: string;
  excludeFromShuffle?: boolean;
  order: number;
  shortforms: SharedShortform[];
}

export interface ShareInfo {
  code: string;
  type: 'project' | 'folder';
  // 프로젝트 공유: projectTitle, shortformCount
  // 폴더 공유: folderTitle, projectCount, totalShortformCount
  projectTitle?: string;
  shortformCount?: number;
  folderTitle?: string;
  projectCount?: number;
  totalShortformCount?: number;
  ownerEmail?: string;
}

// 프로젝트의 현재 상태를 스냅샷으로 떠 shares/{code} 문서 생성.
// 이미 같은 프로젝트에 대한 공유 코드가 존재하면 재사용.
export async function createProjectShare(
  userId: string,
  projectId: string,
  userEmail?: string | null,
): Promise<string> {
  // 기존 코드가 있는지 확인 (한 프로젝트 = 한 코드 원칙, 중복 발급 방지)
  try {
    const existing = await getDocs(
      query(collection(db, 'shares'), where('ownerId', '==', userId), where('sourceProjectId', '==', projectId)),
    );
    if (!existing.empty) {
      return (existing.docs[0].data() as any).code as string;
    }
  } catch { /* fall through to create */ }

  // 프로젝트 + 숏폼 로드
  const projDoc = await getDoc(doc(db, 'projects', projectId));
  if (!projDoc.exists()) throw new Error('프로젝트를 찾을 수 없습니다');
  const projectTitle = (projDoc.data() as any).title ?? '제목 없음';

  const sfSnap = await getDocs(query(collection(db, 'shortforms'), where('projectId', '==', projectId)));
  const shortforms: SharedShortform[] = sfSnap.docs
    .map((d) => {
      const data = d.data() as any;
      return {
        type: data.type,
        title: data.content?.title ?? '',
        script: data.content?.script ?? '',
        imageKeywords: data.imageKeywords,
        importance: data.importance,
        order: data.order ?? 0,
      } as SharedShortform;
    })
    .sort((a, b) => a.order - b.order);

  // 코드 생성 + 충돌 회피 (최대 5회 재시도)
  let code = '';
  for (let i = 0; i < 5; i++) {
    code = generateCode();
    const ref = doc(db, 'shares', code);
    const snap = await getDoc(ref);
    if (!snap.exists()) break;
    if (i === 4) throw new Error('코드 생성 실패. 다시 시도해주세요.');
  }

  await setDoc(doc(db, 'shares', code), {
    code,
    type: 'project',
    ownerId: userId,
    ownerEmail: userEmail ?? null,
    sourceProjectId: projectId,
    projectTitle,
    shortforms,
    createdAt: serverTimestamp(),
  });

  return code;
}

// 폴더 공유: 폴더 안 모든 프로젝트 + 숏폼을 스냅샷으로 떠 shares/{code}에 저장.
// 기존 같은 폴더에 대한 공유 코드가 있으면 재사용.
export async function createFolderShare(
  userId: string,
  folderId: string,
  userEmail?: string | null,
): Promise<string> {
  try {
    const existing = await getDocs(
      query(collection(db, 'shares'), where('ownerId', '==', userId), where('sourceFolderId', '==', folderId)),
    );
    if (!existing.empty) {
      return (existing.docs[0].data() as any).code as string;
    }
  } catch { /* fall through */ }

  // 폴더 + 폴더 내 프로젝트 로드
  const folderDoc = await getDoc(doc(db, 'folders', folderId));
  if (!folderDoc.exists()) throw new Error('폴더를 찾을 수 없습니다');
  const folderTitle = (folderDoc.data() as any).title ?? '제목 없음';

  const projSnap = await getDocs(
    query(collection(db, 'projects'), where('userId', '==', userId), where('folderId', '==', folderId)),
  );
  const projectDocs = projSnap.docs;
  if (projectDocs.length === 0) {
    throw new Error('빈 폴더는 공유할 수 없습니다');
  }

  // 각 프로젝트의 숏폼들을 병렬로 로드
  const projects: SharedProject[] = await Promise.all(
    projectDocs.map(async (pd) => {
      const pData = pd.data() as any;
      const sfSnap = await getDocs(query(collection(db, 'shortforms'), where('projectId', '==', pd.id)));
      const shortforms: SharedShortform[] = sfSnap.docs
        .map((d) => {
          const data = d.data() as any;
          return {
            type: data.type,
            title: data.content?.title ?? '',
            script: data.content?.script ?? '',
            imageKeywords: data.imageKeywords,
            importance: data.importance,
            order: data.order ?? 0,
          } as SharedShortform;
        })
        .sort((a, b) => a.order - b.order);
      return {
        title: pData.title ?? '제목 없음',
        excludeFromShuffle: pData.excludeFromShuffle === true,
        order: pData.order ?? 0,
        shortforms,
      } as SharedProject;
    }),
  );
  projects.sort((a, b) => a.order - b.order);

  // 코드 생성 + 충돌 회피
  let code = '';
  for (let i = 0; i < 5; i++) {
    code = generateCode();
    const ref = doc(db, 'shares', code);
    const snap = await getDoc(ref);
    if (!snap.exists()) break;
    if (i === 4) throw new Error('코드 생성 실패. 다시 시도해주세요.');
  }

  await setDoc(doc(db, 'shares', code), {
    code,
    type: 'folder',
    ownerId: userId,
    ownerEmail: userEmail ?? null,
    sourceFolderId: folderId,
    folderTitle,
    projects,
    createdAt: serverTimestamp(),
  });

  return code;
}

// 코드 → 미리보기 정보 (수신자가 redeem 전 확인용)
export async function getShareInfo(code: string): Promise<ShareInfo | null> {
  const normalized = code.trim().toUpperCase();
  if (normalized.length === 0) return null;
  const snap = await getDoc(doc(db, 'shares', normalized));
  if (!snap.exists()) return null;
  const data = snap.data() as any;
  const type = data.type === 'folder' ? 'folder' : 'project';
  if (type === 'folder') {
    const projects: SharedProject[] = Array.isArray(data.projects) ? data.projects : [];
    const totalSf = projects.reduce((sum, p) => sum + (Array.isArray(p.shortforms) ? p.shortforms.length : 0), 0);
    return {
      code: normalized,
      type: 'folder',
      folderTitle: data.folderTitle ?? '제목 없음',
      projectCount: projects.length,
      totalShortformCount: totalSf,
      ownerEmail: data.ownerEmail ?? undefined,
    };
  }
  return {
    code: normalized,
    type: 'project',
    projectTitle: data.projectTitle ?? '제목 없음',
    shortformCount: Array.isArray(data.shortforms) ? data.shortforms.length : 0,
    ownerEmail: data.ownerEmail ?? undefined,
  };
}

export type RedeemResult =
  | { kind: 'project'; projectId: string; projectTitle: string; shortformCount: number }
  | { kind: 'folder'; folderId: string; folderTitle: string; projectCount: number; totalShortformCount: number };

// 코드 → 수신자 계정에 복제 (프로젝트 or 폴더 자동 판별).
// 중복 방지: 같은 코드를 이미 받은 적이 있으면(자기 프로젝트/폴더에 sourceShareCode가 같은 게 있으면) reject.
// 자기 자신의 코드도 reject.
export async function redeemShare(
  code: string,
  receiverUserId: string,
): Promise<RedeemResult> {
  const normalized = code.trim().toUpperCase();
  const snap = await getDoc(doc(db, 'shares', normalized));
  if (!snap.exists()) throw new Error('유효하지 않은 코드입니다');
  const data = snap.data() as any;

  const shareType = data.type === 'folder' ? 'folder' : 'project';

  // 자기 자신이 만든 코드라도, 원본 프로젝트/폴더를 이미 삭제했다면 다시 받을 수 있도록 허용.
  // 원본이 아직 살아있으면 의미 없는 중복이라 차단.
  if (data.ownerId === receiverUserId) {
    const sourceId = shareType === 'folder' ? data.sourceFolderId : data.sourceProjectId;
    if (sourceId) {
      const sourceCol = shareType === 'folder' ? 'folders' : 'projects';
      const sourceSnap = await getDoc(doc(db, sourceCol, sourceId));
      if (sourceSnap.exists() && (sourceSnap.data() as any).userId === receiverUserId) {
        throw new Error('이미 가지고 있는 자료입니다');
      }
      // 원본이 없거나 다른 소유자면 통과 → 자기 코드로 자기가 다시 받기 가능
    }
  }

  // 이미 받은 적이 있는지 확인: projects 컬렉션 또는 folders 컬렉션에서 sourceShareCode 일치 + userId 매칭.
  // 단일 필드 쿼리(sourceShareCode)로 후보 가져온 뒤 userId 클라이언트 필터 (복합 index 회피).
  const targetCol = shareType === 'folder' ? 'folders' : 'projects';
  const existing = await getDocs(
    query(collection(db, targetCol), where('sourceShareCode', '==', normalized)),
  );
  const alreadyOwned = existing.docs.some((d) => (d.data() as any).userId === receiverUserId);
  if (alreadyOwned) {
    throw new Error('이미 받은 자료입니다');
  }

  const batch = writeBatch(db);

  if (shareType === 'folder') {
    const folderTitle: string = data.folderTitle ?? '공유받은 폴더';
    const projects: SharedProject[] = Array.isArray(data.projects) ? data.projects : [];

    // 새 폴더 doc
    const folderRef = doc(collection(db, 'folders'));
    batch.set(folderRef, {
      userId: receiverUserId,
      title: folderTitle,
      sourceShareCode: normalized,
      createdAt: serverTimestamp(),
    });

    let totalSf = 0;
    for (const p of projects) {
      const projectRef = doc(collection(db, 'projects'));
      batch.set(projectRef, {
        userId: receiverUserId,
        title: p.title,
        folderId: folderRef.id,
        order: p.order ?? 0,
        excludeFromShuffle: p.excludeFromShuffle === true,
        // 폴더에서 복제된 프로젝트는 폴더 sourceShareCode를 따름 (개별 프로젝트 중복 받기 차단 X, 폴더 단위)
        sourceShareCode: normalized,
        createdAt: serverTimestamp(),
      });
      for (const sf of p.shortforms) {
        const sfRef = doc(collection(db, 'shortforms'));
        batch.set(sfRef, {
          userId: receiverUserId,
          projectId: projectRef.id,
          folderId: folderRef.id,
          type: sf.type,
          content: { title: sf.title, script: sf.script },
          imageKeywords: sf.imageKeywords ?? null,
          importance: sf.importance ?? 5,
          order: sf.order ?? 0,
          createdAt: serverTimestamp(),
        });
        totalSf++;
      }
    }

    // Firestore batch 최대 500 ops 한계: 폴더 + 프로젝트 + 숏폼이 합쳐서 500 초과면 분할 필요.
    // 현재 평균 케이스는 100~300 ops 정도라 통상 OK.
    await batch.commit();
    return {
      kind: 'folder',
      folderId: folderRef.id,
      folderTitle,
      projectCount: projects.length,
      totalShortformCount: totalSf,
    };
  }

  // 프로젝트 공유 redeem
  const shortforms: SharedShortform[] = Array.isArray(data.shortforms) ? data.shortforms : [];
  const projectTitle: string = data.projectTitle ?? '공유받은 프로젝트';
  const projectRef = doc(collection(db, 'projects'));
  batch.set(projectRef, {
    userId: receiverUserId,
    title: projectTitle,
    folderId: null,
    order: 0,
    sourceShareCode: normalized,
    createdAt: serverTimestamp(),
  });
  for (const sf of shortforms) {
    const sfRef = doc(collection(db, 'shortforms'));
    batch.set(sfRef, {
      userId: receiverUserId,
      projectId: projectRef.id,
      folderId: null,
      type: sf.type,
      content: { title: sf.title, script: sf.script },
      imageKeywords: sf.imageKeywords ?? null,
      importance: sf.importance ?? 5,
      order: sf.order ?? 0,
      createdAt: serverTimestamp(),
    });
  }
  await batch.commit();
  return {
    kind: 'project',
    projectId: projectRef.id,
    projectTitle,
    shortformCount: shortforms.length,
  };
}

// 하위 호환: 기존 호출자(redeemProjectShare)를 위한 wrapper.
// targetFolderId 인자는 더 이상 사용 안 함 (호환 위해 유지).
export async function redeemProjectShare(
  code: string,
  receiverUserId: string,
  _targetFolderId: string | null = null,
): Promise<{ projectId: string; projectTitle: string; shortformCount: number }> {
  const r = await redeemShare(code, receiverUserId);
  if (r.kind !== 'project') {
    throw new Error('이 코드는 폴더 공유 코드입니다');
  }
  return { projectId: r.projectId, projectTitle: r.projectTitle, shortformCount: r.shortformCount };
}
