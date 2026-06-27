// 사용자 AI 설정: OpenRouter API 키 + "빠른 모드" 토글.
// 키 등록 안 한 사용자는 공용 키를 쓰되 강제로 느린 모드 (직렬 처리)로 제한.
// 키 등록한 사용자는 자기 키 + 빠른 모드 토글로 병렬 사용 가능.
//
// 저장 전략:
// - 진실의 원천 = Firestore (userPrefs/{uid}): 기기/브라우저 바뀌어도 유지
// - AsyncStorage = 로컬 캐시: 오프라인/즉시 sync 접근용
// 로그인하면 Firestore에서 끌어와 캐시 동기화. 변경 시 둘 다에 기록.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db, auth } from './firebase';

const KEY_API = '@gongform/openrouterKey';
const KEY_FAST = '@gongform/fastMode';
const KEY_PROVIDER = '@gongform/aiProvider';

export type AiProvider = 'openrouter' | 'cerebras' | 'openai';

let cachedKey: string | null = null;
let cachedFast = false;
let cachedProvider: AiProvider = 'openrouter';

function normalizeProvider(v: any): AiProvider {
  if (v === 'cerebras') return 'cerebras';
  if (v === 'openai') return 'openai';
  return 'openrouter';
}
let loaded = false;
let loadingPromise: Promise<void> | null = null;
const changeListeners = new Set<() => void>();

function notify(): void {
  for (const l of changeListeners) {
    try { l(); } catch {}
  }
}

export function subscribeSettings(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
}

async function loadFromStorage(): Promise<void> {
  // 먼저 로컬 캐시에서 즉시 가져옴: 첫 렌더 깜빡임 방지.
  try {
    cachedKey = await AsyncStorage.getItem(KEY_API);
    const fast = await AsyncStorage.getItem(KEY_FAST);
    cachedFast = fast === '1';
    const prov = await AsyncStorage.getItem(KEY_PROVIDER);
    cachedProvider = normalizeProvider(prov);
  } catch {}
  loaded = true;
  // 그 다음 Firestore에서 최신 값을 가져와 캐시 갱신 (로그인된 경우).
  // 백그라운드로, UI는 일단 로컬 값으로 그림.
  syncFromFirestore().catch(() => {});
}

/**
 * Firestore의 사용자 설정에서 키/패스트모드를 가져와 캐시/AsyncStorage에 반영.
 * 양방향 동기화:
 *  - 원격 → 로컬: 원격에 필드가 "명시적으로" 있을 때만 (undefined를 null로 잘못 해석해서 로컬을 덮어쓰지 않게)
 *  - 로컬 → 원격: 로컬 캐시에 키가 있는데 원격엔 필드가 없으면 클라우드로 백업 push
 */
async function syncFromFirestore(): Promise<void> {
  const u = auth.currentUser;
  if (!u) return;
  try {
    const snap = await getDoc(doc(db, 'userPrefs', u.uid));
    const data: any = snap.exists() ? snap.data() : null;

    let changed = false;
    // 키 동기화
    const remoteHasKey = data && Object.prototype.hasOwnProperty.call(data, 'openrouterKey');
    if (remoteHasKey) {
      const remoteKey = (data.openrouterKey as string | undefined) ?? null;
      if (remoteKey !== cachedKey) {
        cachedKey = remoteKey;
        try {
          if (remoteKey) await AsyncStorage.setItem(KEY_API, remoteKey);
          else await AsyncStorage.removeItem(KEY_API);
        } catch {}
        changed = true;
      }
    } else if (cachedKey) {
      // 원격에 키 필드가 없는데 로컬은 있으면, 클라우드로 백업 push (회복 메커니즘)
      try {
        await setDoc(doc(db, 'userPrefs', u.uid), { openrouterKey: cachedKey }, { merge: true });
      } catch { /* noop — Firestore 규칙 막혀있으면 무시. 로컬은 그대로 유지 */ }
    }

    // 빠른 모드 동기화: 동일 패턴
    const remoteHasFast = data && Object.prototype.hasOwnProperty.call(data, 'fastMode');
    if (remoteHasFast) {
      const remoteFast = !!data.fastMode;
      if (remoteFast !== cachedFast) {
        cachedFast = remoteFast;
        try { await AsyncStorage.setItem(KEY_FAST, remoteFast ? '1' : '0'); } catch {}
        changed = true;
      }
    } else if (cachedFast) {
      try {
        await setDoc(doc(db, 'userPrefs', u.uid), { fastMode: cachedFast }, { merge: true });
      } catch {}
    }

    // AI provider 동기화
    const remoteHasProvider = data && Object.prototype.hasOwnProperty.call(data, 'aiProvider');
    if (remoteHasProvider) {
      const remoteProv: AiProvider = normalizeProvider(data.aiProvider);
      if (remoteProv !== cachedProvider) {
        cachedProvider = remoteProv;
        try { await AsyncStorage.setItem(KEY_PROVIDER, remoteProv); } catch {}
        changed = true;
      }
    } else if (cachedProvider !== 'openrouter') {
      try {
        await setDoc(doc(db, 'userPrefs', u.uid), { aiProvider: cachedProvider }, { merge: true });
      } catch {}
    }

    if (changed) notify();
  } catch {}
}

export function ensureSettingsLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loadingPromise) loadingPromise = loadFromStorage();
  return loadingPromise;
}

/** 로그인 직후 또는 사용자 전환 시 Firestore에서 다시 가져와 캐시 동기화 */
export async function refreshSettingsFromCloud(): Promise<void> {
  await syncFromFirestore();
}

/** 사용자가 등록한 OpenRouter API 키 (없으면 null): 캐시된 sync 값 */
export function getUserApiKeySync(): string | null {
  return cachedKey;
}

/** 빠른 모드 활성 여부: 사용자 키가 있고 토글이 on일 때만 true */
export function getFastModeSync(): boolean {
  return !!cachedKey && cachedFast;
}

export async function setUserApiKey(key: string | null): Promise<void> {
  const trimmed = key?.trim() || null;
  cachedKey = trimmed;
  // 키 없으면 빠른 모드도 자동 off
  if (!trimmed) cachedFast = false;
  try {
    if (trimmed) await AsyncStorage.setItem(KEY_API, trimmed);
    else {
      await AsyncStorage.removeItem(KEY_API);
      await AsyncStorage.removeItem(KEY_FAST);
    }
  } catch {}
  // Firestore에도 기록: 다른 기기/브라우저에서도 살아남도록
  const u = auth.currentUser;
  if (u) {
    try {
      await setDoc(
        doc(db, 'userPrefs', u.uid),
        trimmed
          ? { openrouterKey: trimmed }
          : { openrouterKey: null, fastMode: false },
        { merge: true },
      );
    } catch { /* noop — 오프라인이어도 로컬은 유지됨 */ }
  }
  notify();
}

/**
 * OpenRouter 키 유효성 검증: GET /api/v1/auth/key로 ping.
 * 유효하면 { ok: true, label?, limit?, usage? } 반환, 무효면 사용자 친화 에러 메시지 throw.
 */
export async function validateOpenRouterKey(key: string): Promise<{
  ok: true;
  label?: string;
  limitRemaining?: number | null;
  usage?: number;
  isFreeTier?: boolean;
}> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API 키가 비어 있어요.');
  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${trimmed}` },
    });
  } catch {
    throw new Error('OpenRouter 서버에 연결할 수 없어요. 인터넷을 확인해주세요.');
  }
  if (res.status === 401) throw new Error('유효하지 않은 API 키예요. OpenRouter에서 발급받은 키를 다시 확인해주세요.');
  if (res.status === 403) throw new Error('키 권한이 부족해요.');
  if (!res.ok) throw new Error(`키 확인 실패 (${res.status})`);

  let body: any;
  try { body = await res.json(); } catch { throw new Error('OpenRouter 응답을 읽을 수 없어요.'); }
  const data = body?.data ?? body;
  return {
    ok: true,
    label: data?.label ?? undefined,
    limitRemaining: data?.limit_remaining ?? data?.limit ?? null,
    usage: data?.usage,
    isFreeTier: data?.is_free_tier ?? false,
  };
}

/** 현재 AI provider (캐시된 sync 값). 기본 'openrouter'. */
export function getProviderSync(): AiProvider {
  return cachedProvider;
}

export async function setProvider(p: AiProvider): Promise<void> {
  if (p !== 'openrouter' && p !== 'cerebras' && p !== 'openai') return;
  if (p === cachedProvider) return;
  cachedProvider = p;
  try { await AsyncStorage.setItem(KEY_PROVIDER, p); } catch {}
  const u = auth.currentUser;
  if (u) {
    try {
      await setDoc(doc(db, 'userPrefs', u.uid), { aiProvider: p }, { merge: true });
    } catch {}
  }
  notify();
}

export async function setFastMode(b: boolean): Promise<void> {
  // 키 없는데 fast on 불가
  if (b && !cachedKey) return;
  cachedFast = b;
  try {
    await AsyncStorage.setItem(KEY_FAST, b ? '1' : '0');
  } catch {}
  // Firestore에도 기록
  const u = auth.currentUser;
  if (u) {
    try {
      await setDoc(doc(db, 'userPrefs', u.uid), { fastMode: b }, { merge: true });
    } catch {}
  }
  notify();
}
