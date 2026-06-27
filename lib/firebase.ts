import { initializeApp, getApps, getApp } from 'firebase/app';
import { initializeAuth, getAuth, browserLocalPersistence, indexedDBLocalPersistence } from 'firebase/auth';
// @ts-expect-error - getReactNativePersistence는 firebase/auth 타입에 노출 안 됨 (런타임 export O)
import { getReactNativePersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const firebaseConfig = {
  apiKey: "여기 API 키 입력",
  authDomain: "여기 authDomain 입력",
  projectId: "여기 projectId 입력",
  storageBucket: "여기 storageBucket 입력",
  messagingSenderId: "여기 messagingSenderId 입력",
  appId: "여기 appId 입력",
  measurementId: "여기 measurementId 입력"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const auth = (() => {
  try {
    // 웹: IndexedDB → localStorage fallback (브라우저 새로고침/탭 닫기 후에도 유지)
    // 네이티브: AsyncStorage (앱 재시작 후에도 유지)
    const persistence = Platform.OS === 'web'
      ? [indexedDBLocalPersistence, browserLocalPersistence]
      : getReactNativePersistence(AsyncStorage);
    return initializeAuth(app, { persistence });
  } catch {
    // 핫리로드로 이미 초기화된 경우 기존 인스턴스 재사용
    return getAuth(app);
  }
})();

export const db = getFirestore(app);
export const storage = getStorage(app);
