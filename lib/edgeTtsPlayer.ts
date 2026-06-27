// Edge TTS mp3 캐싱 + expo-av 재생 래퍼
// - 네이티브: 디스크 캐시 (expo-file-system)
// - 웹: 메모리 Map + Blob URL
// - synthesizeEdgeTts로 mp3 받아 Audio.Sound로 재생
// - onEnd 콜백, stop, isPlaying 폴링 지원 (player의 폴링 루프와 호환)
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Audio, AVPlaybackStatus } from 'expo-av';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { synthesizeEdgeTts, edgeVoiceNameFromId } from './edgeTts';

const CACHE_DIR = (FileSystem.cacheDirectory ?? '') + 'edge-tts/';

// 웹용 메모리 캐시: key → blob URL
const webBlobCache = new Map<string, string>();

async function ensureDir(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const info = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
  } catch {}
}

function cacheKey(text: string, voice: string, rate: number): string {
  const payload = `${voice}|${rate.toFixed(2)}|${text}`;
  return bytesToHex(sha256(new TextEncoder().encode(payload))).slice(0, 32);
}

function cachePath(key: string): string {
  return `${CACHE_DIR}${key}.mp3`;
}

// base64 인코딩 (Uint8Array → base64 문자열): expo-file-system writeAsStringAsync에 사용
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function uint8ToBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64_CHARS[a >> 2];
    out += B64_CHARS[((a & 0x03) << 4) | (b >> 4)];
    out += B64_CHARS[((b & 0x0f) << 2) | (c >> 6)];
    out += B64_CHARS[c & 0x3f];
  }
  if (i < len) {
    const a = bytes[i];
    out += B64_CHARS[a >> 2];
    if (i + 1 < len) {
      const b = bytes[i + 1];
      out += B64_CHARS[((a & 0x03) << 4) | (b >> 4)];
      out += B64_CHARS[(b & 0x0f) << 2];
      out += '=';
    } else {
      out += B64_CHARS[(a & 0x03) << 4];
      out += '==';
    }
  }
  return out;
}

// 캐시된 mp3 URI 보장 (없으면 fetch). 네이티브는 file://, 웹은 blob URL.
export async function getOrFetchEdgeMp3(
  text: string,
  voiceId: string,
  rate = 1.0,
  signal?: AbortSignal,
): Promise<string> {
  const voice = edgeVoiceNameFromId(voiceId);
  const key = cacheKey(text, voice, rate);

  if (Platform.OS === 'web') {
    // 웹: Blob URL 메모리 캐시
    const cached = webBlobCache.get(key);
    if (cached) return cached;
    const mp3 = await synthesizeEdgeTts({ text, voice, rate, signal });
    // Uint8Array의 ArrayBuffer 부분만 슬라이스해서 SharedArrayBuffer 호환 문제 회피
    const buf = mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength) as ArrayBuffer;
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    webBlobCache.set(key, url);
    return url;
  }

  // 네이티브: 디스크 캐시
  await ensureDir();
  const path = cachePath(key);
  const info = await FileSystem.getInfoAsync(path);
  if (info.exists && (info as any).size > 200) {
    return path;
  }
  const mp3 = await synthesizeEdgeTts({ text, voice, rate, signal });
  await FileSystem.writeAsStringAsync(path, uint8ToBase64(mp3), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return path;
}

// 현재 재생 중인 Sound 객체 (한 번에 하나만)
let currentSound: Audio.Sound | null = null;
let currentToken = 0;
// "TTS 꺼짐" 상태에도 mp3는 계속 재생하되 볼륨만 0으로 → 토글 즉시 현재 위치에서 소리만 켜기
let edgeMuted = false;
// 사용자 페이더 값 (0..1). edgeMuted=false일 때 실제 출력 볼륨.
let edgeVolume = 1;

function effectiveVolume(): number {
  return edgeMuted ? 0 : edgeVolume;
}

// 빠른 드래그 시 setVolumeAsync가 native 큐에 쌓여 팝/잡음을 유발.
// in-flight 호출이 끝날 때까지 새 값은 큐잉하지 않고 "다음 적용할 최신 값"만 보관 → 한 번에 하나씩만 native 호출.
let volumeInFlight = false;
let pendingVolume: number | null = null;
let lastAppliedVolume: number | null = null;

async function applyLiveVolume(): Promise<void> {
  pendingVolume = effectiveVolume();
  if (volumeInFlight) return;
  volumeInFlight = true;
  try {
    while (pendingVolume !== null) {
      const target = pendingVolume;
      pendingVolume = null;
      const s = currentSound;
      if (!s) break;
      if (lastAppliedVolume !== null && Math.abs(lastAppliedVolume - target) < 0.005) {
        continue; // 의미 없는 변화는 스킵
      }
      try {
        await s.setVolumeAsync(target);
        lastAppliedVolume = target;
      } catch {}
    }
  } finally {
    volumeInFlight = false;
  }
}

/** Edge TTS 음소거 토글. 현재 재생 중인 Sound가 있으면 live로 볼륨 변경. */
export function setEdgeTtsMuted(muted: boolean): void {
  edgeMuted = muted;
  applyLiveVolume();
}

export function isEdgeTtsMuted(): boolean {
  return edgeMuted;
}

/** 사용자 페이더 볼륨 설정 (0..1). 클램프. */
export function setEdgeTtsVolume(v: number): void {
  edgeVolume = Math.max(0, Math.min(1, v));
  applyLiveVolume();
}

export function getEdgeTtsVolume(): number {
  return edgeVolume;
}

/**
 * 현재 재생 중인 Sound에 새 playback rate 즉시 적용.
 * mp3는 항상 1.0 user rate로 합성·캐시되고, 배속은 expo-av의 setRateAsync로만 처리 → 캐시 단일화.
 */
export function setEdgePlaybackRate(rate: number): void {
  const s = currentSound;
  if (s) {
    s.setRateAsync(rate, true).catch(() => {});
  }
}

/**
 * 현재 토큰값: stopEdgeTts/playEdgeMp3가 호출될 때마다 증가.
 * fetch→play 사이의 stale 판정용: ttsSpeak에서 fetch 시작 시 토큰을 캡처하고, resolve 시 변경됐으면 play 스킵.
 */
export function getEdgeTtsToken(): number {
  return currentToken;
}

export async function stopEdgeTts(): Promise<void> {
  currentToken++;
  const s = currentSound;
  currentSound = null;
  if (!s) return;
  // 즉시 무음 처리: stopAsync/unloadAsync가 끝나기 전이라도 사용자는 소리가 끊긴 것처럼 느낌.
  // setVolumeAsync는 OS 오디오 엔진에서 즉시 처리되므로 await 없이 발사.
  s.setVolumeAsync(0).catch(() => {});
  try {
    await s.stopAsync();
  } catch {}
  try {
    await s.unloadAsync();
  } catch {}
}

interface PlayOptions {
  onEnd?: () => void;
  /** expo-av playback rate. mp3는 1.0 기준으로 합성·캐시되므로 이 값이 곧 사용자 체감 배속. */
  rate?: number;
}

// mp3 경로로 재생 → onEnd 콜백
export async function playEdgeMp3(path: string, opts: PlayOptions = {}): Promise<void> {
  const { onEnd, rate = 1.0 } = opts;
  await stopEdgeTts();
  const myToken = ++currentToken;

  // 모드 설정 (네이티브 전용: 무음 모드에서도 재생되도록)
  if (Platform.OS !== 'web') {
    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });
    } catch {}
  }

  const startVolume = effectiveVolume();
  lastAppliedVolume = startVolume;
  const { sound } = await Audio.Sound.createAsync(
    { uri: path },
    { shouldPlay: true, rate, shouldCorrectPitch: true, volume: startVolume },
  );
  if (myToken !== currentToken) {
    // 그 사이 stop 호출됨
    try { await sound.unloadAsync(); } catch {}
    return;
  }
  currentSound = sound;

  let ended = false;
  sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    if (status.didJustFinish && !ended) {
      ended = true;
      if (myToken === currentToken) currentSound = null;
      sound.unloadAsync().catch(() => {});
      onEnd?.();
    }
  });
}

// 현재 재생 중인지 (player의 폴링 루프와 호환)
export async function isEdgeTtsPlaying(): Promise<boolean> {
  const s = currentSound;
  if (!s) return false;
  try {
    const status = await s.getStatusAsync();
    if (!status.isLoaded) return false;
    return status.isPlaying === true;
  } catch {
    return false;
  }
}
