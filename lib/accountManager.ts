// 계정 관리: Firebase Auth + 사용자 데이터 일괄 삭제.
// Firebase는 비밀번호/이메일 변경, 계정 삭제 시 "최근 인증" 요구 → 현재 비밀번호로 재인증 먼저 수행.
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword as fbUpdatePassword,
  updateEmail as fbUpdateEmail,
  deleteUser as fbDeleteUser,
  User,
} from 'firebase/auth';
import { collection, deleteDoc, doc, getDocs, query, where, writeBatch } from 'firebase/firestore';
import { db } from './firebase';

// Firestore writeBatch 1회 최대 op 수
const BATCH_SIZE = 500;

async function reauth(user: User, currentPassword: string): Promise<void> {
  if (!user.email) throw new Error('이메일 정보가 없어 재인증할 수 없습니다');
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
}

function mapAuthError(e: any): string {
  const code = e?.code ?? '';
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') return '현재 비밀번호가 올바르지 않습니다';
  if (code === 'auth/email-already-in-use') return '이미 사용 중인 이메일입니다';
  if (code === 'auth/invalid-email') return '이메일 형식이 올바르지 않습니다';
  if (code === 'auth/weak-password') return '비밀번호는 6자 이상이어야 합니다';
  if (code === 'auth/requires-recent-login') return '보안을 위해 로그아웃 후 다시 로그인하고 시도해주세요';
  if (code === 'auth/too-many-requests') return '시도가 너무 많습니다. 잠시 후 다시 시도해주세요';
  return e?.message ?? '알 수 없는 오류';
}

export async function changePassword(
  user: User,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < 6) throw new Error('비밀번호는 6자 이상이어야 합니다');
  try {
    await reauth(user, currentPassword);
    await fbUpdatePassword(user, newPassword);
  } catch (e: any) {
    throw new Error(mapAuthError(e));
  }
}

export async function changeEmail(
  user: User,
  currentPassword: string,
  newEmail: string,
): Promise<void> {
  const trimmed = newEmail.trim();
  if (!trimmed) throw new Error('이메일을 입력해주세요');
  try {
    await reauth(user, currentPassword);
    await fbUpdateEmail(user, trimmed);
  } catch (e: any) {
    throw new Error(mapAuthError(e));
  }
}

// 한 컬렉션에서 userId==uid 인 모든 doc 삭제, writeBatch(최대 500개)로 묶어 병렬 commit.
// 순차 deleteDoc 한 건씩 await 했을 때 발생한 문제(548 shortform = 1~3분 + 토큰 만료) 해결.
async function deleteUserDocsInCollection(uid: string, col: string): Promise<number> {
  const snap = await getDocs(query(collection(db, col), where('userId', '==', uid)));
  if (snap.empty) return 0;
  const docs = snap.docs;
  const commits: Promise<void>[] = [];
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    for (const d of docs.slice(i, i + BATCH_SIZE)) batch.delete(d.ref);
    commits.push(batch.commit());
  }
  await Promise.all(commits);
  return docs.length;
}

// 사용자의 모든 컬렉션 데이터 삭제 → 마지막에 Auth 계정 삭제.
//
// 삭제 순서/구조 주의:
//   1. reauth (현재 비번 재인증): 만료된 토큰 갱신, 다음 Auth ops 권한 확보.
//   2. 모든 userId 기반 컬렉션을 **병렬로** 일괄 삭제 (각 컬렉션 내부도 batch 500개 단위).
//      순차 처리하면 548 shortforms × 200ms = ~2분 → 토큰 만료 + 사용자 인지 freeze.
//   3. 단일 doc (id=uid) 컬렉션: userStats, userMeta.
//   4. fbDeleteUser: Auth 계정 자체 삭제. 이후 onAuthStateChanged(null) → 자동 로그아웃 + login 리다이렉트.
export async function deleteAccount(user: User, currentPassword: string): Promise<void> {
  try {
    await reauth(user, currentPassword);
  } catch (e: any) {
    throw new Error(mapAuthError(e));
  }

  const uid = user.uid;
  const userIdCollections = [
    'folders', 'projects', 'shortforms',
    'wrongAnswers', 'studyNotes',
    'studyTime',
  ];

  await Promise.all(
    userIdCollections.map((col) => deleteUserDocsInCollection(uid, col).catch(() => 0)),
  );

  // 단일 doc 컬렉션 (id == uid), 병렬.
  await Promise.all([
    deleteDoc(doc(db, 'userStats', uid)).catch(() => {}),
    deleteDoc(doc(db, 'userMeta', uid)).catch(() => {}),
  ]);

  try {
    await fbDeleteUser(user);
  } catch (e: any) {
    throw new Error(mapAuthError(e));
  }
}
