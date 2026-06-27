// TTS 음성 선택 유틸: iOS/Android/웹에서 한국어 voice 목록 조회 + 사용자 선택 영속화
import * as Speech from 'expo-speech';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EDGE_TTS_VOICES, isEdgeVoiceId } from './edgeTts';
import { getOrFetchEdgeMp3, playEdgeMp3, stopEdgeTts } from './edgeTtsPlayer';

export interface TtsVoiceOption {
  id: string;        // 선택 시 저장되는 식별자 (Edge는 'edge:' prefix)
  name: string;      // 표시명
  language: string;  // ko-KR 등
  quality?: string;  // Default / Enhanced
  provider: 'os' | 'edge';
}

const VOICE_KEY = '@gongform/tts/voice';

// 모듈 캐시, 플레이어가 동기적으로 사용
let ttsVoiceCache: string | null = null;
export function getCachedVoiceId(): string | null {
  return ttsVoiceCache;
}
export function setCachedVoiceId(id: string | null): void {
  ttsVoiceCache = id;
}

// Edge TTS 4종은 OS 음성 목록 위에 항상 표시
const EDGE_VOICES_AS_OPTIONS: TtsVoiceOption[] = EDGE_TTS_VOICES.map((v) => ({
  id: v.id,
  name: `${v.displayName} · 고품질`,
  language: 'ko-KR',
  quality: 'Enhanced',
  provider: 'edge',
}));

export async function listKoreanVoices(): Promise<TtsVoiceOption[]> {
  const osVoices: TtsVoiceOption[] = await (async () => {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || !window.speechSynthesis) return [];
      let voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) {
        await new Promise<void>((resolve) => {
          const handler = () => {
            window.speechSynthesis.removeEventListener('voiceschanged', handler);
            resolve();
          };
          window.speechSynthesis.addEventListener('voiceschanged', handler);
          setTimeout(resolve, 1200);
        });
        voices = window.speechSynthesis.getVoices();
      }
      return voices
        .filter((v) => v.lang === 'ko-KR' || v.lang?.startsWith('ko'))
        .map((v) => ({ id: v.voiceURI, name: v.name, language: v.lang, provider: 'os' as const }));
    }
    try {
      const all = await Speech.getAvailableVoicesAsync();
      return all
        .filter((v) => v.language === 'ko-KR' || v.language?.startsWith('ko'))
        .map((v) => ({
          id: v.identifier,
          name: v.name || v.identifier,
          language: v.language,
          quality: v.quality,
          provider: 'os' as const,
        }));
    } catch {
      return [];
    }
  })();
  // Edge TTS는 Cloudflare Worker 프록시 경유 → 모든 플랫폼에서 동작
  return [...EDGE_VOICES_AS_OPTIONS, ...osVoices];
}

export async function loadSavedVoiceId(): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(VOICE_KEY);
    ttsVoiceCache = v;
    return v;
  } catch {
    return null;
  }
}

export async function saveVoiceId(id: string | null): Promise<void> {
  ttsVoiceCache = id;
  try {
    if (id === null) await AsyncStorage.removeItem(VOICE_KEY);
    else await AsyncStorage.setItem(VOICE_KEY, id);
  } catch {}
}

// 미리듣기: 마이 탭에서 음성 선택 시 샘플 재생.
// volume(0..1): Edge TTS는 setEdgeTtsVolume으로 이미 모듈 state가 관리됨(생략 가능).
// OS 음성(Web Speech / expo-speech)은 utterance / options에 명시적으로 전달.
export async function previewVoice(
  voiceId: string | null,
  sampleText = '안녕하세요. 공폼 음성 미리듣기입니다.',
  volume = 1,
): Promise<void> {
  const v = Math.max(0, Math.min(1, volume));
  // Edge TTS voice는 mp3 받아서 expo-av로 재생 (볼륨은 edgeTts 모듈의 effectiveVolume이 적용)
  if (isEdgeVoiceId(voiceId)) {
    await stopEdgeTts();
    const path = await getOrFetchEdgeMp3(sampleText, voiceId, 1.0);
    await playEdgeMp3(path, { rate: 1.0 });
    return;
  }
  // OS 음성 (기존 경로)
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(sampleText);
    utt.lang = 'ko-KR';
    utt.rate = 1.0;
    utt.volume = v;
    if (voiceId) {
      const voices = window.speechSynthesis.getVoices();
      const found = voices.find((v) => v.voiceURI === voiceId);
      if (found) utt.voice = found;
    }
    window.speechSynthesis.speak(utt);
  } else {
    Speech.stop();
    Speech.speak(sampleText, {
      language: 'ko-KR',
      rate: 1.0,
      pitch: 1.0,
      volume: v,
      ...(voiceId ? { voice: voiceId } : {}),
    });
  }
}

export function stopPreview(): void {
  // 두 경로 모두 중단
  stopEdgeTts().catch(() => {});
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  } else {
    Speech.stop();
  }
}
