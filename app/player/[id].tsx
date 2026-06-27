import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  Animated,
  Platform,
  PanResponder,
  Image,
  ScrollView,
  Modal,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { collection, query, where, getDocs, doc, getDoc, documentId } from 'firebase/firestore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCachedVoiceId, loadSavedVoiceId } from '@/lib/ttsVoice';
import { isEdgeVoiceId } from '@/lib/edgeTts';
import { getOrFetchEdgeMp3, playEdgeMp3, stopEdgeTts, isEdgeTtsPlaying, setEdgeTtsMuted, setEdgeTtsVolume, setEdgePlaybackRate, getEdgeTtsToken } from '@/lib/edgeTtsPlayer';

// TTS 설정 영속화: 플레이어를 나갔다 돌아와도, 앱을 재시작해도 유지
const TTS_PREF_KEY = '@gongform/player/ttsEnabled';
let ttsEnabledCache = true; // 모듈 캐시: 마운트 직후 동기적으로 사용
// TTS 속도 (rate 배율): 0.75 / 1.0 / 1.25 / 1.5 순환
const TTS_RATE_KEY = '@gongform/player/ttsRate';
const TTS_RATES = [0.75, 1.0, 1.25, 1.5] as const;
let ttsRateCache: number = 1.0;
// TTS 페이더 볼륨 (0..1)
const TTS_VOLUME_KEY = '@gongform/player/ttsVolume';
let ttsVolumeCache: number = 1.0;
import { db } from '@/lib/firebase';
import { colors } from '@/lib/theme';
import { useAuth } from '@/contexts/AuthContext';
import { recordStudySession, getMilestoneInfo } from '@/lib/streak';
import { addStudySeconds } from '@/lib/studyTime';
import { saveWrongAnswer, markReviewed, getWrongAnswers, WrongAnswer } from '@/lib/wrongAnswers';
import { removeFromReviewSession } from '@/lib/reviewSession';
import { awardXpForCurrentUser } from '@/lib/levelSystem';
import { recordActivity } from '@/lib/dailyActivity';
import { saveStudyNote, deleteStudyNotesByShortformIds, getStudyNotes } from '@/lib/studyNotes';
import { fetchBackgroundMedia } from '@/lib/imageSearch';

const USE_NATIVE_DRIVER = Platform.OS !== 'web';
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

interface ShortForm {
  id: string;
  type: 'concept' | 'example' | 'quiz';
  content: { title: string; script: string };
  order: number;
  folderId?: string;
  projectId?: string | null;
  imageKeyword?: string;
  imageKeywords?: string[];
  /** 1~10. 누락 시 5로 간주. 오답 등재 시 복습 간격 계산에 사용 */
  importance?: number;
  // 퀴즈 모드 (type==='quiz'일 때만)
  /** 'ox' | 'mcq' | 'fillblank'. 누락 시 'ox'로 간주 */
  quizMode?: 'ox' | 'mcq' | 'fillblank';
  /** MCQ 보기 */
  choices?: string[];
  /** MCQ 정답 인덱스 (0-based) */
  answerIndex?: number;
  /** Fillblank 정답 문자열 */
  blankAnswer?: string;
  /** 파생 카드(example/quiz)의 부모 concept title, "개념 보러가기" 정확 매칭용 */
  parentConceptTitle?: string;
}

// fillblank 정답 정규화: 공백/대소문자/조사 무시
function normalizeAnswer(s: string): string {
  return (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[은는이가을를의에에서으로]$/g, '');
}
function isFillblankCorrect(user: string, correct: string): boolean {
  return normalizeAnswer(user) === normalizeAnswer(correct);
}

const TYPE_CONFIG = {
  concept: {
    label: '개념 정리',
    color: '#4F8EF7',
    gradient: ['#0A1628', '#0D1F3C', '#0A1628'] as [string, string, string],
    icon: 'bulb-outline' as const,
    accent: '#4F8EF7',
  },
  example: {
    label: '예시 문제',
    color: '#22C55E',
    gradient: ['#0A1A0E', '#0F2A14', '#0A1A0E'] as [string, string, string],
    icon: 'code-slash-outline' as const,
    accent: '#22C55E',
  },
  quiz: {
    label: '퀴즈',
    color: '#F97316',
    gradient: ['#1A0E05', '#2A1508', '#1A0E05'] as [string, string, string],
    icon: 'help-circle-outline' as const,
    accent: '#F97316',
  },
};

function splitQuizScript(script: string): { question: string; answer: string } {
  let trimmed = script.trim();

  // 방어 1: AI가 가끔 "정답은 O이다. 다음 문장이 옳은가? ..." 처럼 답을 먼저 적는 케이스.
  // 맨 앞 정답 문장을 잘라내 뒤로 옮긴 뒤 다시 split.
  const earlyAnswer = trimmed.match(/^(정답[은:]?\s*[OXox오엑스X][^.\n]*[.\n]\s*)/);
  if (earlyAnswer) {
    const answerHead = earlyAnswer[1].trim();
    const rest = trimmed.slice(earlyAnswer[1].length).trim();
    if (rest.length > 0) {
      trimmed = `${rest}\n\n${answerHead}`;
    }
  }

  const keywords = ['정답은', '정답:', '답은', '답:', '해설:'];
  for (const kw of keywords) {
    const idx = trimmed.indexOf(kw);
    if (idx > 5) {
      return { question: trimmed.slice(0, idx).trim(), answer: trimmed.slice(idx).trim() };
    }
  }
  const match = trimmed.match(/^(.+?[?!？！]+\s*)/);
  if (match && match[1].length < trimmed.length * 0.75) {
    return { question: match[1].trim(), answer: trimmed.slice(match[1].length).trim() };
  }
  const words = trimmed.split(' ');
  const mid = Math.ceil(words.length * 0.45);
  return { question: words.slice(0, mid).join(' '), answer: words.slice(mid).join(' ') };
}

function wordMs(word: string): number {
  return Math.max(220, word.replace(/[^가-힣a-zA-Z0-9]/g, '').length * 140);
}

function pauseAfterMs(word: string): number {
  if (/[.!?。！？]/.test(word)) return 300;
  if (/[,，、]/.test(word)) return 60;
  return 0;
}

// TTS 추상화: 웹은 Web Speech API, 네이티브는 expo-speech
let cachedVoices: SpeechSynthesisVoice[] = [];
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  const syncVoices = () => { cachedVoices = window.speechSynthesis?.getVoices() ?? []; };
  syncVoices();
  window.speechSynthesis?.addEventListener('voiceschanged', syncVoices);
}

function ttsSpeak(
  text: string,
  opts?: { rate?: number; onBoundary?: (wordIdx: number) => void; onEnd?: () => void; chained?: boolean },
) {
  const rate = opts?.rate ?? 1.0;
  const { onBoundary, onEnd, chained } = opts ?? {};
  // 마이 탭에서 선택한 사용자 지정 voice. null이면 시스템 기본 한국어 voice 사용
  const userVoiceId = getCachedVoiceId();
  // Edge TTS voice: mp3 fetch + expo-av 재생. 실패 시 시스템 음성으로 폴백.
  if (isEdgeVoiceId(userVoiceId)) {
    if (!chained) stopEdgeTts().catch(() => {});
    // mp3는 항상 user 1.0 배속 기준 SSML rate(=1.2: Edge baseline 보정)로 합성·캐시.
    // 배속은 expo-av playback rate로만 처리 → 어떤 user rate에서도 같은 mp3 캐시 재사용 → 즉시 재생.
    const SSML_RATE = 1.2;
    const playbackRate = rate / 0.95; // proceed가 0.95 * userRate를 넘김 → user 체감 rate 복원
    // 빠른 스와이프 시 이전 카드의 mp3 fetch가 새 카드 도중에 도착해 엉뚱한 텍스트가 재생되는 경합 방지.
    // fetch 시작 시점의 token을 캡처하고, resolve 시점에 다른 stopEdgeTts/play가 호출됐으면 (token 변경) play 스킵.
    const myToken = getEdgeTtsToken();
    const isStale = () => myToken !== getEdgeTtsToken();
    getOrFetchEdgeMp3(text, userVoiceId, SSML_RATE)
      .then((path) => {
        if (isStale()) return;
        return playEdgeMp3(path, { rate: playbackRate, onEnd });
      })
      .catch((e) => {
        if (isStale()) return;
        console.warn('[Edge TTS] 실패 → 시스템 음성 폴백', e);
        if (Platform.OS === 'web') {
          // 웹은 SpeechSynthesis로 폴백 (아래 일반 경로 재시도)
          if (typeof window !== 'undefined' && window.speechSynthesis) {
            const utt = new SpeechSynthesisUtterance(text);
            utt.lang = 'ko-KR';
            utt.rate = rate;
            utt.volume = ttsVolumeCache;
            if (onEnd) utt.onend = onEnd;
            window.speechSynthesis.speak(utt);
          }
        } else {
          Speech.speak(text, {
            language: 'ko-KR', rate, pitch: 1.0,
            onDone: onEnd, onError: () => { onEnd?.(); },
          });
        }
      });
    return;
  }
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      console.warn('[TTS] speechSynthesis 미지원');
      return;
    }

    const voices = cachedVoices.length > 0 ? cachedVoices : window.speechSynthesis.getVoices();
    const userVoice = userVoiceId ? voices.find((v) => v.voiceURI === userVoiceId) : null;
    const koVoice =
      userVoice ??
      voices.find(v => v.lang === 'ko-KR') ??
      voices.find(v => v.lang.startsWith('ko'));

    const utt = new SpeechSynthesisUtterance(text);
    if (koVoice) {
      utt.voice = koVoice;
      utt.lang = koVoice.lang;
    } else {
      utt.lang = 'ko-KR'; // 한국어 voice 없어도 lang은 설정 → 시스템이 best match 사용
      console.warn('[TTS] 한국어 voice 없음. 사용 가능 voices:', voices.map(v => `${v.name}(${v.lang})`).join(', '));
    }
    utt.rate = rate;
    utt.pitch = 1.0;
    utt.volume = ttsVolumeCache;
    utt.onstart = () => console.log('[TTS] start:', text.slice(0, 30));
    if (onBoundary) {
      utt.onboundary = (e) => {
        if (e.name !== 'word') return;
        const idx = text.slice(0, e.charIndex).split(/\s+/).filter(Boolean).length;
        onBoundary(idx);
      };
    }
    if (onEnd) utt.onend = onEnd;
    // 'canceled'는 우리가 다음 청크로 넘기며 cancel한 경우 → onEnd 무시 (이미 처리됨)
    // 'not-allowed'는 autoplay 정책으로 거부된 것 → 즉시 다음 청크로 advance하면 첫 문장 스킵 버그 발생.
    //   onEnd 호출하지 않고 safety timer/폴링이 자연스럽게 처리하도록 둠 → 자막은 유지된 채 다음으로
    // 그 외 에러는 onEnd 호출해 safety 대기 없이 즉시 진행
    utt.onerror = (e) => {
      // 'canceled': 다음 청크/navigation으로 cancel한 정상 흐름 → 무시
      // 'not-allowed': autoplay 정책 → 자막은 유지하고 safety timer/폴링이 자연 advance
      if (e.error === 'canceled' || e.error === 'not-allowed') return;
      console.warn('[TTS] error', e.error);
      onEnd?.();
    };
    // chained: 직전 청크가 자연 종료된 직후라 cancel 생략해서 전환 latency 제거
    // 또한 priming utterance가 아직 발화/대기 중이면 cancel하지 않음:
    // priming은 user-gesture 안에서 시작된 것 → 중간에 cancel하면 synth의 unlock 활성이 풀려
    // 다음 speak()가 'not-allowed' 에러로 거부됨. → queue에 추가만 해서 priming 뒤에 자연스럽게 이어 재생.
    const inFlight = window.speechSynthesis.speaking || window.speechSynthesis.pending;
    if (!chained && !inFlight) {
      window.speechSynthesis.cancel();
    }
    window.speechSynthesis.speak(utt);
  } else {
    if (!chained) Speech.stop();
    Speech.speak(text, {
      language: 'ko-KR',
      rate,
      pitch: 1.0,
      onDone: onEnd,
      onError: () => { onEnd?.(); },
      // 마이 탭에서 선택한 voice id가 있으면 사용 (없으면 expo-speech가 시스템 기본 한국어 voice 사용)
      ...(userVoiceId ? { voice: userVoiceId } : {}),
    });
  }
}

function ttsStop() {
  // Edge TTS는 voice 미선택 상태에서도 안전하게 no-op (currentSound null이면 즉시 반환)
  stopEdgeTts().catch(() => {});
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  } else {
    Speech.stop();
  }
}

type QuizPhase = 'question' | 'waiting' | 'answer';

function detectOXAnswer(text: string): 'O' | 'X' | null {
  if (/정답[은:]\s*[Oo오O]/i.test(text)) return 'O';
  if (/정답[은:]\s*[Xx엑스X]/i.test(text)) return 'X';
  if (/[Oo오O]\s*(?:입니다|가\s*정답|가\s*맞)/i.test(text)) return 'O';
  if (/[Xx엑스X]\s*(?:입니다|가\s*정답|가\s*맞)/i.test(text)) return 'X';
  if (/^[Oo오O][\s,.]/.test(text.trim())) return 'O';
  if (/^[Xx엑스X][\s,.]/.test(text.trim())) return 'X';
  return null;
}

// 자막 청킹 (몇 단어 ~ 1문장 단위로 분할)
function chunkScript(script: string): string[] {
  if (!script) return [];
  // 문장 종결 부호는 뒤에 공백/끝이 올 때만 분기점으로 인정 (소수점·약어 보호)
  const sentences = script.match(/.+?(?:[.!?。！？]+(?=\s|$)|$)/g) || [script];
  const out: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= 100) { out.push(s); continue; }
    // 아주 긴 문장(100자 초과)은 쉼표 기준으로만 나누고, 쉼표가 없으면 통째로 표시
    const parts = s.split(/(?<=[,，、])\s*/);
    for (const p of parts) {
      if (p.trim()) out.push(p.trim());
    }
  }
  return out.length > 0 ? out : [script.trim()];
}

// 청크당 표시 시간
// - TTS off: 기존 읽기 페이스 (800 + chars*85, clamp 1.2~5초). 웹은 1.176배 약간 길게 (기존 동작 유지)
// - TTS on:  실측 한국어 TTS rate=0.95 페이스 (300 + chars*220, clamp 1.4~9초). 실제 TTS 종료 시 진행바 스냅으로 보정
function chunkDurationMs(chunk: string, ttsOn: boolean): number {
  const chars = chunk.replace(/\s/g, '').length;
  if (ttsOn) {
    return Math.max(1400, Math.min(9000, 300 + chars * 220));
  }
  const base = Math.max(1200, Math.min(5000, 800 + chars * 85));
  return Platform.OS === 'web' ? base * (1 / 0.85) : base;
}

// TTS 배속 변경 시 청크를 중간부터 재개하려고 글자 인덱스를 잡았을 때,
// 한국어 텍스트는 단어 구분이 없어서 음절 중간을 찢으면 어색함.
// 가까운 공백·구두점 직후로 스냅 (앞으로 최대 20자 탐색, 못 찾으면 그대로).
function snapToBoundary(text: string, idx: number): number {
  if (idx <= 0) return 0;
  if (idx >= text.length) return text.length;
  const limit = Math.min(text.length, idx + 20);
  for (let i = idx; i < limit; i++) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === ',' || c === '.' || c === '!' || c === '?' || c === '。' || c === '、' || c === '，') {
      return i + 1;
    }
  }
  return idx;
}

// 제목을 강조색/일반색 두 부분으로 분할
function splitTitleForColor(title: string): { prefix: string; rest: string } {
  const t = title.trim();
  // 1. 콜론 기준
  const m = t.match(/^(.+?)\s*[:：]\s*(.+)$/);
  if (m) return { prefix: m[1].trim(), rest: m[2].trim() };

  // 2. 콜론 없으면 단어 절반 분할 (앞 절반 강조색)
  const words = t.split(/\s+/);
  if (words.length <= 1) return { prefix: '', rest: t };
  if (words.length === 2) return { prefix: words[0], rest: words[1] };
  const half = Math.ceil(words.length / 2);
  return { prefix: words.slice(0, half).join(' '), rest: words.slice(half).join(' ') };
}

// 로컬(=한국) 자정 기준 YYYY-MM-DD.
function localDayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "오늘 틀림", "3일 전 틀림": wrongAt 또는 lastWrongAt 기준
function wrongAgoLabel(iso: string): string {
  const todayKey = localDayKey();
  const thatKey = localDayKey(new Date(iso));
  if (thatKey === todayKey) return '오늘 틀림';
  const a = new Date(todayKey + 'T00:00:00').getTime();
  const b = new Date(thatKey + 'T00:00:00').getTime();
  const days = Math.max(1, Math.round((a - b) / 86400000));
  return `${days}일 전 틀림`;
}

// "오늘 복습", "N일 후 복습", "N일 지남": nextReviewAt 기준
function nextReviewLabel(iso: string): string {
  const todayKey = localDayKey();
  const thatKey = localDayKey(new Date(iso));
  if (thatKey === todayKey) return '오늘 복습';
  const a = new Date(todayKey + 'T00:00:00').getTime();
  const b = new Date(thatKey + 'T00:00:00').getTime();
  const days = Math.round((b - a) / 86400000);
  if (days < 0) return `${-days}일 지남`;
  return `${days}일 후 복습`;
}

interface CardProps {
  item: ShortForm;
  /** 이 카드에 대응되는 오답노트 기록. 있으면 "X일 전 틀림" 등 칩 표시 */
  wrongRecord?: WrongAnswer | null;
  isActive: boolean;
  isPlaying: boolean;
  ttsEnabled: boolean;
  ttsRate: number;
  bgImageUrls?: string[];
  subject?: string;
  topInset?: number;
  bottomInset?: number;
  onPlayPause: () => void;
  onRequestSpeak?: (text: string, onEnd?: () => void) => void;
  onWrongAnswer?: (title: string, script: string) => void;
  /** 정답 처리 시 호출. 부모의 복습 모드에서 markReviewed + 큐 제거 트리거용. */
  onCorrectAnswer?: () => void;
  /** 첫 청크 재생이 실제로 시작됐을 때 발화. 부모(player)에서 "탭하여 음성 활성화" 배너 해제용. */
  onAudioPlaying?: () => void;
  /** 마지막 슬라이드까지 chunkIdx가 도달한 시점에 1회 발화. 부모에서 학습 인정·XP 적립 트리거. */
  onReachedLastSlide?: () => void;
  panHandlers?: object;
  /** 부모에서 "다음 문장으로 스킵"을 트리거하기 위한 ref. AnimatedCard가 자신의 skip 함수를 ref.current에 할당. */
  skipRef?: React.MutableRefObject<(() => void) | null>;
  /** "이전 문장으로 이동"을 위한 ref. */
  prevSentenceRef?: React.MutableRefObject<(() => void) | null>;
  /** quiz/example 오답 후 부모 concept으로 이동. 부모(player)가 부모 concept이 있을 때만 정의해서 전달. */
  onNavigateToParent?: () => void;
}

function AnimatedCard({ item, wrongRecord, isActive, isPlaying, ttsEnabled, ttsRate, bgImageUrls, subject, topInset = 0, bottomInset = 0, onPlayPause, onRequestSpeak, onWrongAnswer, onCorrectAnswer, onAudioPlaying, onReachedLastSlide, panHandlers, skipRef, prevSentenceRef, onNavigateToParent }: CardProps) {
  const cfg = TYPE_CONFIG[item.type];
  const isQuiz = item.type === 'quiz' || item.type === 'example';
  const revealLabel = item.type === 'example' ? '풀이 확인하기' : '정답 확인하기';

  // 청크 기반 자막 (몇 단어~1문장 단위)
  // MCQ/fillblank: 전체 script가 질문, 정답은 choices/blankAnswer 필드. answer phase에서 정답을 자막으로 노출.
  //   splitQuizScript의 45% word-split fallback이 질문을 중간에서 끊어 답안 패널이 mid-question에 뜨는 버그 방지.
  // OX/example: 기존대로 splitQuizScript로 question/answer 분리 (script 안에 "정답:/해설:" 키워드 포함).
  const { questionChunks, answerChunks } = useMemo(() => {
    if (!isQuiz) return { questionChunks: [] as string[], answerChunks: [] as string[] };
    if (item.type === 'quiz' && item.quizMode === 'mcq') {
      const correct = (item.answerIndex !== undefined && item.choices) ? item.choices[item.answerIndex] : null;
      const answerText = correct ? `정답: ${correct}` : '';
      return {
        questionChunks: chunkScript(item.content.script),
        answerChunks: answerText ? chunkScript(answerText) : [],
      };
    }
    if (item.type === 'quiz' && item.quizMode === 'fillblank') {
      const answerText = item.blankAnswer ? `정답: ${item.blankAnswer}` : '';
      return {
        questionChunks: chunkScript(item.content.script),
        answerChunks: answerText ? chunkScript(answerText) : [],
      };
    }
    const { question, answer } = splitQuizScript(item.content.script);
    return { questionChunks: chunkScript(question), answerChunks: chunkScript(answer) };
  }, [item.id]);
  const scriptChunks = useMemo(() => chunkScript(item.content.script), [item.id]);

  // 제목 분할
  const titleParts = useMemo(() => splitTitleForColor(item.content.title), [item.id]);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const glowAnim = useRef(new Animated.Value(0.3)).current;
  // 자막 애니메이션: opacity, scale (0.8→1.0 bounce), translateY (40→0)
  // 초기값을 "보이는 상태"로 두어 첫 청크가 즉시 뜨도록; 청크 전환 시에만 setChunkIdx에서 리셋+페이드인
  const subOpacity = useRef(new Animated.Value(1)).current;
  const subScale = useRef(new Animated.Value(1)).current;
  const subTranslateY = useRef(new Animated.Value(0)).current;
  // Ken Burns 효과 (이미지 줌)
  const kenBurnsScale = useRef(new Animated.Value(1)).current;

  const [chunkIdx, setChunkIdxState] = useState(0);
  const [ansChunkIdx, setAnsChunkIdxState] = useState(0);
  const [quizPhase, setQuizPhase] = useState<QuizPhase>('question');
  const [isDone, setIsDone] = useState(false);
  const [oxUserAnswer, setOxUserAnswer] = useState<'O' | 'X' | null>(null);
  const [exampleResult, setExampleResult] = useState<'correct' | 'wrong' | null>(null);
  // 새 퀴즈 모드 상태
  const [mcqUserAnswer, setMcqUserAnswer] = useState<number | null>(null);
  const [fillUserInput, setFillUserInput] = useState('');
  const [fillSubmitted, setFillSubmitted] = useState<boolean | null>(null); // null=미제출, true=정답, false=오답

  const quizMode: 'ox' | 'mcq' | 'fillblank' = item.type === 'quiz' ? (item.quizMode ?? 'ox') : 'ox';

  const correctOXAnswer = useMemo(() => {
    if (item.type !== 'quiz' || quizMode !== 'ox') return null;
    const { answer } = splitQuizScript(item.content.script);
    return detectOXAnswer(answer);
  }, [item.id, quizMode]);

  // 사용자가 틀린 상태인지: quiz 모드별/example로 분기. isDone 이후 마지막 슬라이드에서 "개념으로" 버튼 표시 조건
  const isWrong = (() => {
    if (item.type === 'example') return exampleResult === 'wrong';
    if (item.type !== 'quiz') return false;
    if (quizMode === 'ox') return oxUserAnswer !== null && correctOXAnswer !== null && oxUserAnswer !== correctOXAnswer;
    if (quizMode === 'mcq') return mcqUserAnswer !== null && item.answerIndex !== undefined && mcqUserAnswer !== item.answerIndex;
    if (quizMode === 'fillblank') return fillSubmitted === false;
    return false;
  })();

  const chunkRef = useRef(0);
  const ansChunkRef = useRef(0);
  const phaseRef = useRef<QuizPhase>('question');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequenceRef = useRef(0);
  const glowLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  const ttsEnabledRef = useRef(ttsEnabled);
  useEffect(() => { ttsEnabledRef.current = ttsEnabled; }, [ttsEnabled]);
  const ttsRateRef = useRef(ttsRate);
  useEffect(() => { ttsRateRef.current = ttsRate; }, [ttsRate]);
  // 현재 청크의 발화 시작 시각. 배속 변경 시 elapsed 추정해서 중간부터 재개하기 위함.
  // 0이면 "현재 발화 중인 청크 없음".
  const chunkStartedAtRef = useRef(0);

  function setChunkIdx(n: number) {
    chunkRef.current = n;
    setChunkIdxState(n);
  }
  function setAnsChunkIdx(n: number) {
    ansChunkRef.current = n;
    setAnsChunkIdxState(n);
  }
  function setPhase(p: QuizPhase) { phaseRef.current = p; setQuizPhase(p); }

  // "마지막 슬라이드까지 진행했다"를 한 번만 부모에 알림 (학습 인정 기준).
  // - concept: scriptChunks 마지막 인덱스 도달
  // - quiz/example: answer phase에서 answerChunks 마지막 인덱스 도달 (질문만 보고 답 안 했으면 학습 미인정)
  const reachedLastSlideRef = useRef(false);
  useEffect(() => {
    if (reachedLastSlideRef.current) return;
    if (!isActive) return;
    let reached = false;
    if (isQuiz) {
      if (quizPhase === 'answer' && answerChunks.length > 0 && ansChunkIdx >= answerChunks.length - 1) {
        reached = true;
      }
    } else {
      if (scriptChunks.length > 0 && chunkIdx >= scriptChunks.length - 1) {
        reached = true;
      }
    }
    if (reached) {
      reachedLastSlideRef.current = true;
      onReachedLastSlide?.();
    }
  }, [chunkIdx, ansChunkIdx, quizPhase, isActive, isQuiz, answerChunks.length, scriptChunks.length, onReachedLastSlide]);

  const prevChunkRef = useRef({ chunk: 0, ans: 0 });
  useLayoutEffect(() => {
    const prev = prevChunkRef.current;
    prevChunkRef.current = { chunk: chunkIdx, ans: ansChunkIdx };
    if (chunkIdx !== prev.chunk || ansChunkIdx !== prev.ans) {
      animateSubtitle();
    }
  }, [chunkIdx, ansChunkIdx]);

  function animateSubtitle() {
    subOpacity.setValue(0);
    subScale.setValue(0.85);
    subTranslateY.setValue(36);
    Animated.parallel([
      Animated.timing(subOpacity, {
        toValue: 1, duration: 220, useNativeDriver: USE_NATIVE_DRIVER,
      }),
      // 약한 바운스 (스프링)
      Animated.spring(subScale, {
        toValue: 1, friction: 5, tension: 90, useNativeDriver: USE_NATIVE_DRIVER,
      }),
      // 아래에서 위로
      Animated.spring(subTranslateY, {
        toValue: 0, friction: 7, tension: 65, useNativeDriver: USE_NATIVE_DRIVER,
      }),
    ]).start();
  }

  function clearTimer() {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    // 진행 중인 TTS 콜백/safety도 무효화 (runId 증가시켜 stale 처리)
    runIdRef.current += 1;
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
  }

  function speak(text: string, rate?: number, onEnd?: () => void, chained?: boolean) {
    if (Platform.OS === 'web' && onRequestSpeak) onRequestSpeak(text);
    else ttsSpeak(text, { rate, onEnd, chained });
  }

  // runChunks 시작 시점의 TTS 상태 캡처 + 호출별 ID로 stale 콜백 무효화
  const playbackTtsRef = useRef(false);
  const runIdRef = useRef(0);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearSafetyTimer() {
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
  }

  function runChunks(
    chunks: string[],
    from: number,
    setter: (n: number) => void,
    onDone?: () => void,
  ) {
    clearTimer(); // safetyTimer 정리 + runId 증가 (stale 무효화)
    if (chunks.length === 0) { onDone?.(); return; }
    const myId = ++runIdRef.current;
    // Edge 음성은 TTS 꺼져 있어도 mp3를 muted 재생 → 사용자가 TTS 켜는 즉시 현재 위치에서 소리만 켜짐.
    // 그 외 음성(Web Speech / OS)은 mute 컨트롤이 어려워 종전대로 ttsEnabled 기준.
    const userIsEdge = isEdgeVoiceId(getCachedVoiceId());
    playbackTtsRef.current = ttsEnabledRef.current || userIsEdge;
    const lockedTts = playbackTtsRef.current;
    const stale = () => myId !== runIdRef.current;
    let i = from;
    setter(i);

    const proceed = (next: () => void, isLast: boolean) => {
      if (stale()) return;
      const chunk = chunks[i];
      if (lockedTts) {
        let fired = false;
        let pollHandle: ReturnType<typeof setInterval> | null = null;
        let earlyEndTimer: ReturnType<typeof setTimeout> | null = null;
        const stopPolling = () => {
          if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
        };
        const chars = chunk.replace(/\s/g, '').length;
        const startedAt = Date.now();
        // 배속 변경 시 외부 effect가 elapsed 측정해서 중간부터 재개할 때 참조
        chunkStartedAtRef.current = startedAt;
        // 청크 시작 시점의 배속을 캡처 (mid-TTS 변경 시에는 useEffect가 청크를 재시작하므로 안전)
        const lockedRate = ttsRateRef.current;
        // 마지막 청크 min-duration guard: onEnd/폴링이 실제 audio 종료보다 일찍 firing되어
        // "다시 재생" 버튼이 재생 도중 뜨는 걸 막음. 배속 적용된 예상 발화 시간의 90% 이전에
        // fire 신호가 오면 예상 종료 시각까지 보류
        const minMs = isLast ? Math.floor((chars * 200) / lockedRate) : 0;
        const doFire = () => {
          if (fired || stale()) return;
          fired = true;
          stopPolling();
          clearSafetyTimer();
          if (earlyEndTimer) { clearTimeout(earlyEndTimer); earlyEndTimer = null; }
          if (!stale()) next();
        };
        const fire = () => {
          if (fired || stale()) return;
          const elapsed = Date.now() - startedAt;
          if (elapsed < minMs) {
            // onEnd 조기 발화 → 예상 종료 시각까지 보류 (가장 빠른 신호 하나만 스케줄)
            if (!earlyEndTimer) {
              earlyEndTimer = setTimeout(doFire, minMs - elapsed);
            }
            return;
          }
          doFire();
        };
        // Safety: onEnd/폴링 모두 실패해도 강제 진행. 배속 적용된 예상 시간 + 버퍼.
        // - 중간 청크: 글자당 300ms/rate + 400ms 버퍼 (자연 종료 시 폴링이 즉시 캐치, safety는 백업)
        // - 마지막 청크: 글자당 320ms/rate + 2500ms 버퍼 (min-duration guard가 isDone 조기 발화 방지)
        const safetyMs = isLast
          ? Math.max(3000, (chars * 320) / lockedRate + 2500)
          : Math.max(1500, (chars * 300) / lockedRate + 400);
        safetyTimerRef.current = setTimeout(fire, safetyMs);

        // 체인 호출(첫 청크 이후): 직전이 자연 종료된 직후라 stop/cancel 불필요 → 청크 간 공백 제거
        const chained = i > from;

        // Edge TTS 프리페치: 현재 청크 합성/재생과 동시에 다음 청크 mp3를 백그라운드로 미리 받아 캐시 적재.
        // 청크 전환 시점에는 캐시 hit으로 즉시 재생 → 두 번째 청크부터 0.5~2초 딜레이 제거.
        // 첫 청크만 어쩔 수 없이 합성 시간 발생.
        const userVoiceId = getCachedVoiceId();
        if (isEdgeVoiceId(userVoiceId)) {
          const edgeRate = 1.2; // 고정 SSML rate — 배속 무관 단일 캐시
          for (let k = 1; k <= 2; k++) {
            const nextIdx = i + k;
            if (nextIdx >= chunks.length) break;
            const nextChunk = chunks[nextIdx];
            getOrFetchEdgeMp3(nextChunk, userVoiceId, edgeRate).catch(() => { /* prefetch 실패 무시 */ });
          }
        }

        if (Platform.OS === 'web') {
          ttsSpeak(chunk, { rate: 0.95 * lockedRate, onEnd: fire, chained });
          // Edge voice일 때는 expo-av 재생 상태를, 아니면 SpeechSynthesis.speaking을 폴링
          const useEdgePollWeb = isEdgeVoiceId(getCachedVoiceId());
          if (useEdgePollWeb) {
            let sawSpeaking = false;
            pollHandle = setInterval(() => {
              if (fired || stale()) { stopPolling(); return; }
              isEdgeTtsPlaying().then((speaking) => {
                if (fired || stale()) return;
                if (!sawSpeaking && speaking) {
                  sawSpeaking = true;
                  onAudioPlaying?.(); // 부모: 배너 해제
                }
                if (sawSpeaking && !speaking) { fire(); return; }
                // Edge는 mp3 fetch 지연 가능 → 5초 timeout
                if (!sawSpeaking && Date.now() - startedAt > 5000) { fire(); return; }
              }).catch(() => {});
            }, 100);
          } else if (typeof window !== 'undefined' && window.speechSynthesis) {
            let sawSpeaking = false;
            pollHandle = setInterval(() => {
              if (fired || stale()) { stopPolling(); return; }
              const synth = window.speechSynthesis;
              // sawSpeaking은 실제 발화(speaking=true)일 때만 인정.
              // pending만 잡혔다 풀리는 짧은 순간에 fire가 트리거되어 첫 chunk가 스킵되던 문제 방지
              if (!sawSpeaking && synth.speaking) {
                sawSpeaking = true;
                onAudioPlaying?.(); // 부모: 배너 해제
              }
              // 발화 시작 후 끝남 감지(speaking과 pending 모두 false) → 즉시 다음 청크
              if (sawSpeaking && !synth.speaking && !synth.pending) { fire(); return; }
              // 2초가 지나도 발화 시작 안 됨 = 시작 실패로 간주
              if (!sawSpeaking && Date.now() - startedAt > 2000) { fire(); return; }
            }, 80);
          }
        } else {
          speak(chunk, 0.95 * lockedRate, fire, chained);
          // 네이티브 expo-speech/Edge TTS 모두 종료 콜백이 지연될 수 있어 폴링으로 보강
          // Edge voice는 isEdgeTtsPlaying(expo-av Sound 상태), OS voice는 Speech.isSpeakingAsync 사용
          const useEdgePoll = isEdgeVoiceId(getCachedVoiceId());
          let sawSpeaking = false;
          // Edge는 mp3 fetch에 시간이 걸려서 시작 timeout을 더 넉넉히
          const startTimeoutMs = useEdgePoll ? 5000 : 1500;
          pollHandle = setInterval(() => {
            if (fired || stale()) { stopPolling(); return; }
            const speakingPromise = useEdgePoll
              ? isEdgeTtsPlaying()
              : Speech.isSpeakingAsync();
            speakingPromise
              .then((speaking) => {
                if (fired || stale()) return;
                if (!sawSpeaking && speaking) {
                  sawSpeaking = true;
                  onAudioPlaying?.(); // 부모: 배너 해제
                }
                if (sawSpeaking && !speaking) { fire(); return; }
                if (!sawSpeaking && Date.now() - startedAt > startTimeoutMs) { fire(); return; }
              })
              .catch(() => {});
          }, 100);
        }
      } else {
        // TTS off: 글자수 기반 고정 타이머
        const dur = chunkDurationMs(chunk, false);
        timerRef.current = setTimeout(() => { if (!stale()) next(); }, dur);
      }
    };

    const advance = () => {
      if (stale()) return;
      const isLast = i >= chunks.length - 1;
      if (isLast) {
        proceed(() => onDone?.(), true);
      } else {
        proceed(() => {
          if (stale()) return;
          i++;
          setter(i);
          advance();
        }, false);
      }
    };
    advance();
  }

  function startFresh() {
    setIsDone(false);
    if (isQuiz) {
      setChunkIdx(0);
      setPhase('question');
      runChunks(
        questionChunks, 0, setChunkIdx,
        // 자연 종료라 synth는 이미 비어 있음 → ttsStop() 호출 금지.
        // (priming 등 큐에 남은 utterance까지 cancel되어 canceled 에러 + 무음 버그 유발했음)
        () => { setPhase('waiting'); },
      );
    } else {
      setChunkIdx(0);
      runChunks(
        scriptChunks, 0, setChunkIdx,
        () => setIsDone(true),
      );
    }
  }

  function resume() {
    const phase = phaseRef.current;
    if (isQuiz && phase === 'waiting') { startAnswer(); return; }

    if (isQuiz && phase === 'question') {
      const cur = chunkRef.current;
      if (cur === 0) { startFresh(); return; }
      clearTimer();
      runChunks(
        questionChunks, cur, setChunkIdx,
        // 자연 종료 시 synth는 비어 있음 → ttsStop 불필요
        () => { setPhase('waiting'); },
      );
    } else {
      const chunks = isQuiz ? answerChunks : scriptChunks;
      const cur = isQuiz ? ansChunkRef.current : chunkRef.current;
      const setter = isQuiz ? setAnsChunkIdx : setChunkIdx;
      if (cur === 0) { startFresh(); return; }
      clearTimer();
      runChunks(
        chunks, cur, setter,
        () => setIsDone(true),
      );
    }
  }

  function startAnswer() {
    setAnsChunkIdx(0);
    setIsDone(false);
    setPhase('answer');
    clearTimer();
    runChunks(
      answerChunks, 0, setAnsChunkIdx,
      () => setIsDone(true),
    );
  }

  // Edge 음성 mute 상태를 ttsEnabled와 동기화 (마운트 + 토글 시).
  // 토글 즉시 현재 재생 중인 mp3의 볼륨만 변경 → 위치 유지된 채 소리만 on/off.
  useEffect(() => {
    if (!isEdgeVoiceId(getCachedVoiceId())) return;
    setEdgeTtsMuted(!ttsEnabled);
  }, [ttsEnabled]);

  const prevTtsRef = useRef(ttsEnabled);
  useEffect(() => {
    const prev = prevTtsRef.current;
    prevTtsRef.current = ttsEnabled;
    if (!isActive) return;
    if (prev === ttsEnabled) return;
    // Edge 음성은 위 effect의 mute 토글만으로 처리하므로 재시작 불필요.
    if (isEdgeVoiceId(getCachedVoiceId())) return;
    // 그 외 음성(Web Speech / OS): 종전대로 재시작.
    // OFF 전환: 이미 발화 중인 TTS 중단. ON 전환: 현재 timer 모드 루프를 끊고 TTS 모드로 시작.
    ttsStop();
    clearTimer();
    if (!isPlaying) return;
    if (isQuiz && phaseRef.current === 'waiting') return;
    const chunks = isQuiz
      ? (phaseRef.current === 'answer' ? answerChunks : questionChunks)
      : scriptChunks;
    const idx = isQuiz
      ? (phaseRef.current === 'answer' ? ansChunkRef.current : chunkRef.current)
      : chunkRef.current;
    const setter = isQuiz
      ? (phaseRef.current === 'answer' ? setAnsChunkIdx : setChunkIdx)
      : setChunkIdx;
    const onDone =
      isQuiz && phaseRef.current === 'question'
        ? () => setPhase('waiting')
        : () => setIsDone(true);
    runChunks(chunks, idx, setter, onDone);
  }, [ttsEnabled]);

  // 배속 변경 시 동작:
  // - Edge: live playbackRate 변경으로 즉시 반영, 청크 재시작 없음.
  // - Web Speech / OS: utterance rate 라이브 변경 불가 → elapsed로 진행 위치 추정 후
  //   현재 청크의 *남은 부분*만 새 rate로 재발화 (이전엔 청크 처음부터 다시 읽어 흐름 끊김).
  const prevTtsRateRef = useRef(ttsRate);
  useEffect(() => {
    const prev = prevTtsRateRef.current;
    prevTtsRateRef.current = ttsRate;
    if (prev === ttsRate) return;
    if (!isActive || !isPlaying || !ttsEnabled) return;
    if (isQuiz && phaseRef.current === 'waiting') return;
    // Edge 음성: 현재 mp3의 playback rate만 보정 → 청크 재시작 없이 즉시 속도 변경.
    // mp3는 1.0 기준으로 합성·캐시되므로 다음 청크도 같은 캐시 사용 → rate 변경 후 즉시 재생.
    if (isEdgeVoiceId(getCachedVoiceId())) {
      setEdgePlaybackRate(ttsRate); // proceed가 다음 청크에 0.95*lockedRate를 넘기지만, 라이브 변경이라 user rate 그대로 사용
      return;
    }
    // 그 외(Web Speech / OS): rate 라이브 변경 불가 → 현재 청크에서 elapsed 측정 후 남은 부분만 발화.
    ttsStop();
    clearTimer();
    const chunks = isQuiz
      ? (phaseRef.current === 'answer' ? answerChunks : questionChunks)
      : scriptChunks;
    const idx = isQuiz
      ? (phaseRef.current === 'answer' ? ansChunkRef.current : chunkRef.current)
      : chunkRef.current;
    const setter = isQuiz
      ? (phaseRef.current === 'answer' ? setAnsChunkIdx : setChunkIdx)
      : setChunkIdx;
    const onDone =
      isQuiz && phaseRef.current === 'question'
        ? () => setPhase('waiting')
        : () => setIsDone(true);

    const currentChunk = chunks[idx];
    const chunkStartedAt = chunkStartedAtRef.current;
    // 청크 시작 후 elapsed로 위치 추정. synth/시작 지연을 감안해 150ms는 빼서 조금 적게 스킵
    const SYNTH_LATENCY_MS = 150;
    const elapsedMs = chunkStartedAt > 0 ? Math.max(0, Date.now() - chunkStartedAt - SYNTH_LATENCY_MS) : 0;
    const expectedWallMs = currentChunk ? chunkDurationMs(currentChunk, true) / prev : 0;
    // 너무 끝에 가까우면 (>85%) 차라리 다음 청크로: 한두 음절만 다시 듣는 어색함 회피
    const SKIP_THRESHOLD = 0.85;
    const ratio = expectedWallMs > 0 ? elapsedMs / expectedWallMs : 0;

    if (!currentChunk || elapsedMs < 200 || ratio <= 0) {
      // 시작 직후이거나 정보 부족 → 종전대로 현재 청크 처음부터 재시작
      runChunks(chunks, idx, setter, onDone);
      return;
    }

    if (ratio >= SKIP_THRESHOLD) {
      // 거의 끝났음 → 다음 청크로 진행
      if (idx + 1 < chunks.length) {
        runChunks(chunks, idx + 1, setter, onDone);
      } else {
        onDone?.();
      }
      return;
    }

    // 추정 위치 → 한국어 친화 경계(공백/쉼표/마침표 등)로 스냅 후 남은 부분 발화
    const rawSplit = Math.floor(currentChunk.length * Math.min(0.95, ratio));
    const split = snapToBoundary(currentChunk, rawSplit);
    const remaining = currentChunk.slice(split).trim();
    if (!remaining) {
      if (idx + 1 < chunks.length) runChunks(chunks, idx + 1, setter, onDone);
      else onDone?.();
      return;
    }
    // 현재 청크만 잘라낸 사본으로 runChunks → 남은 부분 발화 후 다음 청크는 원본 그대로 진행
    const patched = chunks.slice();
    patched[idx] = remaining;
    runChunks(patched, idx, setter, onDone);
  }, [ttsRate]);

  useEffect(() => { return () => { clearTimer(); ttsStop(); }; }, []);

  const prevRef = useRef({ active: false, playing: false });

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { active: isActive, playing: isPlaying };

    if (!isActive) {
      if (prev.active) {
        glowLoopRef.current?.stop();
        clearTimer();
        ttsStop();
        setChunkIdx(0);
        setAnsChunkIdx(0);
        setPhase('question');
        setIsDone(false);
        setOxUserAnswer(null);
        setExampleResult(null);
        fadeAnim.setValue(0);
        slideAnim.setValue(30);
        glowAnim.setValue(0.3);
      }
      return;
    }

    if (!prev.active && isActive) {
      // 자막은 첫 청크부터 즉시 보이도록 visible 상태로 리셋
      subOpacity.setValue(1);
      subScale.setValue(1);
      subTranslateY.setValue(0);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: USE_NATIVE_DRIVER }),
        Animated.timing(slideAnim, { toValue: 0, duration: 500, useNativeDriver: USE_NATIVE_DRIVER }),
      ]).start();
      glowLoopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 0.7, duration: 2000, useNativeDriver: USE_NATIVE_DRIVER }),
          Animated.timing(glowAnim, { toValue: 0.3, duration: 2000, useNativeDriver: USE_NATIVE_DRIVER }),
        ])
      );
      glowLoopRef.current.start();
      if (!ttsEnabled || isPlaying) startFresh();
      return;
    }

    if (isPlaying && !prev.playing) resume();
    else if (!isPlaying && prev.playing) { clearTimer(); ttsStop(); }
  }, [isActive, isPlaying]);

  const handleReveal = () => {
    startAnswer();
    if (!isPlaying) onPlayPause();
  };

  function handleReplay() {
    clearTimer();
    ttsStop();
    setIsDone(false);
    setOxUserAnswer(null);
    setExampleResult(null);
    setChunkIdx(0); setAnsChunkIdx(0); setPhase('question');

    if (isQuiz) {
      runChunks(
        questionChunks, 0, setChunkIdx,
        // 자연 종료 시 synth는 비어 있음 → ttsStop 불필요
        () => { setPhase('waiting'); },
      );
    } else {
      runChunks(
        scriptChunks, 0, setChunkIdx,
        () => setIsDone(true),
      );
    }
    if (!isPlaying) onPlayPause();
  }

  const handlePlayPause = () => {
    onPlayPause();
  };

  // 다음 문장(청크)으로 스킵: 현재 청크 TTS 중단 + 다음 청크부터 runChunks 재시작.
  // 마지막 청크면 isDone(또는 quiz 대기 단계)로 종료.
  function skipToNextChunk() {
    if (!isActive) return;
    if (isDone) return;
    // 퀴즈 정답 대기 중에는 스킵 의미 없음 (사용자가 답을 골라야 진행)
    if (isQuiz && phaseRef.current === 'waiting') return;

    const inAnswerPhase = isQuiz && phaseRef.current === 'answer';
    const inQuestionPhase = isQuiz && phaseRef.current === 'question';
    const chunks = inAnswerPhase ? answerChunks : inQuestionPhase ? questionChunks : scriptChunks;
    const curIdx = inAnswerPhase ? ansChunkRef.current : chunkRef.current;
    const setter = inAnswerPhase ? setAnsChunkIdx : setChunkIdx;
    const next = curIdx + 1;

    ttsStop();
    clearTimer();

    if (next >= chunks.length) {
      // 마지막 청크: 자연 종료와 동일하게 처리
      if (inQuestionPhase) setPhase('waiting');
      else setIsDone(true);
      return;
    }

    const onDone =
      inQuestionPhase ? () => setPhase('waiting') : () => setIsDone(true);
    runChunks(chunks, next, setter, onDone);
  }

  // 이전 문장(청크)으로 이동: 현재 청크가 0이면 그대로, 아니면 -1로 이동.
  // quiz의 answer phase에서 0번째 청크라면 question 마지막 청크로 되돌아감.
  function skipToPrevChunk() {
    if (!isActive) return;
    if (isQuiz && phaseRef.current === 'waiting') return;

    const inAnswerPhase = isQuiz && phaseRef.current === 'answer';
    const inQuestionPhase = isQuiz && phaseRef.current === 'question';

    ttsStop();
    clearTimer();
    setIsDone(false);

    if (inAnswerPhase) {
      const cur = ansChunkRef.current;
      if (cur > 0) {
        runChunks(answerChunks, cur - 1, setAnsChunkIdx, () => setIsDone(true));
      } else {
        // answer 0번째에서 이전 → question 마지막 청크로 되돌아감
        const lastQ = Math.max(0, questionChunks.length - 1);
        setAnsChunkIdx(0);
        setPhase('question');
        runChunks(questionChunks, lastQ, setChunkIdx, () => setPhase('waiting'));
      }
      return;
    }

    const chunks = inQuestionPhase ? questionChunks : scriptChunks;
    const setter = inQuestionPhase ? setChunkIdx : setChunkIdx;
    const cur = chunkRef.current;
    const target = Math.max(0, cur - 1);
    const onDone = inQuestionPhase ? () => setPhase('waiting') : () => setIsDone(true);
    runChunks(chunks, target, setter, onDone);
  }

  // 부모(player)에 skip / prev 함수 노출
  useEffect(() => {
    if (skipRef) skipRef.current = skipToNextChunk;
    if (prevSentenceRef) prevSentenceRef.current = skipToPrevChunk;
    return () => {
      if (skipRef && skipRef.current === skipToNextChunk) skipRef.current = null;
      if (prevSentenceRef && prevSentenceRef.current === skipToPrevChunk) prevSentenceRef.current = null;
    };
  });

  // 현재 표시할 자막
  const currentChunk = isQuiz
    ? quizPhase === 'answer'
      ? (answerChunks[ansChunkIdx] ?? '')
      : (questionChunks[chunkIdx] ?? '')
    : (scriptChunks[chunkIdx] ?? '');

  // 이미지 인덱스: 청크 3개마다 다음 이미지로 전환
  const globalChunkPos = isQuiz
    ? quizPhase === 'answer' ? questionChunks.length + ansChunkIdx : chunkIdx
    : chunkIdx;
  const imgArr = bgImageUrls ?? [];
  // 청크(≈문장) 1~2개마다 다음 이미지로 전환, Ken Burns 9초 사이클과 어우러져 자연스럽게.
  const CHUNKS_PER_IMAGE = 1;
  const currentImageUrl = imgArr.length > 0
    ? imgArr[Math.floor(globalChunkPos / CHUNKS_PER_IMAGE) % imgArr.length]
    : null;
  const hasImage = !!currentImageUrl;

  // 다음 청크에서 표시될 이미지를 미리 OS 캐시에 적재: 청크 전환 시 깜빡임/리로드 방지.
  // mp3 prefetch와 동일한 결로 한두 칸 앞을 선반영.
  useEffect(() => {
    if (imgArr.length <= 1) return;
    const curImgIdx = Math.floor(globalChunkPos / CHUNKS_PER_IMAGE) % imgArr.length;
    for (let k = 1; k <= 2; k++) {
      const idx = (curImgIdx + k) % imgArr.length;
      if (idx === curImgIdx) break; // 배열 1개뿐인 경우 안전
      Image.prefetch(imgArr[idx]).catch(() => {});
    }
  }, [globalChunkPos, imgArr]);

  // 이미지 변경 시 Ken Burns 효과 재시작
  useEffect(() => {
    if (!currentImageUrl) return;
    kenBurnsScale.setValue(1);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(kenBurnsScale, { toValue: 1.08, duration: 9000, useNativeDriver: USE_NATIVE_DRIVER }),
        Animated.timing(kenBurnsScale, { toValue: 1, duration: 9000, useNativeDriver: USE_NATIVE_DRIVER }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [currentImageUrl]);

  // 진행바 전체 길이는 question + answer 합산으로 고정. question phase에서 절반까지만 차고,
  // answer phase로 넘어가면 그 뒤를 채워나가는 일관된 진행. 이전엔 phase 전환 시 totalChunks가 갑자기 늘어났음.
  const totalChunks = isQuiz
    ? questionChunks.length + answerChunks.length
    : scriptChunks.length;
  const curChunkProgress = isQuiz
    ? quizPhase === 'answer' ? questionChunks.length + ansChunkIdx + 1 : chunkIdx + 1
    : chunkIdx + 1;
  const progress = isDone ? 1 : (totalChunks > 0 ? curChunkProgress / totalChunks : 0);

  const isSpeaking = ttsEnabled && isActive && isPlaying && quizPhase !== 'waiting';
  const showButtons = isDone || (isQuiz && quizPhase === 'waiting');

  return (
    <View style={styles.card} {...(panHandlers ?? {})}>
      {/* 단색 배경 */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0A0A0A' }]} />

      {/* TOP 1/5: TITLE (가운데 정렬) */}
      <View style={[styles.topSection, { paddingTop: Math.max(20, topInset + 12) }]}>
        <Animated.View style={[styles.topInner, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
          <View style={styles.typeBadgeRow}>
            <View style={[styles.typeBadge, { backgroundColor: cfg.accent + '20', borderColor: cfg.accent + '60' }]}>
              <Ionicons name={cfg.icon} size={11} color={cfg.color} />
              <Text style={[styles.typeLabel, { color: cfg.color }]}>{cfg.label}</Text>
              {isSpeaking && (
                <View style={styles.dots}>
                  {[0, 1, 2].map((i) => <Dot key={i} color={cfg.color} delay={i * 180} />)}
                </View>
              )}
            </View>
            {wrongRecord && (
              <View style={styles.wrongChipRow}>
                <View style={styles.wrongChip}>
                  <Ionicons name="close-circle" size={11} color="#EF4444" />
                  <Text style={[styles.wrongChipText, { color: '#EF4444' }]}>
                    {wrongAgoLabel(wrongRecord.lastWrongAt ?? wrongRecord.wrongAt)}
                  </Text>
                </View>
                {(wrongRecord.correctStreak ?? 0) >= 1 && wrongRecord.nextReviewAt && (
                  <View style={styles.wrongChip}>
                    <Ionicons name="time-outline" size={11} color="#22C55E" />
                    <Text style={[styles.wrongChipText, { color: '#22C55E' }]}>
                      {nextReviewLabel(wrongRecord.nextReviewAt)}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
          <Text style={styles.titleText} numberOfLines={3}>
            {titleParts.prefix ? (
              <>
                <Text style={[styles.titlePrefix, { color: cfg.color }]}>{titleParts.prefix} </Text>
                <Text style={styles.titleMain}>{titleParts.rest}</Text>
              </>
            ) : (
              <Text style={styles.titleMain}>{titleParts.rest}</Text>
            )}
          </Text>
        </Animated.View>
      </View>

      {/* MIDDLE 3/5: IMAGE + SUBTITLE */}
      <View style={styles.middleSection}>
        <View style={styles.imageWrap}>
          {hasImage ? (
            <Animated.View
              key={currentImageUrl}
              style={[StyleSheet.absoluteFill, { transform: [{ scale: kenBurnsScale }] }]}
            >
              <Image
                source={{ uri: currentImageUrl! }}
                style={StyleSheet.absoluteFill}
                resizeMode="cover"
              />
            </Animated.View>
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.imagePlaceholder, { backgroundColor: cfg.accent + '12' }]}>
              <Ionicons name={cfg.icon} size={70} color={cfg.accent + '50'} />
            </View>
          )}

          {/* 가독성 어두운 오버레이 */}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} pointerEvents="none" />

          {/* 자막 (인터랙션 버튼 없을 때만, 영상 중앙) */}
          {!showButtons && currentChunk ? (
            <Animated.View
              style={[
                styles.subtitleArea,
                {
                  opacity: subOpacity,
                  transform: [
                    { scale: subScale },
                    { translateY: subTranslateY },
                  ],
                },
              ]}
              pointerEvents="none"
            >
              <Text
                style={[
                  styles.subtitleText,
                  quizPhase === 'answer' && { color: cfg.color },
                ]}
                // 한국어 단어 단위로 줄바꿈 (음절 중간에서 끊기 방지)
                lineBreakStrategyIOS="hangul-word"
                textBreakStrategy="simple"
              >
                {currentChunk}
              </Text>
            </Animated.View>
          ) : null}

          {/* 정답/오답 결과 배너: 모든 quiz 모드 공통 (OX/MCQ/Fillblank). answer phase 진입과 동시에 표시. */}
          {(() => {
            if (quizPhase !== 'answer' || !isQuiz || item.type !== 'quiz') return null;
            let isCorrect: boolean | null = null;
            if (quizMode === 'ox' && oxUserAnswer !== null && correctOXAnswer !== null) {
              isCorrect = oxUserAnswer === correctOXAnswer;
            } else if (quizMode === 'mcq' && mcqUserAnswer !== null && item.answerIndex !== undefined) {
              isCorrect = mcqUserAnswer === item.answerIndex;
            } else if (quizMode === 'fillblank' && fillSubmitted !== null) {
              isCorrect = fillSubmitted;
            }
            if (isCorrect === null) return null;
            return (
              <View pointerEvents="none" style={styles.oxResultBannerWrap}>
                <View style={[styles.oxResultBannerLarge, {
                  backgroundColor: isCorrect ? '#22C55ECC' : '#EF4444CC',
                  borderColor: isCorrect ? '#22C55E' : '#EF4444',
                }]}>
                  <Ionicons name={isCorrect ? 'checkmark-circle' : 'close-circle'} size={28} color="#fff" />
                  <Text style={styles.oxResultTextLarge}>
                    {isCorrect ? '정답입니다!' : '오답입니다!'}
                  </Text>
                </View>
              </View>
            );
          })()}

          {/* 인터랙션 버튼 */}
          {showButtons && (
            <View style={styles.middleActions}>
              {/* isDone + 틀린 상태 + 부모 concept 존재 시: "개념 보러가기" 버튼 (메인 액션 위에 같은 컨테이너 안 세로 배치) */}
              {isDone && isWrong && onNavigateToParent && (
                <TouchableOpacity
                  style={[styles.ppBtn, { borderColor: '#5DAEF5', backgroundColor: '#5DAEF520' }]}
                  onPress={onNavigateToParent}
                >
                  <Ionicons name="bulb-outline" size={14} color="#5DAEF5" />
                  <Text style={[styles.ppText, { color: '#5DAEF5' }]}>개념 보러가기</Text>
                </TouchableOpacity>
              )}
              {isDone && item.type === 'example' && quizPhase === 'answer' && exampleResult === null ? (
                <View style={styles.exampleJudgeRow}>
                  <TouchableOpacity style={[styles.exampleJudgeBtn, { borderColor: '#22C55E', backgroundColor: '#22C55E18' }]} onPress={() => { setExampleResult('correct'); awardXpForCurrentUser('example_correct'); recordActivity('example'); onCorrectAnswer?.(); }}>
                    <Ionicons name="checkmark-circle-outline" size={18} color="#22C55E" />
                    <Text style={[styles.exampleJudgeText, { color: '#22C55E' }]}>맞았어요</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.exampleJudgeBtn, { borderColor: '#EF4444', backgroundColor: '#EF444418' }]} onPress={() => { setExampleResult('wrong'); onWrongAnswer?.(item.content.title, item.content.script); recordActivity('example'); }}>
                    <Ionicons name="close-circle-outline" size={18} color="#EF4444" />
                    <Text style={[styles.exampleJudgeText, { color: '#EF4444' }]}>틀렸어요</Text>
                  </TouchableOpacity>
                </View>
              ) : isDone && item.type === 'example' && exampleResult !== null ? (
                <TouchableOpacity style={[styles.ppBtn, { borderColor: cfg.accent + '80', backgroundColor: cfg.accent + '20' }]} onPress={handleReplay}>
                  <Ionicons name="refresh" size={14} color={cfg.color} />
                  <Text style={[styles.ppText, { color: cfg.color }]}>다시 재생</Text>
                </TouchableOpacity>
              ) : isDone ? (
                <TouchableOpacity style={[styles.ppBtn, { borderColor: cfg.accent + '80', backgroundColor: cfg.accent + '20' }]} onPress={handleReplay}>
                  <Ionicons name="refresh" size={14} color={cfg.color} />
                  <Text style={[styles.ppText, { color: cfg.color }]}>다시 재생</Text>
                </TouchableOpacity>
              ) : isQuiz && quizPhase === 'waiting' && item.type === 'quiz' && quizMode === 'ox' ? (
                <View style={styles.quizCardLight}>
                  <Text style={styles.quizCardModeLabel}>O / X</Text>
                  <View style={styles.oxRow}>
                    {(['O', 'X'] as const).map((choice) => (
                      <TouchableOpacity
                        key={choice}
                        style={[
                          styles.oxBtnLight,
                          { borderColor: choice === 'O' ? '#1fa672' : '#e54b4b' },
                        ]}
                        onPress={() => {
                          setOxUserAnswer(choice);
                          handleReveal();
                          recordActivity('quiz');
                          if (correctOXAnswer !== null) {
                            if (choice === correctOXAnswer) {
                              awardXpForCurrentUser('quiz_correct');
                              onCorrectAnswer?.();
                            } else {
                              onWrongAnswer?.(item.content.title, item.content.script);
                            }
                          }
                        }}
                      >
                        <Text style={[styles.oxBtnTextLight, { color: choice === 'O' ? '#1fa672' : '#e54b4b' }]}>{choice}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              ) : isQuiz && quizPhase === 'waiting' && item.type === 'quiz' && quizMode === 'mcq' && item.choices ? (
                <View style={styles.quizCardLight}>
                  <Text style={styles.quizCardModeLabel}>객관식</Text>
                  <View style={{ gap: 8 }}>
                    {item.choices.map((opt, idx) => {
                      const letter = String.fromCharCode(65 + idx); // A B C D
                      return (
                        <TouchableOpacity
                          key={idx}
                          style={styles.mcqOptionRow}
                          onPress={() => {
                            setMcqUserAnswer(idx);
                            handleReveal();
                            recordActivity('quiz');
                            const correct = item.answerIndex === idx;
                            if (correct) {
                              awardXpForCurrentUser('quiz_correct');
                              onCorrectAnswer?.();
                            } else {
                              onWrongAnswer?.(item.content.title, item.content.script);
                            }
                          }}
                        >
                          <View style={styles.mcqOptLetter}>
                            <Text style={styles.mcqOptLetterText}>{letter}</Text>
                          </View>
                          <Text style={styles.mcqOptText} numberOfLines={3}>{opt}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ) : isQuiz && quizPhase === 'waiting' && item.type === 'quiz' && quizMode === 'fillblank' ? (
                <View style={styles.quizCardLight}>
                  <Text style={styles.quizCardModeLabel}>빈칸 채우기 · 단답형</Text>
                  <TextInput
                    style={styles.fillInput}
                    value={fillUserInput}
                    onChangeText={setFillUserInput}
                    placeholder="정답 입력..."
                    placeholderTextColor="#82869a"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                    onSubmitEditing={() => {
                      if (!fillUserInput.trim() || fillSubmitted !== null) return;
                      const correct = isFillblankCorrect(fillUserInput, item.blankAnswer ?? '');
                      setFillSubmitted(correct);
                      handleReveal();
                      recordActivity('quiz');
                      if (correct) { awardXpForCurrentUser('quiz_correct'); onCorrectAnswer?.(); }
                      else { onWrongAnswer?.(item.content.title, item.content.script); }
                    }}
                  />
                  <TouchableOpacity
                    style={[styles.fillSubmitBtn, !fillUserInput.trim() && { opacity: 0.4 }]}
                    disabled={!fillUserInput.trim() || fillSubmitted !== null}
                    onPress={() => {
                      const correct = isFillblankCorrect(fillUserInput, item.blankAnswer ?? '');
                      setFillSubmitted(correct);
                      handleReveal();
                      recordActivity('quiz');
                      if (correct) { awardXpForCurrentUser('quiz_correct'); onCorrectAnswer?.(); }
                      else { onWrongAnswer?.(item.content.title, item.content.script); }
                    }}
                  >
                    <Ionicons name="checkmark" size={16} color="#fafbff" />
                    <Text style={styles.fillSubmitText}>확인</Text>
                  </TouchableOpacity>
                </View>
              ) : isQuiz && quizPhase === 'waiting' ? (
                <TouchableOpacity style={[styles.revealBtn, { backgroundColor: cfg.accent + '25', borderColor: cfg.accent + 'CC' }]} onPress={handleReveal}>
                  <Ionicons name="eye-outline" size={16} color={cfg.color} />
                  <Text style={[styles.revealText, { color: cfg.color }]}>{revealLabel}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}
        </View>
      </View>

      {/* BOTTOM 1/5: SUBJECT (해시태그 제거) */}
      <View style={[styles.bottomSection, { paddingBottom: Math.max(36, bottomInset + 24) }]}>
        <Animated.View style={[styles.bottomInner, { opacity: fadeAnim }]}>
          {subject ? (
            <View style={styles.subjectRow}>
              <Ionicons name="library" size={16} color={cfg.color} />
              <Text style={[styles.subjectText, { color: cfg.color }]} numberOfLines={1}>{subject}</Text>
            </View>
          ) : null}
        </Animated.View>
      </View>

      {/* 진행바: TTS 켜져있을 때만 표시 (꺼두면 별도 시간 표시 불필요) */}
      {ttsEnabled && (
        <View style={[styles.progressBg, { bottom: Math.max(0, bottomInset) }]}>
          <View style={[styles.progressFill, { backgroundColor: cfg.color, width: `${Math.round(progress * 100)}%` }]} />
        </View>
      )}
    </View>
  );
}

function Dot({ color, delay }: { color: string; delay: number }) {
  const a = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(a, { toValue: 1, duration: 350, useNativeDriver: USE_NATIVE_DRIVER }),
        Animated.timing(a, { toValue: 0.3, duration: 350, useNativeDriver: USE_NATIVE_DRIVER }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  return <Animated.View style={[styles.dot, { backgroundColor: color, opacity: a }]} />;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 세로 볼륨 페이더: drag/tap으로 0..1 조절. 모듈 스코프로 두어 부모 재렌더 시 unmount/remount 방지.
function VolumeFader({ value, onChange, color }: { value: number; onChange: (v: number) => void; color: string }) {
  const TRACK_HEIGHT = 110;
  const trackRef = useRef<View>(null);
  const trackTopRef = useRef(0);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const measureTrack = useCallback(() => {
    trackRef.current?.measureInWindow((_x, y) => { trackTopRef.current = y; });
  }, []);
  const updateFromY = useCallback((pageY: number) => {
    const localY = pageY - trackTopRef.current;
    const pct = 1 - Math.max(0, Math.min(TRACK_HEIGHT, localY)) / TRACK_HEIGHT;
    onChangeRef.current(pct);
  }, []);

  const pan = useRef(
    PanResponder.create({
      // capture 단계에서 먼저 잡아 부모(container)의 swipe pan responder가 발동하지 않게 한다.
      // 이렇게 안 하면 페이더에서 시작한 세로 드래그가 쇼츠 넘김으로 전환되는 문제 발생.
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => { measureTrack(); updateFromY(e.nativeEvent.pageY); },
      onPanResponderMove: (e) => { updateFromY(e.nativeEvent.pageY); },
    })
  ).current;

  const fillPct = Math.round(value * 100);
  return (
    <View style={styles.faderWrap}>
      {/* 알약(pill) 컨테이너: 다른 사이드 버튼과 톤 통일. 안에 hit area + 트랙 */}
      <View style={styles.faderPill}>
        <View style={styles.faderHitArea} {...pan.panHandlers}>
          <View
            ref={trackRef}
            onLayout={measureTrack}
            style={[styles.faderTrack, { height: TRACK_HEIGHT }]}
          >
            <View style={[styles.faderFill, { height: `${fillPct}%` as any, backgroundColor: color }]} />
            <View style={[styles.faderKnob, { bottom: `${fillPct}%` as any, borderColor: color }]} />
          </View>
        </View>
      </View>
      <Text style={styles.faderLabel}>{fillPct}</Text>
    </View>
  );
}

// 전체 셔플 진입 시 옵션 선택 (중요도 + 폴더·프로젝트 선택)
function ShuffleOptionsScreen({
  onStart,
  onClose,
}: {
  onStart: (cfg: { minImportance: number; selectedProjectIds: string[] }) => void;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [folders, setFolders] = useState<{ id: string; title: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; title: string; folderId: string | null; excludeFromShuffle: boolean }[]>([]);
  const [minImp, setMinImp] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 프로젝트별 쇼츠 (importance 배열): 시작 버튼 카운트 + importance 필터 적용용
  const [shortformsByProject, setShortformsByProject] = useState<Record<string, number[]>>({});

  const IMP_OPTIONS = [
    { value: 1, label: '모든 쇼츠 포함' },
    { value: 5, label: '별 5개 이상' },
    { value: 7, label: '별 7개 이상' },
    { value: 9, label: '별 9개 이상' },
  ];

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const [fSnap, pSnap, sfSnap] = await Promise.all([
          getDocs(query(collection(db, 'folders'), where('userId', '==', user.uid))),
          getDocs(query(collection(db, 'projects'), where('userId', '==', user.uid))),
          getDocs(query(collection(db, 'shortforms'), where('userId', '==', user.uid))),
        ]);
        const fList = fSnap.docs
          .map((d) => ({ id: d.id, title: (d.data() as any).title ?? '' }))
          .sort((a, b) => a.title.localeCompare(b.title));
        const pList = pSnap.docs
          .map((d) => ({
            id: d.id,
            title: (d.data() as any).title ?? '',
            folderId: (d.data() as any).folderId ?? null,
            excludeFromShuffle: (d.data() as any).excludeFromShuffle === true,
          }))
          .sort((a, b) => a.title.localeCompare(b.title));
        // 프로젝트별 importance 배열 (importance 필터 반영한 정확한 쇼츠 카운트 계산)
        const byProj: Record<string, number[]> = {};
        sfSnap.docs.forEach((d) => {
          const data = d.data() as any;
          const pid = data.projectId;
          if (!pid) return;
          const imp = typeof data.importance === 'number' ? data.importance : 5;
          (byProj[pid] = byProj[pid] ?? []).push(imp);
        });
        setFolders(fList);
        setProjects(pList);
        setShortformsByProject(byProj);
        // 기본 선택: "전체 셔플 제외" 표시 안 된 프로젝트들
        setSelected(new Set(pList.filter((p) => !p.excludeFromShuffle).map((p) => p.id)));
      } finally {
        setLoaded(true);
      }
    })();
  }, [user]);

  // 시작 시 실제 재생될 쇼츠 수 (선택된 프로젝트 ∩ importance 필터)
  const selectedShortformCount = useMemo(() => {
    let count = 0;
    selected.forEach((pid) => {
      const imps = shortformsByProject[pid];
      if (!imps) return;
      count += imps.filter((imp) => imp >= minImp).length;
    });
    return count;
  }, [selected, shortformsByProject, minImp]);

  const grouped = useMemo(() => {
    const m: Record<string, typeof projects> = { __none__: [] };
    folders.forEach((f) => { m[f.id] = []; });
    projects.forEach((p) => {
      const key = p.folderId && m[p.folderId] ? p.folderId : '__none__';
      m[key].push(p);
    });
    return m;
  }, [folders, projects]);

  const toggleProject = (pid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  };

  const toggleFolder = (folderKey: string) => {
    const ids = (grouped[folderKey] ?? []).map((p) => p.id);
    if (ids.length === 0) return;
    const allOn = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(projects.map((p) => p.id)));
  const selectNone = () => setSelected(new Set());

  const toggleExpand = (folderKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderKey)) next.delete(folderKey); else next.add(folderKey);
      return next;
    });
  };

  const renderFolderBlock = (folderKey: string, label: string, isUngrouped: boolean) => {
    const ps = grouped[folderKey] ?? [];
    if (ps.length === 0) return null;
    const selectedCount = ps.filter((p) => selected.has(p.id)).length;
    const allOn = selectedCount === ps.length;
    const someOn = selectedCount > 0 && !allOn;
    const isOpen = expanded.has(folderKey);
    return (
      <View key={folderKey} style={{ marginBottom: 6 }}>
        <View style={[shuffleOptStyles.folderRow, allOn && shuffleOptStyles.folderRowActive]}>
          {/* 폴더 본체: 탭 시 펼침/접힘 */}
          <TouchableOpacity
            style={shuffleOptStyles.folderRowBody}
            onPress={() => toggleExpand(folderKey)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isUngrouped ? 'ellipsis-horizontal' : (isOpen ? 'folder-open' : 'folder')}
              size={16}
              color={allOn ? '#4F8EF7' : '#888'}
            />
            <Text style={[shuffleOptStyles.folderLabel, allOn && { color: '#fff' }]} numberOfLines={1}>
              {label}
            </Text>
            <Text style={shuffleOptStyles.folderCount}>{selectedCount}/{ps.length}</Text>
            <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={16} color="#555" />
          </TouchableOpacity>
          {/* 체크박스: 탭 시 폴더 안 프로젝트 일괄 선택/해제 */}
          <TouchableOpacity
            style={shuffleOptStyles.folderCheckBtn}
            onPress={() => toggleFolder(folderKey)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={allOn ? 'checkbox' : someOn ? 'remove-circle' : 'square-outline'}
              size={20}
              color={allOn ? '#4F8EF7' : someOn ? '#F97316' : '#555'}
            />
          </TouchableOpacity>
        </View>
        {isOpen && ps.map((p) => {
          const on = selected.has(p.id);
          return (
            <TouchableOpacity
              key={p.id}
              style={[shuffleOptStyles.projectRow, on && shuffleOptStyles.projectRowActive]}
              onPress={() => toggleProject(p.id)}
            >
              <Ionicons
                name={on ? 'checkbox' : 'square-outline'}
                size={16}
                color={on ? '#4F8EF7' : '#555'}
              />
              <Text style={[shuffleOptStyles.projectText, on && { color: '#fff' }]} numberOfLines={1}>
                {p.title}
              </Text>
              {p.excludeFromShuffle && (
                <Ionicons name="eye-off" size={12} color="#F97316" />
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: 60, paddingHorizontal: 16, paddingBottom: 20 }]}>
      <View style={shuffleOptStyles.headerRow}>
        <TouchableOpacity onPress={onClose} hitSlop={10} style={shuffleOptStyles.backBtn}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Ionicons name="shuffle" size={22} color="#4F8EF7" />
        <Text style={shuffleOptStyles.title}>전체 셔플 옵션</Text>
      </View>

      <Text style={shuffleOptStyles.sectionLabel}>중요도</Text>
      <View style={{ gap: 6, marginBottom: 16 }}>
        {IMP_OPTIONS.map((opt) => {
          const active = minImp === opt.value;
          return (
            <TouchableOpacity
              key={opt.value}
              style={[shuffleOptStyles.optionRow, active && shuffleOptStyles.optionRowActive]}
              onPress={() => setMinImp(opt.value)}
            >
              <Ionicons
                name={opt.value === 1 ? 'apps-outline' : 'star'}
                size={16}
                color={active ? '#4F8EF7' : '#888'}
              />
              <Text style={[shuffleOptStyles.optionText, active && { color: '#fff', fontWeight: '700' }]}>
                {opt.label}
              </Text>
              {active && <Ionicons name="checkmark-circle" size={18} color="#4F8EF7" />}
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={shuffleOptStyles.sectionHeaderRow}>
        <Text style={shuffleOptStyles.sectionLabel}>학습 자료 선택</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={selectAll}><Text style={shuffleOptStyles.quickAction}>전체</Text></TouchableOpacity>
          <TouchableOpacity onPress={selectNone}><Text style={shuffleOptStyles.quickAction}>해제</Text></TouchableOpacity>
        </View>
      </View>

      {!loaded ? (
        <ActivityIndicator color="#4F8EF7" style={{ marginTop: 20 }} />
      ) : (
        <ScrollView
          style={{ flex: 1, marginBottom: 12 }}
          contentContainerStyle={{ paddingBottom: 12 }}
        >
          {folders.map((f) => renderFolderBlock(f.id, f.title, false))}
          {renderFolderBlock('__none__', '그룹 없음', true)}
        </ScrollView>
      )}

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <TouchableOpacity style={shuffleOptStyles.cancelBtn} onPress={onClose}>
          <Text style={shuffleOptStyles.cancelText}>취소</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[shuffleOptStyles.startBtn, selectedShortformCount === 0 && { opacity: 0.4 }]}
          disabled={selectedShortformCount === 0}
          onPress={() => onStart({ minImportance: minImp, selectedProjectIds: Array.from(selected) })}
        >
          <Ionicons name="play" size={16} color="#fff" />
          <Text style={shuffleOptStyles.startBtnText}>시작 ({selectedShortformCount}개)</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const shuffleOptStyles = StyleSheet.create({
  card: {
    backgroundColor: '#1A1A1A', borderRadius: 20, padding: 22,
    borderWidth: 1, borderColor: '#2A2A2A',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginRight: -4 },
  title: { color: '#fff', fontSize: 18, fontWeight: '800' },
  sectionLabel: { color: '#888', fontSize: 12, fontWeight: '700', marginBottom: 8 },
  sectionHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 8,
  },
  quickAction: { color: '#4F8EF7', fontSize: 12, fontWeight: '700' },
  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 12, backgroundColor: '#0D0D0D',
    borderWidth: 1, borderColor: '#2A2A2A',
  },
  optionRowActive: { borderColor: '#4F8EF7', backgroundColor: '#4F8EF715' },
  optionText: { flex: 1, color: '#aaa', fontSize: 14 },
  // 폴더 / 프로젝트 선택 행
  folderRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 4,
    borderRadius: 12, backgroundColor: '#0D0D0D',
    borderWidth: 1, borderColor: '#2A2A2A',
    marginBottom: 4,
  },
  folderRowBody: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8,
  },
  folderCheckBtn: { paddingHorizontal: 6, paddingVertical: 8 },
  folderRowActive: { borderColor: '#4F8EF755', backgroundColor: '#4F8EF712' },
  folderLabel: { flex: 1, color: '#bbb', fontSize: 14, fontWeight: '700' },
  folderCount: { color: '#666', fontSize: 11, fontWeight: '600' },
  projectRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingLeft: 32, paddingRight: 14, paddingVertical: 9,
    marginLeft: 4, marginBottom: 2, borderRadius: 8,
    backgroundColor: 'transparent',
  },
  projectRowActive: { backgroundColor: '#4F8EF710' },
  projectText: { flex: 1, color: '#888', fontSize: 13 },
  cancelBtn: { flex: 1, padding: 14, borderRadius: 12, backgroundColor: '#2A2A2A', alignItems: 'center' },
  cancelText: { color: '#888', fontWeight: '700' },
  startBtn: {
    flex: 2, padding: 14, borderRadius: 12, backgroundColor: '#4F8EF7',
    alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
  },
  startBtnText: { color: '#fff', fontWeight: '800' },
});

export default function PlayerScreen() {
  const { id, startIndex, shuffle: doShuffle, shortformId, ids, reviewIds, skipIntro } = useLocalSearchParams<{
    id: string; startIndex?: string; shuffle?: string; shortformId?: string; ids?: string; reviewIds?: string; skipIntro?: string;
  }>();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: winWidth } = useWindowDimensions();
  // 모바일은 600px 미만: 사이드 부가 버튼(속도/셔플)을 점 세개 메뉴로 묶음
  const isMobile = winWidth < 600;
  const [extraMenuOpen, setExtraMenuOpen] = useState(false);
  const studyStartRef = useRef<number>(0);
  // 활성 카드의 청크 이동 함수 ref. AnimatedCard가 매 렌더 자기 함수를 여기에 꽂아줌
  const skipChunkRef = useRef<(() => void) | null>(null);
  const prevChunkRef = useRef<(() => void) | null>(null);

  const [items, setItems] = useState<ShortForm[]>([]);
  // ids 모드(오답노트/정리노트 진입)에서는 items에 부모 concept이 빠져있을 수 있음.
  // 같은 projectId의 모든 concept을 별도로 fetch해서 lookup map 구성 → "개념 보러가기" 버튼이 항상 동작.
  const [conceptLookup, setConceptLookup] = useState<Record<string, ShortForm[]>>({});
  const [loading, setLoading] = useState(true);
  // 현재 사용자의 wrongAnswers를 shortformId → WrongAnswer 매핑으로. 카드에 "X일 전 틀림" 칩 표시용.
  const [wrongMap, setWrongMap] = useState<Map<string, WrongAnswer>>(new Map());
  // 전체 셔플 진입 시 별점·제외 포함 옵션 (모달에서 선택). null이면 아직 미선택 → 모달 표시.
  const isAllShuffleEntry = id === '__all__' && !ids && !shortformId;
  const [shuffleConfig, setShuffleConfig] = useState<{ minImportance: number; selectedProjectIds: string[] | null } | null>(
    isAllShuffleEntry ? null : { minImportance: 1, selectedProjectIds: null }
  );
  const [currentIndex, setCurrentIndex] = useState(parseInt(startIndex ?? '0'));
  const [isShuffle, setIsShuffle] = useState(doShuffle === '1');
  const [milestoneMsg, setMilestoneMsg] = useState('');
  // 첫 진입 시 자동 재생 안 함: 브라우저/iOS의 user-gesture 정책 때문에
  // 첫 청크 TTS가 silent fail하는 문제가 있어 시작 오버레이를 탭해야 재생 시작
  const [isPlaying, setIsPlaying] = useState(false);
  // skipIntro=1로 진입하면 인트로 카드 건너뛰고 바로 본 재생 (예: "개념 보러가기"로 단일 카드 진입)
  const [hasStarted, setHasStarted] = useState(skipIntro === '1');
  // not-allowed로 audio가 차단된 상태 → 사용자에게 명시적 클릭 받아서 재활성화
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [bgImages, setBgImages] = useState<Record<string, string[]>>({});
  const [projectMap, setProjectMap] = useState<Record<string, string>>({});
  const [folderMap, setFolderMap] = useState<Record<string, string>>({});
  // TTS는 항상 켜진 상태로 동작. 음소거가 필요하면 볼륨 페이더를 0으로 내려서 처리.
  const ttsEnabled = true;
  // TTS 페이더 볼륨 (0..1)
  const [ttsVolume, setTtsVolumeState] = useState<number>(ttsVolumeCache);
  useEffect(() => {
    AsyncStorage.getItem(TTS_VOLUME_KEY)
      .then((v: string | null) => {
        if (v === null) return;
        const n = parseFloat(v);
        if (Number.isFinite(n)) {
          const clamped = Math.max(0, Math.min(1, n));
          ttsVolumeCache = clamped;
          setTtsVolumeState(clamped);
          setEdgeTtsVolume(clamped);
        }
      })
      .catch(() => {});
  }, []);
  // 초기값 + 마운트 직후 라이브러리에 동기화 (디스크 로드 전에도 정상 동작)
  useEffect(() => {
    setEdgeTtsVolume(ttsVolume);
  }, [ttsVolume]);
  const changeVolume = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(1, next));
    setTtsVolumeState(clamped);
    ttsVolumeCache = clamped;
    setEdgeTtsVolume(clamped);
    AsyncStorage.setItem(TTS_VOLUME_KEY, String(clamped)).catch(() => {});
  }, []);

  // TTS 속도 (0.75 / 1.0 / 1.25 / 1.5 순환)
  const [ttsRate, setTtsRate] = useState<number>(ttsRateCache);
  useEffect(() => {
    AsyncStorage.getItem(TTS_RATE_KEY)
      .then((v: string | null) => {
        if (v === null) return;
        const n = parseFloat(v);
        if (Number.isFinite(n) && TTS_RATES.includes(n as any)) {
          ttsRateCache = n;
          setTtsRate(n);
        }
      })
      .catch(() => {});
  }, []);
  // 마이 탭에서 선택한 TTS 음성 ID: 모듈 캐시에 로드해서 ttsSpeak가 동기적으로 사용
  useEffect(() => { loadSavedVoiceId().catch(() => {}); }, []);
  const cycleTtsRate = useCallback(() => {
    setTtsRate((cur) => {
      const idx = TTS_RATES.indexOf(cur as any);
      const next = TTS_RATES[(idx + 1) % TTS_RATES.length];
      ttsRateCache = next;
      AsyncStorage.setItem(TTS_RATE_KEY, String(next)).catch(() => {});
      return next;
    });
  }, []);
  // 모바일 화면에서 cycle 방식이 불편 → 팝업으로 4 옵션 직접 선택
  const [ratePickerVisible, setRatePickerVisible] = useState(false);
  const pickTtsRate = useCallback((next: number) => {
    if (!(TTS_RATES as readonly number[]).includes(next)) return;
    setTtsRate(next);
    ttsRateCache = next;
    AsyncStorage.setItem(TTS_RATE_KEY, String(next)).catch(() => {});
    setRatePickerVisible(false);
  }, []);
  const [savedNoteIds, setSavedNoteIds] = useState<Set<string>>(new Set());
  // 이미 저장된 노트 ID 로드: 진입 시점 + 화면 포커스마다 새로 fetch.
  // useFocusEffect는 화면 진입/포커스 회복 시마다 실행되어 다른 화면에서 저장/삭제 후 돌아와도 동기화.
  useFocusEffect(
    useCallback(() => {
      if (!user) return;
      let alive = true;
      getStudyNotes(user.uid)
        .then((notes) => {
          if (!alive) return;
          setSavedNoteIds(new Set(notes.map((n) => n.shortformId)));
        })
        .catch((e) => { console.warn('[player] getStudyNotes failed', e); });
      return () => { alive = false; };
    }, [user])
  );
  const [saveToast, setSaveToast] = useState(false);
  const pendingSpeakRef = useRef<string | null>(null);
  const dotTranslateX = useRef(new Animated.Value(140 / 2 - 8 - parseInt(startIndex ?? '0') * 9)).current;

  // 모든 nav 경로(swipe/wheel/key/버튼)가 공통으로 쓰는 최소 시간 게이트.
  // 카드가 실제로 넘어간 시점에만 lock 시작 → 0.3초간 다음 nav 무시.
  // 경계(첫·마지막 카드)에서 무시된 nav 시도는 lock을 걸지 않아 의도하지 않은 차단 방지.
  const lastNavRef = useRef(0);
  const NAV_MIN_MS = 300;
  // 인트로 dismiss 후 일정 시간 동안 모든 navigate 차단: dismiss swipe와 같은 gesture가 만든 잔여 wheel/swipe 관성을 봉쇄.
  // hasStartedRef와 분리해서 wheel/swipe handler 자체 동작은 정상 흐름 유지.
  const navBlockedRef = useRef(false);
  // 한 카드를 시청 완료한 것으로 간주해 XP 지급한 카드 id 집합 (세션 내 dedup)
  const xpAwardedRef = useRef<Set<string>>(new Set());
  // "마지막 슬라이드까지 진행"한 카드 id 집합. AnimatedCard가 onReachedLastSlide로 채움.
  // dwell time 대신 이 기준으로 학습 인정·XP 적립.
  const reachedLastSlideRef = useRef<Set<string>>(new Set());

  const markReachedLastSlide = useCallback((id: string, type: 'concept' | 'example' | 'quiz') => {
    if (reachedLastSlideRef.current.has(id)) return;
    reachedLastSlideRef.current.add(id);
    if (xpAwardedRef.current.has(id)) return;
    xpAwardedRef.current.add(id);
    awardXpForCurrentUser('shortform_watched');
    if (type === 'concept') recordActivity('concept');
  }, []);

  const tryNavigate = useCallback((delta: 1 | -1) => {
    if (!hasStartedRef.current) return;
    if (navBlockedRef.current) return;
    const now = Date.now();
    if (now - lastNavRef.current < NAV_MIN_MS) return;
    const cur = currentIndexRef.current;
    const next = delta > 0
      ? Math.min(cur + 1, itemsRef.current.length - 1)
      : Math.max(cur - 1, 0);
    if (next === cur) return;
    lastNavRef.current = now;
    playOnNavRef.current = true;
    setCurrentIndex(next);
  }, []);

  // 최신 값을 키보드 핸들러 클로저에서 참조하기 위한 refs
  const itemsRef = useRef(items);
  const currentIndexRef = useRef(currentIndex);
  const userRef = useRef(user);
  const savedNoteIdsRef = useRef(savedNoteIds);

  useEffect(() => {
    studyStartRef.current = Date.now();
    return () => {
      const elapsed = Math.round((Date.now() - studyStartRef.current) / 1000);
      if (user && elapsed >= 3) addStudySeconds(user.uid, elapsed);
    };
  }, []);

  useEffect(() => {
    // __all__이면 user가 필요. 아직 로드 안 됐으면 대기 (user가 채워지면 다시 실행됨)
    if (id === '__all__' && !user) return;
    // 전체 셔플 진입: 사용자가 옵션을 선택할 때까지 로드 보류
    if (isAllShuffleEntry && shuffleConfig === null) return;
    const load = async () => {
      let data: ShortForm[];
      // ids 파라미터: 콤마 구분된 shortformId 목록 → 그 순서 그대로 로드 (오답/노트에서 진입)
      if (ids) {
        const idList = ids.split(',').filter(Boolean);
        // Firestore `in` 쿼리는 30개 제한 → 배치로 가져오기
        const batches: string[][] = [];
        for (let i = 0; i < idList.length; i += 30) batches.push(idList.slice(i, i + 30));
        const docMap = new Map<string, ShortForm>();
        await Promise.all(
          batches.map(async (batch) => {
            const snap = await getDocs(
              query(collection(db, 'shortforms'), where(documentId(), 'in', batch))
            );
            snap.docs.forEach((d) => docMap.set(d.id, { id: d.id, ...d.data() } as ShortForm));
          })
        );
        // 원래 ids 순서대로 정렬 (없는 건 제외)
        data = idList.map((id) => docMap.get(id)).filter((d): d is ShortForm => !!d);
      } else {
        // id === '__all__': 전체 사용자 숏폼
        // 그 외: id를 projectId로 간주하여 해당 프로젝트의 숏폼만 조회
        const q = id === '__all__' && user
          ? query(collection(db, 'shortforms'), where('userId', '==', user.uid))
          : query(collection(db, 'shortforms'), where('projectId', '==', id));
        const snap = await getDocs(q);
        data = snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as ShortForm))
          .sort((a, b) => a.order - b.order);

        // __all__ 모드: 옵션에 따라 필터링
        if (id === '__all__' && user) {
          // 중요도 임계 필터
          const minImp = shuffleConfig?.minImportance ?? 1;
          if (minImp > 1) {
            data = data.filter((sf) => (sf.importance ?? 5) >= minImp);
          }
          // 사용자가 모달에서 직접 선택한 프로젝트만 포함 (null이면 셔플 옵션 진입이 아닌 케이스 → 기본 excludeFromShuffle만 빼고)
          const selectedIds = shuffleConfig?.selectedProjectIds;
          if (selectedIds !== null && selectedIds !== undefined) {
            const allow = new Set(selectedIds);
            data = data.filter((sf) => !!sf.projectId && allow.has(sf.projectId as string));
          } else {
            try {
              const projSnap = await getDocs(query(collection(db, 'projects'), where('userId', '==', user.uid)));
              const excluded = new Set(
                projSnap.docs
                  .filter((d) => (d.data() as any).excludeFromShuffle === true)
                  .map((d) => d.id)
              );
              if (excluded.size > 0) {
                data = data.filter((sf) => !sf.projectId || !excluded.has(sf.projectId as string));
              }
            } catch { /* 무시 */ }
          }
        }
      }
      if (doShuffle === '1') {
        const concepts = shuffle(data.filter((d) => d.type === 'concept'));
        const examples = shuffle(data.filter((d) => d.type === 'example'));
        const quizzes  = shuffle(data.filter((d) => d.type === 'quiz'));
        data = [...concepts, ...examples, ...quizzes];
      }
      setItems(data);
      // 현재 사용자의 wrongAnswer 기록을 한번에 가져와서 shortformId 매핑: 카드 칩 표시용
      if (user) {
        getWrongAnswers(user.uid)
          .then((arr) => {
            const m = new Map<string, WrongAnswer>();
            arr.forEach((w) => m.set(w.shortformId, w));
            setWrongMap(m);
          })
          .catch(() => {});
      }
      // shortformId가 전달되면 해당 쇼츠 위치로 자동 이동 (학습 노트 등에서 진입)
      if (shortformId) {
        const idx = data.findIndex((d) => d.id === shortformId);
        if (idx >= 0) setCurrentIndex(idx);
        else setCurrentIndex((prev) => Math.min(prev, Math.max(0, data.length - 1)));
      } else {
        setCurrentIndex((prev) => Math.min(prev, Math.max(0, data.length - 1)));
      }
      setLoading(false);

      // 프로젝트명 미리 로드
      const projectIds = Array.from(new Set(
        data.map((d: any) => d.projectId).filter(Boolean) as string[]
      ));
      if (projectIds.length > 0) {
        const map: Record<string, string> = {};
        await Promise.all(projectIds.map(async (pid) => {
          try {
            const ps = await getDoc(doc(db, 'projects', pid));
            if (ps.exists()) map[pid] = (ps.data() as any).title ?? '';
          } catch {}
        }));
        setProjectMap(map);
      }

      // 폴더명 미리 로드: 하단 subject에 "폴더명 / 프로젝트명" 표시용
      const folderIds = Array.from(new Set(
        data.map((d: any) => d.folderId).filter(Boolean) as string[]
      ));
      if (folderIds.length > 0) {
        const fmap: Record<string, string> = {};
        await Promise.all(folderIds.map(async (fid) => {
          try {
            const fs = await getDoc(doc(db, 'folders', fid));
            if (fs.exists()) fmap[fid] = (fs.data() as any).title ?? '';
          } catch {}
        }));
        setFolderMap(fmap);
      }

      if (user) {
        const { data: updated, isNewSession } = await recordStudySession(user.uid);
        if (isNewSession) {
          // 오늘 첫 학습 보너스 (하루 1회)
          awardXpForCurrentUser('daily_first');
          // "🌱 첫 학습"은 생애 최초 학습일에만 (streak 리셋 후 재시작 제외)
          const isVeryFirst = updated.totalStudyDays === 1;
          const streak = updated.currentStreak;
          const milestone = isVeryFirst
            ? getMilestoneInfo(1)
            : streak > 1 ? getMilestoneInfo(streak) : null;
          if (milestone) {
            // 마일스톤 보너스
            awardXpForCurrentUser('streak_milestone');
            setMilestoneMsg(milestone.label);
            setTimeout(() => setMilestoneMsg(''), 3000);
          }
        }
      }
    };
    load();
    return () => { ttsStop(); };
  }, [id, user, ids, shuffleConfig, isAllShuffleEntry]);

  // 복습 모드: shortformId → wrongAnswers 문서 id 매핑.
  // 사용자가 카드를 볼 때마다 한 번씩 markReviewed 호출 (이미 처리한 것 제외)
  const reviewIdMap = useMemo(() => {
    if (!ids || !reviewIds) return null;
    const sfIds = ids.split(',').filter(Boolean);
    const rIds = reviewIds.split(',').filter(Boolean);
    const map = new Map<string, string>();
    sfIds.forEach((sfId, i) => {
      if (rIds[i]) map.set(sfId, rIds[i]);
    });
    return map;
  }, [ids, reviewIds]);
  const markedReviewsRef = useRef<Set<string>>(new Set());
  // 복습 모드에서 "정답" 처리됐을 때만 markReviewed + 세션 제거.
  // 단순 시청/스와이프로는 통과 안 됨. 답을 맞춰야 통과.
  const handleReviewCorrect = useCallback(() => {
    if (!reviewIdMap || items.length === 0) return;
    const sf = items[currentIndex];
    if (!sf) return;
    const reviewDocId = reviewIdMap.get(sf.id);
    if (!reviewDocId || markedReviewsRef.current.has(reviewDocId)) return;
    markedReviewsRef.current.add(reviewDocId);
    markReviewed(reviewDocId).catch(() => {
      markedReviewsRef.current.delete(reviewDocId);
    });
    awardXpForCurrentUser('review_correct');
    recordActivity('wrong');
    removeFromReviewSession(sf.id).catch(() => {});
  }, [reviewIdMap, items, currentIndex]);

  // 현재 + 인접(±1) + 더 앞(+2) 카드 배경 이미지 미리 로드 + Image.prefetch로 디코드까지 완료.
  // 오디오 mp3 프리페치와 같은 결: 사용자가 도달하기 전에 다음 쇼츠 자원을 받아둬 swipe 후 즉시 표시.
  useEffect(() => {
    if (items.length === 0) return;
    const targets = [currentIndex - 1, currentIndex, currentIndex + 1, currentIndex + 2].filter(
      (i) => i >= 0 && i < items.length
    );
    for (const i of targets) {
      const sf = items[i];
      if (!sf || bgImages[sf.id] !== undefined) continue;
      fetchBackgroundMedia(
        sf.id,
        sf.content.title,
        sf.type,
        sf.content.script,
        sf.imageKeywords ?? (sf.imageKeyword ? [sf.imageKeyword] : undefined)
      )
        .then((urls) => {
          // 받자마자 OS 이미지 캐시에 미리 로드 (네이티브: 디스크 + 메모리, 웹: HTTP 캐시)
          urls.forEach((u) => { Image.prefetch(u).catch(() => {}); });
          setBgImages((prev) => ({ ...prev, [sf.id]: urls }));
        })
        .catch(() => setBgImages((prev) => ({ ...prev, [sf.id]: [] })));
    }
  }, [currentIndex, items]);

  // Edge TTS mp3 프리페치 (TTS 꺼져있어도 동작).
  // - 현재 카드: 모든 청크. TTS 토글로 켜자마자 현재 청크부터 즉시 재생되도록.
  // - 인접 카드: 첫 청크만. 스와이프 직후 0초 시작.
  useEffect(() => {
    const voiceId = getCachedVoiceId();
    if (!isEdgeVoiceId(voiceId)) return;
    if (items.length === 0) return;
    // ttsSpeak Edge 분기와 동일한 rate 계산 (0.95 * ttsRate × 1.2/0.95)
    const edgeRate = 1.2; // 고정 SSML rate — 배속 무관 단일 캐시

    // 현재 카드의 모든 청크 (퀴즈/예시는 question + answer 모두)
    const cur = items[currentIndex];
    if (cur) {
      const isQuizType = cur.type === 'quiz' || cur.type === 'example';
      let chunks: string[];
      if (isQuizType) {
        const { question, answer } = splitQuizScript(cur.content.script);
        chunks = [...chunkScript(question), ...chunkScript(answer)];
      } else {
        chunks = chunkScript(cur.content.script);
      }
      for (const chunk of chunks) {
        getOrFetchEdgeMp3(chunk, voiceId, edgeRate).catch(() => { /* prefetch 실패 무시 */ });
      }
    }

    // 인접 카드 첫 청크
    const neighbors = [currentIndex + 1, currentIndex - 1].filter((i) => i >= 0 && i < items.length);
    for (const i of neighbors) {
      const sf = items[i];
      if (!sf) continue;
      const isQuizType = sf.type === 'quiz' || sf.type === 'example';
      const sourceText = isQuizType
        ? splitQuizScript(sf.content.script).question
        : sf.content.script;
      const firstChunk = chunkScript(sourceText)[0];
      if (!firstChunk) continue;
      getOrFetchEdgeMp3(firstChunk, voiceId, edgeRate).catch(() => { /* prefetch 실패 무시 */ });
    }
  }, [currentIndex, items]);

  const playOnNavRef = useRef(false);
  const wasStartedRef = useRef(false);
  useEffect(() => {
    // 시작 오버레이가 아직 안 내려갔으면 재생하지 않음 (첫 청크 TTS user-gesture 보장)
    if (!hasStarted) { setIsPlaying(false); return; }
    // 인트로 닫힌 직후 첫 진입: 무조건 재생 (웹/네이티브 공통)
    if (!wasStartedRef.current) {
      wasStartedRef.current = true;
      setIsPlaying(true);
      return;
    }
    if (playOnNavRef.current) {
      playOnNavRef.current = false;
      setIsPlaying(true);
    } else {
      setIsPlaying(Platform.OS !== 'web');
    }
  }, [currentIndex, hasStarted]);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { savedNoteIdsRef.current = savedNoteIds; }, [savedNoteIds]);

  // 웹: 마우스 휠 / 트랙패드 스와이프 누적해서 카드 이동
  const wheelAccumRef = useRef(0);
  // 현재 gesture(연속된 wheel 이벤트 묶음) 안에서 이미 nav 발화했는지
  const wheelLockedRef = useRef(false);
  const lastWheelTimeRef = useRef(0);
  const lastWheelAbsDeltaRef = useRef(0);
  const tryNavigateRef = useRef<((delta: 1 | -1) => void) | null>(null);
  useEffect(() => { tryNavigateRef.current = tryNavigate; }, [tryNavigate]);
  // wheel handler가 인트로 dismiss 시 handleStart 호출 가능하도록 ref로 노출. handleStart는 아래에 정의되어 있음.
  const handleStartRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const ADVANCE_THRESHOLD = 80;
    // wheel 이벤트가 이 시간 이상 끊기면 새 gesture로 간주 → lock 해제
    const GESTURE_GAP_MS = 70;
    // 마지막 카드 전환 후 이 시간이 지나면 정교한 관성 판정 다 무시하고 무조건 lock 해제.
    // 트랙패드 관성이 끊기지 않으면 GESTURE_GAP_MS/SPIKE 조건이 안 풀려 1~2초도 잡히는 케이스 회피.
    const HARD_RELEASE_MS = 500;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      const absDelta = Math.abs(e.deltaY);
      // 새 gesture 판정:
      // 1) 직전 wheel 이벤트로부터 GESTURE_GAP_MS 이상 지났거나
      // 2) 관성이 어느 정도 감쇠한 후(직전 delta가 SPIKE_FLOOR 이하) 갑자기 큰 delta가 들어옴
      //    → 진짜 새 swipe가 시작된 것. 쭉 슬라이드 중에는 직전 delta가 크기 때문에 발화 안 함
      // 3) 마지막 nav 후 HARD_RELEASE_MS 경과: 위 조건 둘 다 안 풀려도 강제 해제
      const SPIKE_FLOOR = 60;
      const timeGapElapsed = now - lastWheelTimeRef.current > GESTURE_GAP_MS;
      const deltaSpike =
        lastWheelAbsDeltaRef.current < SPIKE_FLOOR &&
        absDelta > SPIKE_FLOOR * 1.6;
      const hardReleased = now - lastNavRef.current > HARD_RELEASE_MS;
      if (timeGapElapsed || deltaSpike || hardReleased) {
        wheelLockedRef.current = false;
        wheelAccumRef.current = 0;
      }
      lastWheelTimeRef.current = now;
      lastWheelAbsDeltaRef.current = absDelta;
      // 이번 gesture에서 이미 발화 → 관성 wheel 무시
      if (wheelLockedRef.current) return;
      // 방향이 바뀌면 누적값 리셋
      if ((wheelAccumRef.current > 0) !== (e.deltaY > 0)) {
        wheelAccumRef.current = 0;
      }
      wheelAccumRef.current += e.deltaY;
      if (Math.abs(wheelAccumRef.current) < ADVANCE_THRESHOLD) return;
      const direction = wheelAccumRef.current > 0 ? 1 : -1;
      wheelAccumRef.current = 0;
      wheelLockedRef.current = true;
      // 인트로 카드: dismiss + TTS priming (wheel은 user activation 부여)
      // 본 플레이어: 카드 nav
      if (!hasStartedRef.current) {
        // handleStart를 호출해야 navBlocked/firstNavConsumed/lastNavRef cooldown 등 모든 가드가 정상 활성화됨.
        // 이전엔 setHasStarted(true)만 호출해서 가드 우회 → 잔여 wheel이 그대로 navigate되는 버그.
        primeTts(() => handleStartRef.current?.());
      } else {
        tryNavigateRef.current?.(direction);
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  const handleSaveNoteRef = useRef<(() => void) | null>(null);

  // 웹: 키보드로 카드 이동 + 노트 저장
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      // 인트로 카드 보이는 동안: 방향키/스페이스로 dismiss만 트리거 (navigate는 dismiss 후 별도 키 입력 필요)
      if (!hasStartedRef.current) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          primeTts(() => handleStartRef.current?.());
        }
        return;
      }
      // 입력창에서 친 키는 무시
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowDown') {
        tryNavigateRef.current?.(1);
      } else if (e.key === 'ArrowUp') {
        tryNavigateRef.current?.(-1);
      } else if (e.key === 'ArrowRight') {
        skipChunkRef.current?.();
      } else if (e.key === 'ArrowLeft') {
        prevChunkRef.current?.();
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault(); // 기본 스크롤 방지
        setIsPlaying((p) => !p);
      } else if (e.key === 's' || e.key === 'S') {
        handleSaveNoteRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const DOT_STEP = 9;            // inactive 5 + gap 4
  const ACTIVE_DOT_HALF = 8;     // active width 16 의 절반
  const DOT_CONTAINER_W = 140;
  useEffect(() => {
    if (items.length === 0) return;
    // 활성 dot의 중심을 컨테이너 중심에 맞춤
    const target = DOT_CONTAINER_W / 2 - ACTIVE_DOT_HALF - currentIndex * DOT_STEP;
    Animated.spring(dotTranslateX, {
      toValue: target,
      useNativeDriver: USE_NATIVE_DRIVER,
      tension: 120,
      friction: 14,
    }).start();
  }, [currentIndex, items.length]);

  const toggleShuffle = () => {
    // 이미 본 카드(현재 카드 포함)는 그대로 유지, 앞으로 볼 부분만 정렬/셔플 → 진행 흐름 유지
    // ttsStop()을 호출하면 native에서 Speech.stop()이 onDone을 trigger → 다음 chunk로 advance하는 버그.
    // 현재 카드가 유지되니 TTS를 끊을 필요가 없음.
    const seen = items.slice(0, currentIndex + 1);
    const remaining = items.slice(currentIndex + 1);
    let nextRemaining: ShortForm[];
    if (isShuffle) {
      // 해제: 남은 카드를 원래 order 순으로 복원
      nextRemaining = [...remaining].sort((a, b) => a.order - b.order);
    } else {
      // 셔플: 남은 카드를 타입 그룹(개념 → 예시 → 퀴즈) 유지하면서 그룹 내에서만 섞기
      const concepts = shuffle(remaining.filter((d) => d.type === 'concept'));
      const examples = shuffle(remaining.filter((d) => d.type === 'example'));
      const quizzes  = shuffle(remaining.filter((d) => d.type === 'quiz'));
      nextRemaining = [...concepts, ...examples, ...quizzes];
    }
    setItems([...seen, ...nextRemaining]);
    setIsShuffle(!isShuffle);
    // currentIndex 유지: 그 자리에서 계속 재생
    setIsPlaying(true);
  };

  const handlePlayPause = useCallback(() => setIsPlaying((p) => !p), []);

  // user-gesture 컨텍스트 내에서 TTS 엔진 priming만 수행 (state 변경은 별도)
  // volume=0이면 iOS/일부 브라우저가 실제 발화로 인정하지 않아 unlock이 실패함 → 실제 발화시킴
  // priming utterance가 "실제로 시작"되어야 synth가 unlock됨 (그래야 후속 ttsSpeak가 not-allowed로 거부되지 않음).
  // onReady는 onstart 발화(unlock 완료) 후 호출.
  const primingStartedRef = useRef(false);
  const primeTts = useCallback((onReady?: () => void, opts?: { force?: boolean }) => {
    // 중복 호출 차단 (force=true면 우회: 사용자가 retry 버튼 누른 경우)
    if (primingStartedRef.current && !opts?.force) { onReady?.(); return; }
    primingStartedRef.current = true;
    let done = false;
    const fire = () => { if (done) return; done = true; onReady?.(); };
    try {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          const synth = window.speechSynthesis;
          const ua: any = (navigator as any).userActivation;
          if (ua) console.log('[primeTts] userActivation:', { isActive: ua.isActive, hasBeenActive: ua.hasBeenActive });
          console.log('[primeTts] synth state:', { speaking: synth.speaking, pending: synth.pending, paused: synth.paused });

          // 진단: 사용 가능한 voices 확인. Chrome은 초기 getVoices() 호출 시 빈 배열 반환 → voiceschanged 이벤트 후 채워짐.
          // 빈 배열이면 강제로 한 번 더 호출 (Chrome 내부 voice 로드 트리거)
          let voices = synth.getVoices();
          if (voices.length === 0) {
            console.warn('[primeTts] voices empty — Chrome voice list not yet loaded');
            // cachedVoices 재시도
            cachedVoices = synth.getVoices();
            voices = cachedVoices;
          }
          const koVoice = voices.find(v => v.lang === 'ko-KR') ?? voices.find(v => v.lang.startsWith('ko'));
          const defaultVoice = voices.find(v => v.default);
          console.log('[primeTts] voices:', voices.length, 'ko:', koVoice?.name, 'default:', defaultVoice?.name);

          // 깨끗한 상태로 리셋
          try { synth.cancel(); } catch {}
          try { synth.resume(); } catch {}

          // priming utterance: synth unlock 용도로만 발화. 사용자에게 들리지 않도록 무음화.
          // (텍스트나 발화 자체를 없애면 Chrome이 unlock을 안 해 후속 chunk가 not-allowed로 거부됨)
          const warm = new SpeechSynthesisUtterance(' ');
          warm.volume = 0;
          warm.rate = 10;
          if (koVoice) {
            warm.voice = koVoice;
            warm.lang = koVoice.lang;
          } else if (defaultVoice) {
            warm.voice = defaultVoice;
            warm.lang = defaultVoice.lang;
          }
          // else: lang 미설정, 브라우저가 시스템 default 사용
          warm.onstart = () => {
            console.log('[primeTts] unlocked');
            setAudioBlocked(false);
            fire();
          };
          warm.onerror = (e: any) => {
            // canceled: dismiss/navigation으로 정상 cancel된 경우 → 조용히 처리
            // not-allowed: autoplay 차단 → 사용자 retry 필요하므로 banner 노출
            if (e?.error === 'not-allowed') {
              console.warn('[primeTts] not-allowed (autoplay blocked)');
              setAudioBlocked(true);
            }
            fire();
          };
          warm.onend = () => {
            console.log('[primeTts] ended');
            setAudioBlocked(false);
            fire();
          };
          synth.speak(warm);
          // 50ms 후 synth 상태 확인 (큐에 들어갔는지)
          setTimeout(() => {
            console.log('[primeTts] post-speak state:', { speaking: synth.speaking, pending: synth.pending, paused: synth.paused });
          }, 50);
          setTimeout(fire, 1500);
        } else {
          fire();
        }
      } else {
        Speech.speak('시', {
          language: 'ko-KR',
          rate: 1.5,
          volume: 1,
          onStart: fire,
          onDone: fire,
          onError: fire,
        });
        setTimeout(fire, 1200);
      }
    } catch (e: any) {
      console.warn('[primeTts] caught:', e?.message);
      fire();
    }
  }, []);

  // 인트로 dismiss 완료 시: 실제 재생 시작 (overlay unmount)
  const handleStart = useCallback(() => {
    setHasStarted(true);
    hasStartedRef.current = true;
    // dismiss 직후 0.7초 동안 모든 navigate 차단: 잔여 wheel/swipe 관성으로 자동 advance 되는 것 방지.
    // 트랙패드 관성이 ~200~600ms 정도라 0.7초면 충분히 봉쇄됨.
    navBlockedRef.current = true;
    setTimeout(() => { navBlockedRef.current = false; }, 700);
    wheelLockedRef.current = true;
    wheelAccumRef.current = 0;
  }, []);
  useEffect(() => { handleStartRef.current = handleStart; }, [handleStart]);

  const handleRequestSpeak = useCallback((text: string, onEnd?: () => void) => {
    pendingSpeakRef.current = text;
    ttsSpeak(text, { onEnd });
  }, []);

  const handleWrongAnswer = useCallback((title: string, script: string) => {
    if (!user) return;
    const sf = items[currentIndex];
    if (!sf) return;
    const pid = sf.projectId ?? id;
    // saveWrongAnswer는 기존 등재 카드면 streak 리셋 + 1일 후 재예약을 수행하므로
    // 복습 모드에서 다시 틀린 경우도 자동으로 처리됨
    saveWrongAnswer(user.uid, sf.id, pid, title, script, sf.folderId ?? null, sf.importance ?? 5).catch(() => {});
    // 복습 모드 + 아직 통과 안 한 카드면 같은 쇼츠를 큐 맨 뒤에 한 번 더 추가 (현재 카드는 그대로 유지).
    // 사용자가 스와이프해서 다음 카드로 가면 결국 맨 끝에서 다시 만나 재출제됨.
    if (reviewIdMap && !markedReviewsRef.current.has(reviewIdMap.get(sf.id) ?? '')) {
      setItems((prev) => [...prev, sf]);
    }
  }, [user, items, currentIndex, id, reviewIdMap]);

  const handleSwipeUp = useCallback(() => { tryNavigate(1); }, [tryNavigate]);
  const handleSwipeDown = useCallback(() => { tryNavigate(-1); }, [tryNavigate]);

  // items 변경 시 같은 projectId들의 concept 카드를 fetch해서 conceptLookup에 캐싱.
  // ids 모드로 한 카드만 로드된 경우에도 부모 concept 찾기 가능.
  // CLAUDE.md 원칙대로 복합 where(in + ==)를 피하고 in만 쓰고 type 필터는 클라이언트에서: 인덱스 누락으로 인한 실패 방지.
  useEffect(() => {
    const projectIds = Array.from(new Set(
      items.map((s) => s.projectId).filter((p): p is string => !!p && !conceptLookup[p]),
    ));
    if (projectIds.length === 0) return;
    (async () => {
      const updates: Record<string, ShortForm[]> = {};
      // 'in' 쿼리는 30개 제한
      for (let i = 0; i < projectIds.length; i += 30) {
        const batch = projectIds.slice(i, i + 30);
        const snap = await getDocs(query(
          collection(db, 'shortforms'),
          where('projectId', 'in', batch),
        ));
        snap.docs.forEach((d) => {
          const sf = { id: d.id, ...d.data() } as ShortForm;
          if (sf.type !== 'concept') return;
          const pid = sf.projectId ?? '';
          if (!updates[pid]) updates[pid] = [];
          updates[pid].push(sf);
        });
      }
      if (Object.keys(updates).length > 0) {
        setConceptLookup((prev) => ({ ...prev, ...updates }));
      }
    })().catch((e) => { console.warn('[conceptLookup] fetch failed:', e?.message ?? e); });
  }, [items]);

  // quiz/example 오답 시 부모 concept으로 이동.
  // 1순위: parentConceptTitle로 정확 매칭 (생성 시 영구 보존된 부모 link)
  // 2순위(레거시): 같은 projectId + order < current인 가장 가까운 concept (예전 데이터 호환용)
  const parentConceptForCurrent = useMemo(() => {
    const cur = items[currentIndex];
    if (!cur || cur.type === 'concept' || !cur.projectId) return null;
    const fromItems = items.filter(
      (s) => s.type === 'concept' && s.projectId === cur.projectId,
    );
    const fromLookup = conceptLookup[cur.projectId] ?? [];
    // 중복 제거 (id 기준)
    const byId = new Map<string, ShortForm>();
    [...fromItems, ...fromLookup].forEach((s) => byId.set(s.id, s));
    const all = Array.from(byId.values());
    if (all.length === 0) return null;
    // 1순위: title 정확 매칭
    if (cur.parentConceptTitle) {
      const exact = all.find((s) => s.content?.title === cur.parentConceptTitle);
      if (exact) return exact;
    }
    // 2순위: order 기반 fallback
    const before = all.filter((s) => s.order < cur.order);
    if (before.length === 0) return null;
    return before.sort((a, b) => b.order - a.order)[0];
  }, [items, currentIndex, conceptLookup]);

  const handleNavigateToParent = useCallback(() => {
    if (!parentConceptForCurrent) return;
    // ids에 부모 concept id 하나만 넘겨서 player가 그 카드 하나만 로드 (프로젝트 전체 진입 방지)
    // skipIntro=1로 인트로 카드 건너뛰고 바로 본 재생
    router.push({
      pathname: '/player/[id]',
      params: {
        id: parentConceptForCurrent.projectId ?? id,
        shortformId: parentConceptForCurrent.id,
        ids: parentConceptForCurrent.id,
        skipIntro: '1',
      },
    });
  }, [parentConceptForCurrent, router, id]);

  const [removeToast, setRemoveToast] = useState(false);
  // 연타 시: 이전 timer를 cancel해야 새 토스트가 즉시 사라지지 않음.
  // 또한 save/remove 토스트는 mutex: 한쪽 띄울 때 반대편 즉시 끄기 (둘이 겹쳐 그려지면 뒤에 렌더된 remove가 위에 보임)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSaveNote = useCallback(() => {
    // 인트로 카드(쇼츠 준비 화면)에서는 BookmarkBtn/단축키/스와이프 어떤 경로로 와도 저장 금지
    if (!hasStartedRef.current) return;
    const u = userRef.current;
    const curItems = itemsRef.current;
    const curIdx = currentIndexRef.current;
    const curSaved = savedNoteIdsRef.current;
    if (!u) return;
    const sf = curItems[curIdx];
    if (!sf) return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (curSaved.has(sf.id)) {
      setSavedNoteIds((prev) => { const next = new Set(prev); next.delete(sf.id); return next; });
      setSaveToast(false);
      setRemoveToast(true);
      toastTimerRef.current = setTimeout(() => setRemoveToast(false), 1800);
      deleteStudyNotesByShortformIds([sf.id]).catch(() => {});
    } else {
      setSavedNoteIds((prev) => new Set([...prev, sf.id]));
      setRemoveToast(false);
      setSaveToast(true);
      toastTimerRef.current = setTimeout(() => setSaveToast(false), 1800);
      const pid = sf.projectId ?? id;
      saveStudyNote(u.uid, sf.id, pid, sf.content.title, sf.content.script, sf.folderId ?? null, sf.type).catch(() => {});
    }
  }, [id]);

  useEffect(() => { handleSaveNoteRef.current = handleSaveNote; }, [handleSaveNote]);

  const handleSwipeUpRef = useRef(handleSwipeUp);
  const handleSwipeDownRef = useRef(handleSwipeDown);
  useEffect(() => { handleSwipeUpRef.current = handleSwipeUp; }, [handleSwipeUp]);
  useEffect(() => { handleSwipeDownRef.current = handleSwipeDown; }, [handleSwipeDown]);
  // 인트로 카드 보이는 동안 window 레벨 핸들러를 비활성화하기 위한 ref
  const hasStartedRef = useRef(hasStarted);
  useEffect(() => { hasStartedRef.current = hasStarted; }, [hasStarted]);

  // 웹: window 레벨 Pointer Events로 스와이프 감지 (컨테이너 ref 타이밍 문제 회피)
  const webContainerRef = useRef<any>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let startX = 0, startY = 0;
    const onDown = (e: PointerEvent) => { startX = e.clientX; startY = e.clientY; };
    const onUp = (e: PointerEvent) => {
      // 인트로 카드 보이는 동안에는 IntroCard 자체 PanResponder가 처리하도록 이 핸들러는 비활성화
      if (!hasStartedRef.current) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      // 임계값 미만의 모든 swipe 시도는 "아예 안 들어온 것"으로 취급 → 아무 동작 안 함
      const VERTICAL_THRESHOLD = 60;
      const HORIZONTAL_THRESHOLD = 90;
      if (ax > ay) {
        if (dx < -HORIZONTAL_THRESHOLD) handleSaveNoteRef.current?.();
      } else {
        if (dy < -VERTICAL_THRESHOLD) handleSwipeUpRef.current?.();
        else if (dy > VERTICAL_THRESHOLD) handleSwipeDownRef.current?.();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('pointerup', onUp, true); };
  }, []);

  // 네이티브: PanResponder로 스와이프 감지
  const containerPanResponder = useRef(
    PanResponder.create({
      // 인트로 카드가 떠 있을 때는 responder 자체를 거부 → IntroCard가 첫 swipe로 dismiss 받을 수 있도록.
      // 이전엔 onStart...=true라 컨테이너가 gesture를 가로채고 onRelease guard로만 무시 → IntroCard로 안 전달되어
      // 사용자가 두 번 swipe해야 dismiss되는 버그.
      onStartShouldSetPanResponder: () => hasStartedRef.current,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: () => hasStartedRef.current,
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_, gs) => {
        if (!hasStartedRef.current) return;
        const ax = Math.abs(gs.dx), ay = Math.abs(gs.dy);
        // 임계값 미만의 모든 swipe 시도는 무시
        const VERTICAL_THRESHOLD = 60;
        const HORIZONTAL_THRESHOLD = 90;
        if (ax > ay) {
          if (gs.dx < -HORIZONTAL_THRESHOLD) handleSaveNoteRef.current?.();
        } else {
          if (gs.dy < -VERTICAL_THRESHOLD) handleSwipeUpRef.current?.();
          else if (gs.dy > VERTICAL_THRESHOLD) handleSwipeDownRef.current?.();
        }
      },
    })
  ).current;

  const handleClose = useCallback(() => {
    ttsStop();
    if (router.canDismiss()) router.dismiss();
    else if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/folders');
  }, [router]);

  // 전체 셔플 진입 옵션 모달: 첫 진입에만 표시. 옵션 선택 후 로드 시작.
  if (isAllShuffleEntry && shuffleConfig === null) {
    return (
      <ShuffleOptionsScreen
        onStart={(cfg) => setShuffleConfig(cfg)}
        onClose={handleClose}
      />
    );
  }

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color="#4F8EF7" />
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.emptyText}>숏폼이 없습니다</Text>
        <TouchableOpacity style={styles.backBtn} onPress={handleClose}>
          <Text style={styles.backBtnText}>← 뒤로</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const cfg = TYPE_CONFIG[items[currentIndex]?.type ?? 'concept'];

  const currentItem = items[currentIndex];
  const isConceptCard = currentItem?.type === 'concept';
  const isNoteSaved = currentItem ? savedNoteIds.has(currentItem.id) : false;

  const handleSkipChunk = () => { skipChunkRef.current?.(); };
  const handlePrevChunk = () => { prevChunkRef.current?.(); };

  // 중앙 하단 재생 컨트롤: 이전 문장 / 재생·일시정지 / 다음 문장
  const PlaybackControls = () => (
    <View style={styles.playbackBar} pointerEvents="box-none">
      <TouchableOpacity
        style={styles.playbackSideBtn}
        onPress={handlePrevChunk}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Ionicons name="play-skip-back" size={24} color="#fff" />
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.playbackPlayBtn, { backgroundColor: cfg.color + '25', borderColor: cfg.color }]}
        onPress={handlePlayPause}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Ionicons name={isPlaying ? 'pause' : 'play'} size={26} color={cfg.color} />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.playbackSideBtn}
        onPress={handleSkipChunk}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Ionicons name="play-skip-forward" size={24} color="#fff" />
      </TouchableOpacity>
    </View>
  );

  const TtsRateBtn = () => (
    <TouchableOpacity style={styles.sideBtn} onPress={() => setRatePickerVisible(true)} disabled={!ttsEnabled}>
      <View style={[
        styles.sideBtnCircle,
        ttsRate !== 1.0 && ttsEnabled && { backgroundColor: cfg.color + '30', borderColor: cfg.color },
        !ttsEnabled && { backgroundColor: '#ffffff15', borderColor: '#ffffff40' },
      ]}>
        <Text style={{
          color: !ttsEnabled ? '#ffffff60' : (ttsRate !== 1.0 ? cfg.color : '#fff'),
          fontSize: 12,
          fontWeight: '800',
        }}>
          {ttsRate}x
        </Text>
      </View>
      <Text style={[styles.sideBtnLabel, !ttsEnabled && { color: '#ffffff60' }]}>속도</Text>
    </TouchableOpacity>
  );

  const BookmarkBtn = () => (
    <TouchableOpacity style={styles.sideBtn} onPress={handleSaveNote}>
      <View style={[styles.sideBtnCircle, isNoteSaved && { backgroundColor: colors.note + '30', borderColor: colors.note }]}>
        <Ionicons name={isNoteSaved ? 'bookmark' : 'bookmark-outline'} size={20} color={isNoteSaved ? colors.note : '#fff'} />
      </View>
      <Text style={[styles.sideBtnLabel, isNoteSaved && { color: colors.note }]}>
        {isNoteSaved ? '저장됨' : '노트저장'}
      </Text>
    </TouchableOpacity>
  );

  // 웹: FlatList 대신 단일 카드 + 위아래 버튼
  if (Platform.OS === 'web') {
    return (
      <View ref={webContainerRef} style={styles.webContainer}>
        <StatusBar barStyle="light-content" />
        <View style={styles.phoneFrame}>
        {!hasStarted ? (
          <IntroCard
            onPrime={primeTts}
            onStart={handleStart}
            accentColor={cfg.color}
            topInset={insets.top}
            bottomInset={insets.bottom}
          />
        ) : (
          <AnimatedCard
            key={`${currentIndex}_${items[currentIndex]?.id ?? ''}`}
            item={items[currentIndex]}
            wrongRecord={items[currentIndex] ? wrongMap.get(items[currentIndex].id) : null}
            isActive
            isPlaying={isPlaying}
            ttsEnabled={ttsEnabled}
            ttsRate={ttsRate}
            bgImageUrls={items[currentIndex] ? bgImages[items[currentIndex].id] : []}
            subject={(() => {
              const sf = items[currentIndex];
              const fTitle = sf?.folderId ? folderMap[sf.folderId] : undefined;
              const pTitle = sf?.projectId ? projectMap[sf.projectId as string] : undefined;
              const combined = [fTitle, pTitle].filter(Boolean).join(' / ');
              return combined || undefined;
            })()}
            topInset={insets.top}
            bottomInset={insets.bottom}
            onPlayPause={handlePlayPause}
            onRequestSpeak={handleRequestSpeak}
            onWrongAnswer={handleWrongAnswer}
            onCorrectAnswer={handleReviewCorrect}
            onAudioPlaying={() => setAudioBlocked(false)}
            onReachedLastSlide={() => {
              const sf = itemsRef.current[currentIndex];
              if (sf) markReachedLastSlide(sf.id, sf.type);
            }}
            skipRef={skipChunkRef}
            prevSentenceRef={prevChunkRef}
            onNavigateToParent={parentConceptForCurrent ? handleNavigateToParent : undefined}
          />
        )}
        <View style={[styles.overlay, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]} pointerEvents="box-none">
          {milestoneMsg ? (
            <View style={styles.toast}>
              <Text style={styles.toastText}>{milestoneMsg}</Text>
            </View>
          ) : null}

          <View style={styles.topBar} pointerEvents="box-none">
            <View style={styles.topBarSide}>
              <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
                <Ionicons name="close" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
            <View style={styles.topBarCenter} pointerEvents="none">
              <View style={styles.progressDots}>
                <Animated.View style={{ flexDirection: 'row', gap: 4, transform: [{ translateX: dotTranslateX }] }}>
                  {items.map((item, i) => {
                    const dotColor = TYPE_CONFIG[item.type].color;
                    return (
                      <View
                        key={i}
                        style={[
                          styles.pdot,
                          { backgroundColor: dotColor + '44' },
                          i === currentIndex && [styles.pdotActive, { backgroundColor: dotColor }],
                        ]}
                      />
                    );
                  })}
                </Animated.View>
              </View>
            </View>
            <View style={[styles.topBarSide, { alignItems: 'flex-end' }]} pointerEvents="none">
              <Text style={styles.counter}>{currentIndex + 1} / {items.length}</Text>
            </View>
          </View>

          {/* 위아래 이동 버튼: 인트로 카드(쇼츠 준비) 단계에서는 숨김 */}
          {hasStarted && (
            <View style={styles.webNavRow}>
              <TouchableOpacity
                style={[styles.webNavBtn, currentIndex === 0 && styles.webNavBtnDisabled]}
                onPress={() => tryNavigate(-1)}
              >
                <Ionicons name="chevron-up" size={22} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.webNavBtn, currentIndex === items.length - 1 && styles.webNavBtnDisabled]}
                onPress={() => tryNavigate(1)}
              >
                <Ionicons name="chevron-down" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.sideActions}>
            <VolumeFader value={ttsVolume} onChange={changeVolume} color={cfg.color} />
            {!isMobile && <TtsRateBtn />}
            <BookmarkBtn />
            {!isMobile && (
              <TouchableOpacity style={styles.sideBtn} onPress={toggleShuffle}>
                <View style={[styles.sideBtnCircle, isShuffle && { backgroundColor: cfg.color + '30', borderColor: cfg.color }]}>
                  <Ionicons name="shuffle" size={20} color={isShuffle ? cfg.color : '#fff'} />
                </View>
                <Text style={[styles.sideBtnLabel, isShuffle && { color: cfg.color }]}>
                  {isShuffle ? 'ON' : '셔플'}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.sideBtn}
              onPress={() => {
                const sf = items[currentIndex];
                router.push({
                  pathname: '/ai-chat',
                  params: sf
                    ? { context: sf.content.script, contextTitle: sf.content.title, backPath: `/project/${sf.projectId ?? id}` }
                    : { backPath: `/project/${id}` },
                });
              }}
            >
              <View style={styles.sideBtnCircle}>
                <Ionicons name="sparkles" size={20} color="#A78BFA" />
              </View>
              <Text style={styles.sideBtnLabel}>AI 질문</Text>
            </TouchableOpacity>
            {isMobile && (
              <TouchableOpacity style={styles.sideBtn} onPress={() => setExtraMenuOpen(true)}>
                <View style={styles.sideBtnCircle}>
                  <Ionicons name="ellipsis-horizontal" size={20} color="#fff" />
                </View>
                <Text style={styles.sideBtnLabel}>더보기</Text>
              </TouchableOpacity>
            )}
          </View>
          {hasStarted && (
            <View style={[styles.playbackBarWrap, { paddingBottom: Math.max(16, insets.bottom + 12) }]} pointerEvents="box-none">
              <PlaybackControls />
            </View>
          )}
          {saveToast && (
            <View style={[styles.toast, { backgroundColor: '#8FB2D1' }]} pointerEvents="none">
              <Text style={styles.toastText}>노트에 저장됐어요!</Text>
            </View>
          )}
          {removeToast && (
            <View style={[styles.toast, { backgroundColor: '#B57F4D' }]} pointerEvents="none">
              <Text style={styles.toastText}>노트에서 삭제됐어요</Text>
            </View>
          )}
        </View>
        </View>
        {audioBlocked && hasStarted && (
          <AudioUnlockBanner
            onPress={() => {
              primingStartedRef.current = false;
              primeTts(() => setAudioBlocked(false), { force: true });
            }}
          />
        )}
        <ExtraMenu
          visible={extraMenuOpen}
          onClose={() => setExtraMenuOpen(false)}
          ttsEnabled={ttsEnabled}
          ttsRate={ttsRate}
          onSpeedPress={() => setRatePickerVisible(true)}
          isShuffle={isShuffle}
          onToggleShuffle={toggleShuffle}
          accent={cfg.color}
        />
        <RatePickerModal
          visible={ratePickerVisible}
          onClose={() => setRatePickerVisible(false)}
          ttsRate={ttsRate}
          onPick={pickTtsRate}
          accent={cfg.color}
        />
      </View>
    );
  }

  // 네이티브: FlatList 제거, 단일 카드 렌더링 (gesture 충돌 완전 제거)
  return (
    <View style={styles.container} {...(hasStarted ? containerPanResponder.panHandlers : {})}>
      <StatusBar barStyle="light-content" />
      {!hasStarted ? (
        <IntroCard
          onPrime={primeTts}
          onStart={handleStart}
          accentColor={cfg.color}
          topInset={insets.top}
          bottomInset={insets.bottom}
        />
      ) : (
        <AnimatedCard
          key={`${currentIndex}_${items[currentIndex]?.id ?? ''}`}
          item={items[currentIndex]}
          wrongRecord={items[currentIndex] ? wrongMap.get(items[currentIndex].id) : null}
          isActive
          isPlaying={isPlaying}
          ttsEnabled={ttsEnabled}
          ttsRate={ttsRate}
          bgImageUrls={items[currentIndex] ? bgImages[items[currentIndex].id] : []}
          subject={(() => {
            const sf = items[currentIndex];
            const fTitle = sf?.folderId ? folderMap[sf.folderId] : undefined;
            const pTitle = sf?.projectId ? projectMap[sf.projectId as string] : undefined;
            const combined = [fTitle, pTitle].filter(Boolean).join(' / ');
            return combined || undefined;
          })()}
          topInset={insets.top}
          bottomInset={insets.bottom}
          onPlayPause={handlePlayPause}
          onRequestSpeak={handleRequestSpeak}
          onWrongAnswer={handleWrongAnswer}
          onCorrectAnswer={handleReviewCorrect}
          onAudioPlaying={() => setAudioBlocked(false)}
          onReachedLastSlide={() => {
            const sf = itemsRef.current[currentIndex];
            if (sf) markReachedLastSlide(sf.id, sf.type);
          }}
          skipRef={skipChunkRef}
          prevSentenceRef={prevChunkRef}
          onNavigateToParent={parentConceptForCurrent ? handleNavigateToParent : undefined}
        />
      )}
      <View
        style={[styles.overlay, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        pointerEvents="box-none"
      >
        {milestoneMsg ? (
          <View style={styles.toast} pointerEvents="none">
            <Text style={styles.toastText}>{milestoneMsg}</Text>
          </View>
        ) : null}
        <View style={styles.topBar} pointerEvents="box-none">
          <View style={styles.topBarSide}>
            <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
          <View style={styles.topBarCenter} pointerEvents="none">
            <View style={styles.progressDots}>
              <Animated.View style={{ flexDirection: 'row', gap: 4, transform: [{ translateX: dotTranslateX }] }}>
                {items.map((_, i) => (
                  <View key={i} style={[styles.pdot, i === currentIndex && [styles.pdotActive, { backgroundColor: cfg.color }]]} />
                ))}
              </Animated.View>
            </View>
          </View>
          <View style={[styles.topBarSide, { alignItems: 'flex-end' }]} pointerEvents="none">
            <Text style={styles.counter}>{currentIndex + 1} / {items.length}</Text>
          </View>
        </View>
        <View style={styles.sideActions} pointerEvents="box-none">
          <VolumeFader value={ttsVolume} onChange={changeVolume} color={cfg.color} />
          {!isMobile && <TtsRateBtn />}
          <BookmarkBtn />
          {!isMobile && (
            <TouchableOpacity style={styles.sideBtn} onPress={toggleShuffle} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <View style={[styles.sideBtnCircle, isShuffle && { backgroundColor: cfg.color + '30', borderColor: cfg.color }]}>
                <Ionicons name="shuffle" size={20} color={isShuffle ? cfg.color : '#fff'} />
              </View>
              <Text style={[styles.sideBtnLabel, isShuffle && { color: cfg.color }]}>
                {isShuffle ? 'ON' : '셔플'}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.sideBtn}
            onPress={() => {
              const sf = items[currentIndex];
              router.push({
                pathname: '/ai-chat',
                params: sf
                  ? { context: sf.content.script, contextTitle: sf.content.title, backPath: `/project/${sf.projectId ?? id}` }
                  : { backPath: `/project/${id}` },
              });
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <View style={styles.sideBtnCircle}>
              <Ionicons name="sparkles" size={20} color="#A78BFA" />
            </View>
            <Text style={styles.sideBtnLabel}>AI 질문</Text>
          </TouchableOpacity>
          {isMobile && (
            <TouchableOpacity style={styles.sideBtn} onPress={() => setExtraMenuOpen(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <View style={styles.sideBtnCircle}>
                <Ionicons name="ellipsis-horizontal" size={20} color="#fff" />
              </View>
              <Text style={styles.sideBtnLabel}>더보기</Text>
            </TouchableOpacity>
          )}
        </View>
        {hasStarted && (
          <View style={[styles.playbackBarWrap, { paddingBottom: Math.max(16, insets.bottom + 12) }]} pointerEvents="box-none">
            <PlaybackControls />
          </View>
        )}
        {saveToast && (
          <View style={[styles.toast, { backgroundColor: '#8FB2D1', pointerEvents: 'none' } as any]}>
            <Text style={styles.toastText}>노트에 저장됐어요!</Text>
          </View>
        )}
        {removeToast && (
          <View style={[styles.toast, { backgroundColor: '#B57F4D', pointerEvents: 'none' } as any]}>
            <Text style={styles.toastText}>노트에서 삭제됐어요</Text>
          </View>
        )}
      </View>
      {audioBlocked && hasStarted && (
        <AudioUnlockBanner
          onPress={() => {
            primingStartedRef.current = false;
            primeTts(() => setAudioBlocked(false), { force: true });
          }}
        />
      )}
      <ExtraMenu
        visible={extraMenuOpen}
        onClose={() => setExtraMenuOpen(false)}
        ttsEnabled={ttsEnabled}
        ttsRate={ttsRate}
        onSpeedPress={() => setRatePickerVisible(true)}
        isShuffle={isShuffle}
        onToggleShuffle={toggleShuffle}
        accent={cfg.color}
      />
      <RatePickerModal
        visible={ratePickerVisible}
        onClose={() => setRatePickerVisible(false)}
        ttsRate={ttsRate}
        onPick={pickTtsRate}
        accent={cfg.color}
      />
    </View>
  );
}

function ExtraMenu({
  visible, onClose, ttsEnabled, ttsRate, onSpeedPress, isShuffle, onToggleShuffle, accent,
}: {
  visible: boolean;
  onClose: () => void;
  ttsEnabled: boolean;
  ttsRate: number;
  onSpeedPress: () => void;
  isShuffle: boolean;
  onToggleShuffle: () => void;
  accent: string;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <TouchableOpacity style={styles.extraOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.extraSheet}>
          <TouchableOpacity
            style={styles.extraRow}
            onPress={() => { onClose(); onSpeedPress(); }}
            disabled={!ttsEnabled}
          >
            <Ionicons name="speedometer-outline" size={20} color={ttsEnabled ? '#fff' : '#666'} />
            <Text style={[styles.extraLabel, !ttsEnabled && { color: '#666' }]}>음성 속도</Text>
            <Text style={[styles.extraValue, { color: accent }]}>{ttsRate.toFixed(2)}x</Text>
            <Ionicons name="chevron-forward" size={16} color={ttsEnabled ? '#888' : '#444'} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.extraRow}
            onPress={() => { onToggleShuffle(); onClose(); }}
          >
            <Ionicons name="shuffle" size={20} color={isShuffle ? accent : '#fff'} />
            <Text style={[styles.extraLabel, isShuffle && { color: accent }]}>셔플 재생</Text>
            <Text style={[styles.extraValue, { color: isShuffle ? accent : '#666' }]}>
              {isShuffle ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function RatePickerModal({
  visible, onClose, ttsRate, onPick, accent,
}: {
  visible: boolean;
  onClose: () => void;
  ttsRate: number;
  onPick: (next: number) => void;
  accent: string;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <TouchableOpacity style={styles.extraOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.rateSheet}>
          <Text style={styles.rateSheetTitle}>음성 속도</Text>
          {TTS_RATES.map((r) => {
            const active = r === ttsRate;
            return (
              <TouchableOpacity
                key={r}
                style={[styles.rateRow, active && { backgroundColor: accent + '20', borderColor: accent }]}
                onPress={() => onPick(r)}
              >
                <Text style={[styles.rateRowText, active && { color: accent, fontWeight: '800' }]}>
                  {r}x
                </Text>
                {active && <Ionicons name="checkmark" size={18} color={accent} />}
              </TouchableOpacity>
            );
          })}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function AudioUnlockBanner({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={styles.audioBanner}
    >
      <Ionicons name="volume-mute" size={18} color="#fff" />
      <Text style={styles.audioBannerText}>탭하여 음성 활성화</Text>
    </TouchableOpacity>
  );
}

function IntroCard({
  onStart,
  onPrime,
  accentColor,
  topInset = 0,
  bottomInset = 0,
}: {
  onStart: () => void;
  onPrime: (onReady?: () => void) => void;
  accentColor: string;
  topInset?: number;
  bottomInset?: number;
}) {
  const translateY = useRef(new Animated.Value(0)).current;
  const arrowAnim = useRef(new Animated.Value(0)).current;
  const dismissedRef = useRef(false);

  // 아래 화살표 힌트 펄스 애니메이션
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(arrowAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(arrowAnim, { toValue: 0, duration: 800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    // primeTts onstart 콜백 이후 dismiss → synth unlock 보장
    onPrime(() => onStart());
  }, [onPrime, onStart]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          console.log('[IntroCard] gesture grant');
        },
        onPanResponderMove: (_, g) => {
          if (dismissedRef.current) return;
          if (g.dy < 0) translateY.setValue(g.dy);
        },
        onPanResponderRelease: (_, g) => {
          if (dismissedRef.current) return;
          console.log('[IntroCard] release dy:', g.dy.toFixed(0), 'vy:', g.vy.toFixed(2));
          // 위로 스와이프 또는 살짝 위로 움직인 경우 모두 dismiss
          if (g.dy < -20 || g.vy < -0.2) {
            dismiss();
          } else {
            Animated.spring(translateY, {
              toValue: 0,
              friction: 7,
              useNativeDriver: true,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateY, { toValue: 0, friction: 7, useNativeDriver: true }).start();
        },
      }),
    [dismiss, translateY],
  );

  // 위쪽 스와이프 힌트: 화살표가 위로 흐르듯
  const arrowTranslate = arrowAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -14] });
  const arrowOpacity = arrowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });

  return (
    <Animated.View
      style={[styles.introCard, { transform: [{ translateY }] }]}
      {...panResponder.panHandlers}
    >
      <View style={styles.introTapArea}>
        <View style={[styles.introTop, { paddingTop: topInset + 24 }]}>
          <View style={[styles.introBadge, { borderColor: accentColor + '60', backgroundColor: accentColor + '20' }]}>
            <Ionicons name="sparkles" size={12} color={accentColor} />
            <Text style={[styles.introBadgeText, { color: accentColor }]}>시작</Text>
          </View>
        </View>

        <View style={styles.introMiddle}>
          <View style={[styles.startIconCircle, { borderColor: accentColor, backgroundColor: accentColor + '22' }]}>
            <Ionicons name="play" size={48} color={accentColor} />
          </View>
          <Text style={styles.introTitle}>이제부터 시작해볼까요?</Text>
          <Text style={styles.introSubtitle}>위로 스와이프해서 시작하세요</Text>
        </View>

        <View style={[styles.introBottom, { paddingBottom: bottomInset + 36 }]}>
          <Animated.View
            style={{ transform: [{ translateY: arrowTranslate }], opacity: arrowOpacity }}
          >
            <Ionicons name="chevron-up" size={42} color="#ffffffcc" />
          </Animated.View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  // 웹: 카드 크기는 뷰포트 그대로, 콘텐츠만 가운데 정렬되도록 alignItems 만 추가.
  webContainer: { flex: 1, backgroundColor: '#000', alignItems: 'center' },
  phoneFrame: {
    flex: 1,
    width: '100%',
    alignSelf: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  centered: { justifyContent: 'center', alignItems: 'center' },

  // CARD: 1:3:1 레이아웃
  card: { width: '100%', height: '100%', overflow: 'hidden', backgroundColor: '#000' },

  // 상단 1/5 - 제목 (가운데 정렬)
  topSection: {
    flex: 1,
    paddingHorizontal: 24,
    paddingBottom: 12,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  topInner: { gap: 6, alignItems: 'center', width: '100%' },
  typeBadge: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 4,
    marginBottom: 4,
  },
  typeLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 3 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  titleText: {
    fontSize: 28,
    lineHeight: 36,
    fontWeight: '900',
    letterSpacing: -0.6,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  titlePrefix: {
    fontWeight: '900',
    fontSize: 28,
    lineHeight: 36,
    letterSpacing: -0.6,
  },
  titleMain: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 28,
    lineHeight: 36,
    letterSpacing: -0.6,
  },

  // 중앙 3/5 - 풀블리드 이미지 + 자막
  middleSection: {
    flex: 3,
    backgroundColor: '#111',
  },
  imageWrap: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  imagePlaceholder: { justifyContent: 'center', alignItems: 'center' },
  imageBottomGrad: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '50%',
  },
  decorCircle: { position: 'absolute', borderWidth: 1.5, borderRadius: 9999 },
  dc1: { width: 320, height: 320, top: -100, right: -100 },
  dc2: { width: 240, height: 240, bottom: -60, left: -90 },

  // 자막: 영상 정중앙, 크고 굵고 강한 외곽선
  subtitleArea: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    // 우측 사이드 액션(42px 원 + right:10)과 좌측 웹 네비(40px + left:14)가 자막을 가리지 않도록 양쪽 여유 확보
    left: 64,
    right: 64,
    justifyContent: 'center',
    alignItems: 'center',
  },
  subtitleText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    lineHeight: 30,
    letterSpacing: -0.3,
    textShadowColor: '#000',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },

  // 인터랙션 영역: 영상 정중앙
  middleActions: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 16,
    right: 16,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  oxRow: { flexDirection: 'row', gap: 18, justifyContent: 'center' },
  oxBtn: {
    width: 88, height: 88, borderRadius: 44,
    borderWidth: 3, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  oxBtnText: { fontSize: 38, fontWeight: '900' },

  // 라이트 종이 카드 (퀴즈 3종)
  // 어두운 플레이어 위에 떠 있는 종이 카드 (1.5px ink stroke + 2px hard 그림자)
  quizCardLight: {
    backgroundColor: '#fafbff',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#15171c',
    paddingHorizontal: 14,
    paddingVertical: 14,
    minWidth: 280,
    maxWidth: 360,
    alignSelf: 'center',
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '2px 2px 0 #15171c' } as any)
      : { shadowColor: '#15171c', shadowOffset: { width: 2, height: 2 }, shadowOpacity: 1, shadowRadius: 0 }),
  },
  quizCardModeLabel: {
    fontSize: 11,
    color: '#82869a',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 10,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace' }),
  },

  // OX 라이트 버튼
  oxBtnLight: {
    width: 66, height: 66, borderRadius: 14,
    borderWidth: 2,
    backgroundColor: '#fafbff',
    justifyContent: 'center', alignItems: 'center',
  },
  oxBtnTextLight: { fontSize: 30, fontWeight: '900' },

  // MCQ 옵션
  mcqOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#15171c',
    backgroundColor: '#fafbff',
  },
  mcqOptLetter: {
    width: 26, height: 26, borderRadius: 8,
    borderWidth: 1.5, borderColor: '#15171c',
    backgroundColor: '#eef0f7',
    alignItems: 'center', justifyContent: 'center',
  },
  mcqOptLetterText: { fontSize: 13, fontWeight: '800', color: '#15171c' },
  mcqOptText: { flex: 1, fontSize: 14, color: '#15171c' },

  // Fillblank 입력
  fillInput: {
    backgroundColor: '#eef0f7',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#15171c',
    paddingHorizontal: 12, paddingVertical: 12,
    fontSize: 16, color: '#15171c',
    marginBottom: 10,
  },
  fillSubmitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#4F8EF7',
  },
  fillSubmitText: { color: '#fafbff', fontSize: 15, fontWeight: '700' },
  oxResultBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, borderWidth: 1.5,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  oxResultText: { fontSize: 14, fontWeight: '700' },
  // OX 선택 직후 표시되는 큰 결과 배너 (answer phase 내내 상단에 표시)
  oxResultBannerWrap: {
    position: 'absolute', top: 16, left: 0, right: 0,
    alignItems: 'center', zIndex: 10,
  },
  oxResultBannerLarge: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 999, borderWidth: 2,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  oxResultTextLarge: { fontSize: 20, fontWeight: '900', color: '#fff', letterSpacing: 0.3 },
  revealBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 24, paddingVertical: 14, borderRadius: 14, borderWidth: 2, gap: 7,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  revealText: { fontSize: 15, fontWeight: '800' },
  ppBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 9,
    borderRadius: 20, borderWidth: 1.5, gap: 6,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  ppText: { fontSize: 13, fontWeight: '700' },
  exampleJudgeRow: { flexDirection: 'row', gap: 10, alignSelf: 'stretch' },
  exampleJudgeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, borderRadius: 12, borderWidth: 1.5,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  exampleJudgeText: { fontSize: 14, fontWeight: '700' },

  // 하단 1/5 - 과목명 (해시태그 제거됨)
  bottomSection: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 12,
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  bottomInner: {},
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
  },
  subjectText: { fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },
  typeBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    position: 'relative',
  },
  wrongChipRow: {
    position: 'absolute',
    right: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    justifyContent: 'flex-end',
  },
  wrongChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3,
    backgroundColor: '#00000080', borderRadius: 8,
    borderWidth: 1, borderColor: '#ffffff20',
  },
  wrongChipText: { fontSize: 11, fontWeight: '700' },

  // 진행바
  progressBg: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, backgroundColor: '#ffffff15' },
  progressFill: { height: 3 },

  // OVERLAY (top bar + side buttons)
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 6,
  },
  topBarSide: {
    width: 80,
    justifyContent: 'center',
  },
  topBarCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#00000055', justifyContent: 'center', alignItems: 'center',
  },
  progressDots: { width: 140, height: 12, overflow: 'hidden', justifyContent: 'center' },
  pdot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#ffffff33' },
  pdotActive: { width: 16, height: 5, borderRadius: 2.5 },
  counter: { color: '#ffffffbb', fontSize: 13, fontWeight: '700' },

  // 우측 사이드바 (Shorts 스타일): 북마크 + TTS + 셔플
  sideActions: { position: 'absolute', right: 10, bottom: 110, gap: 16, alignItems: 'center' },

  // 중앙 하단 재생 컨트롤 바 (이전 문장 / 재생·일시정지 / 다음 문장)
  playbackBarWrap: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    alignItems: 'center',
  },
  playbackBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 28,
    paddingHorizontal: 22,
    paddingVertical: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#ffffff20',
  },
  playbackSideBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#ffffff14',
  },
  playbackPlayBtn: {
    width: 54, height: 54, borderRadius: 27,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5,
  },

  // 세로 볼륨 페이더
  faderWrap: { alignItems: 'center', gap: 4 },
  faderPill: {
    // 다른 사이드 버튼(sideBtnCircle: 원형, 어두운 반투명 배경)과 톤 통일
    backgroundColor: '#00000055',
    borderWidth: 1,
    borderColor: '#ffffff25',
    borderRadius: 26, // width/2 (= 알약 모양)
  },
  faderHitArea: {
    // 트랙 주변 padding으로 hit area 확장 → 페이더 근처 터치를 모두 캐치해 부모 스와이프 차단
    paddingHorizontal: 18,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faderTrack: {
    width: 8,
    backgroundColor: '#ffffff20',
    borderRadius: 4,
    overflow: 'visible',
    justifyContent: 'flex-end',
  },
  faderFill: {
    width: '100%',
    backgroundColor: '#4F8EF7',
    borderRadius: 4,
  },
  faderKnob: {
    position: 'absolute',
    left: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#4F8EF7',
    marginBottom: -10,
  },
  faderLabel: { color: '#ffffffcc', fontSize: 10, fontWeight: '700' },
  sideBtn: { alignItems: 'center', gap: 3 },
  sideBtnCircle: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: '#00000055', borderWidth: 1, borderColor: '#ffffff25',
    justifyContent: 'center', alignItems: 'center',
  },
  sideBtnLabel: { color: '#ffffffcc', fontSize: 10, fontWeight: '700' },

  // 모바일 플레이어 "더보기" 메뉴 (속도, 셔플 등)
  extraOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  extraSheet: {
    width: '100%',
    backgroundColor: '#1A1A1A',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 12,
    paddingBottom: 28,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderColor: '#2A2A2A',
    gap: 4,
  },
  extraRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  extraLabel: { flex: 1, color: '#eee', fontSize: 15, fontWeight: '600' },
  extraValue: { fontSize: 13, fontWeight: '700' },

  // 배속 picker 팝업: 0.75/1/1.25/1.5 직접 선택 (바텀 시트, ExtraMenu와 동일 결)
  rateSheet: {
    width: '100%',
    backgroundColor: '#1A1A1A',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 14,
    paddingBottom: 28,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderColor: '#2A2A2A',
    gap: 8,
  },
  rateSheetTitle: {
    color: '#aaa', fontSize: 12, fontWeight: '700',
    textAlign: 'center', marginBottom: 8, letterSpacing: 0.5,
  },
  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: '#0D0D0D',
    borderWidth: 1,
    borderColor: '#222',
  },
  rateRowText: { color: '#eee', fontSize: 16, fontWeight: '700' },

  // 웹 네비게이션
  webNavRow: { position: 'absolute', left: 14, top: '50%', gap: 10, transform: [{ translateY: -50 }] },
  webNavBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#00000055', justifyContent: 'center', alignItems: 'center' },
  webNavBtnDisabled: { opacity: 0.3 },

  emptyText: { color: '#fff', fontSize: 18, marginBottom: 20 },
  backBtn: { backgroundColor: '#4F8EF7', borderRadius: 12, padding: 14 },
  backBtnText: { color: '#fff', fontWeight: '700' },
  toast: {
    position: 'absolute', top: 60, alignSelf: 'center',
    backgroundColor: '#F97316', borderRadius: 20, paddingHorizontal: 20, paddingVertical: 8, zIndex: 100,
  },
  toastText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  // 오디오 차단 시 표시되는 활성화 배너 (음성 unlock용)
  audioBanner: {
    position: 'absolute',
    top: 80, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: '#EF4444', borderRadius: 999,
    zIndex: 200,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  audioBannerText: { color: '#fff', fontWeight: '800', fontSize: 14 },

  // 0번째 쇼츠: 인트로 카드
  introCard: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    paddingHorizontal: 32,
  },
  introTapArea: { flex: 1 },
  introTop: {
    paddingBottom: 12,
    alignItems: 'center',
  },
  introBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  introBadgeText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.3 },
  introMiddle: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  introTitle: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '900',
    marginTop: 28,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  introSubtitle: {
    color: '#ffffffaa',
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
  },
  introBottom: {
    alignItems: 'center',
  },
  startIconCircle: {
    width: 108, height: 108, borderRadius: 54,
    borderWidth: 2,
    justifyContent: 'center', alignItems: 'center',
  },
});
