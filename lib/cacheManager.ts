// 캐시 관리: Edge TTS mp3 디스크 캐시 자동 정리.
// 정책: 현재 사용자의 shortform이 만들어낼 cache key 집합에 없는 mp3는 모두 삭제.
// 호출 시점: 로그인 후 1회 (app/_layout.tsx).
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from './firebase';
import { getCachedVoiceId, loadSavedVoiceId } from './ttsVoice';
import { isEdgeVoiceId, edgeVoiceNameFromId } from './edgeTts';

const CACHE_DIR = (FileSystem.cacheDirectory ?? '') + 'edge-tts/';
const SSML_RATE = 1.2; // 플레이어가 사용하는 고정 SSML rate

function cacheKey(text: string, voice: string, rate: number): string {
  const payload = `${voice}|${rate.toFixed(2)}|${text}`;
  return bytesToHex(sha256(new TextEncoder().encode(payload))).slice(0, 32);
}

// 플레이어의 chunkScript와 동일, 변경 시 동기화 필요
function chunkScript(script: string): string[] {
  if (!script) return [];
  const sentences = script.match(/.+?(?:[.!?。！？]+(?=\s|$)|$)/g) || [script];
  const out: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= 100) { out.push(s); continue; }
    const parts = s.split(/(?<=[,，、])\s*/);
    for (const p of parts) if (p.trim()) out.push(p.trim());
  }
  return out.length > 0 ? out : [script.trim()];
}

// 플레이어의 splitQuizScript와 동일, 변경 시 동기화 필요
function splitQuizScript(script: string): { question: string; answer: string } {
  let trimmed = script.trim();
  const earlyAnswer = trimmed.match(/^(정답[은:]?\s*[OXox오엑스X][^.\n]*[.\n]\s*)/);
  if (earlyAnswer) {
    const answerHead = earlyAnswer[1].trim();
    const rest = trimmed.slice(earlyAnswer[1].length).trim();
    if (rest.length > 0) trimmed = `${rest}\n\n${answerHead}`;
  }
  const keywords = ['정답은', '정답:', '답은', '답:', '해설:'];
  for (const kw of keywords) {
    const idx = trimmed.indexOf(kw);
    if (idx > 5) return { question: trimmed.slice(0, idx).trim(), answer: trimmed.slice(idx).trim() };
  }
  const match = trimmed.match(/^(.+?[?!？！]+\s*)/);
  if (match && match[1].length < trimmed.length * 0.75) {
    return { question: match[1].trim(), answer: trimmed.slice(match[1].length).trim() };
  }
  const words = trimmed.split(' ');
  const mid = Math.ceil(words.length * 0.45);
  return { question: words.slice(0, mid).join(' '), answer: words.slice(mid).join(' ') };
}

/** 현재 사용자의 shortform에서 만들어낼 캐시 key 집합: "사용 중"으로 간주할 키 */
async function computeUsedKeys(userId: string): Promise<Set<string>> {
  const used = new Set<string>();
  const voiceId = getCachedVoiceId();
  if (!isEdgeVoiceId(voiceId)) {
    // Edge TTS가 아니면 mp3 캐시는 모두 "미사용"
    return used;
  }
  const voice = edgeVoiceNameFromId(voiceId);

  const snap = await getDocs(query(collection(db, 'shortforms'), where('userId', '==', userId)));
  for (const d of snap.docs) {
    const data = d.data() as any;
    const type = data.type as string;
    const script: string = data.content?.script ?? '';
    if (!script) continue;

    // 카드 타입에 따라 chunking 경로가 다르므로 양쪽 다 union (over-include 허용)
    const allChunks: string[] = [];
    allChunks.push(...chunkScript(script));
    if (type === 'quiz' || type === 'example') {
      const { question, answer } = splitQuizScript(script);
      allChunks.push(...chunkScript(question));
      allChunks.push(...chunkScript(answer));
    }
    for (const c of allChunks) {
      used.add(cacheKey(c, voice, SSML_RATE));
    }
  }
  return used;
}

/**
 * 사용 중이 아닌 Edge TTS mp3 캐시를 모두 삭제. 실패해도 throw 하지 않음 (fire-and-forget 용도).
 * voiceId 모듈 캐시가 아직 비어 있으면 먼저 디스크에서 로드 (그 전에 호출되면 used 집합이 비어 전부 삭제될 위험).
 */
export async function cleanupUnusedCache(userId: string): Promise<{ deleted: number; freedBytes: number }> {
  if (Platform.OS === 'web') return { deleted: 0, freedBytes: 0 };

  try {
    const info = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!info.exists) return { deleted: 0, freedBytes: 0 };
  } catch { return { deleted: 0, freedBytes: 0 }; }

  let files: string[];
  try {
    files = (await FileSystem.readDirectoryAsync(CACHE_DIR)).filter((f) => f.endsWith('.mp3'));
  } catch { return { deleted: 0, freedBytes: 0 }; }
  if (files.length === 0) return { deleted: 0, freedBytes: 0 };

  // 모듈 캐시 비었으면 디스크에서 한 번 로드, 안 하면 isEdgeVoiceId(null)로 빠져 used가 비어 전부 삭제됨
  if (getCachedVoiceId() === null) {
    try { await loadSavedVoiceId(); } catch {}
  }

  let usedKeys: Set<string>;
  try {
    usedKeys = await computeUsedKeys(userId);
  } catch {
    // shortforms 조회 실패 시엔 보수적으로 중단 (잘못 삭제하면 다시 다운받아야 함)
    return { deleted: 0, freedBytes: 0 };
  }

  let deleted = 0;
  let freedBytes = 0;
  for (const f of files) {
    const key = f.replace(/\.mp3$/, '');
    if (usedKeys.has(key)) continue;
    const fullPath = CACHE_DIR + f;
    try {
      const stat = await FileSystem.getInfoAsync(fullPath);
      const size = (stat as any).size ?? 0;
      await FileSystem.deleteAsync(fullPath, { idempotent: true });
      deleted++;
      freedBytes += size;
    } catch {}
  }
  return { deleted, freedBytes };
}
