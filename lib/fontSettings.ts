// 사용자 선택 디스플레이 폰트 (큰 글씨용): AsyncStorage 영구 저장 + 리스너.
// 4가지 한글 무료 폰트 (SIL OFL, 상업적 사용 가능):
//   Jua          : 둥그레한 친근함
//   GowunDodum   : 깔끔하고 모던
//   BlackHanSans : 굵고 임팩트 있는 디스플레이
//   CuteFont     : 손글씨 느낌 귀여움
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@gongform/displayFont';

export const FONT_OPTIONS = {
  Jua: { family: 'Jua_400Regular', label: '쥬아 (둥그레한 친근함)' },
  GowunDodum: { family: 'GowunDodum_400Regular', label: '고운돋움 (깔끔·모던)' },
  BlackHanSans: { family: 'BlackHanSans_400Regular', label: '블랙한산스 (굵고 임팩트)' },
  CuteFont: { family: 'CuteFont_400Regular', label: '큐트폰트 (귀여운 손글씨)' },
} as const;

export type FontKey = keyof typeof FONT_OPTIONS;
export const FONT_KEYS = Object.keys(FONT_OPTIONS) as FontKey[];

let cached: FontKey = 'Jua';
let loaded = false;
let loadingPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function subscribeFont(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function notify(): void {
  for (const l of listeners) { try { l(); } catch {} }
}

export function getCurrentFontKey(): FontKey {
  return cached;
}

export function getCurrentFontFamily(): string {
  return FONT_OPTIONS[cached].family;
}

async function loadFromStorage(): Promise<void> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v && v in FONT_OPTIONS) cached = v as FontKey;
  } catch {}
  loaded = true;
}

export function ensureFontLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loadingPromise) loadingPromise = loadFromStorage();
  return loadingPromise;
}

export async function setFont(key: FontKey): Promise<void> {
  cached = key;
  try { await AsyncStorage.setItem(KEY, key); } catch {}
  notify();
}
