// Edge TTS 클라이언트: Cloudflare Worker 프록시 경유
// 직접 wss://speech.platform.bing.com에 붙으려면 브라우저는 Origin 제약으로 403,
// 모바일도 향후 정책 변경 위험이 있어 Worker가 안정적으로 대리 호출.
// worker/ 디렉토리에 배포 코드 + 가이드 있음.

// ⚠️ 배포 후 받은 URL로 교체하세요. 예: https://gongform-edge-tts.<your-subdomain>.workers.dev
export const EDGE_TTS_PROXY_URL = '여기 Worker 주소 입력';

interface SynthesizeOptions {
  text: string;
  voice: string; // 'ko-KR-SunHiNeural' 등 (prefix 없는 voice 이름)
  rate?: number;
  signal?: AbortSignal;
}

// 프록시에 텍스트 보내고 mp3 Uint8Array 받음
export async function synthesizeEdgeTts(opts: SynthesizeOptions): Promise<Uint8Array> {
  const { text, voice, rate = 1.0, signal } = opts;
  const res = await fetch(EDGE_TTS_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, rate }),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = (err as any)?.error ?? '';
    } catch {}
    throw new Error(`edge-tts proxy ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// 사용자 노출용 Edge TTS voice 메타데이터
// MS Edge에서 현재 사용 가능한 ko-KR voice 목록 (2025년 5월 기준).
// 과거에 있던 BongJin/GookMin은 제거됨, 대신 Hyunsu (Multilingual) 추가
export const EDGE_TTS_VOICES = [
  { id: 'edge:ko-KR-SunHiNeural', voiceName: 'ko-KR-SunHiNeural', displayName: 'SunHi (여)', gender: 'Female' },
  { id: 'edge:ko-KR-InJoonNeural', voiceName: 'ko-KR-InJoonNeural', displayName: 'InJoon (남)', gender: 'Male' },
  { id: 'edge:ko-KR-HyunsuMultilingualNeural', voiceName: 'ko-KR-HyunsuMultilingualNeural', displayName: 'Hyunsu (남·다국어)', gender: 'Male' },
] as const;

export function isEdgeVoiceId(id: string | null | undefined): id is string {
  return !!id && id.startsWith('edge:');
}

export function edgeVoiceNameFromId(id: string): string {
  return id.replace(/^edge:/, '');
}
