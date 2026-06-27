// Cloudflare Worker - Edge TTS 프록시
// 모바일/웹 앱에서 직접 MS Edge TTS 서버에 붙으면 브라우저는 Origin 제약으로 403, 모바일도 향후 정책 변경 위험.
// Worker는 서버처럼 Origin 헤더를 자유롭게 설정할 수 있어 안정적으로 통과.
// 요청 시에만 실행, 무료 티어 하루 10만 요청.

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VERSION = '143.0.3650.96';
// MS가 화이트리스트에 둔 Origin (Edge 브라우저의 Read Aloud 확장 ID)
const SPOOF_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

interface SynthesizeRequest {
  text: string;
  voice: string; // e.g. 'ko-KR-SunHiNeural'
  rate?: number;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return new Response('POST /tts only', { status: 405, headers: CORS_HEADERS });
    }

    let body: SynthesizeRequest;
    try {
      body = (await request.json()) as SynthesizeRequest;
    } catch {
      return jsonError('invalid JSON', 400);
    }
    if (!body?.text || !body?.voice) {
      return jsonError('text and voice required', 400);
    }
    if (body.text.length > 4000) {
      return jsonError('text too long (max 4000 chars)', 413);
    }

    try {
      const mp3 = await synthesizeMp3(body.text, body.voice, body.rate ?? 1.0);
      return new Response(mp3, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'audio/mpeg',
          // CDN에서도 캐시 가능 (같은 text+voice+rate는 동일 mp3)
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (e: any) {
      return jsonError(e?.message ?? 'synthesis failed', 502);
    }
  },
};

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function sha256Upper(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

async function generateSecMsGec(): Promise<string> {
  // Windows FileTime ticks: 1601-01-01 UTC 기준 100ns 단위
  // 5분(3,000,000,000 ticks) 단위로 라운드 다운 → MS가 검증
  const ticks = BigInt(Date.now() + 11644473600000) * 10000n;
  const rounded = ticks - (ticks % 3000000000n);
  return sha256Upper(`${rounded.toString()}${TRUSTED_CLIENT_TOKEN}`);
}

function uuid32(): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ratePct(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return (pct >= 0 ? '+' : '') + pct + '%';
}

function extractAudio(data: ArrayBuffer): Uint8Array | null {
  const bytes = new Uint8Array(data);
  if (bytes.length < 2) return null;
  const headerLen = (bytes[0] << 8) | bytes[1];
  if (bytes.length < 2 + headerLen) return null;
  const headerStr = new TextDecoder().decode(bytes.slice(2, 2 + headerLen));
  if (!headerStr.includes('Path:audio')) return null;
  return bytes.slice(2 + headerLen);
}

async function synthesizeMp3(text: string, voice: string, rate: number): Promise<Uint8Array> {
  const gec = await generateSecMsGec();
  const connectionId = uuid32();
  const url =
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}` +
    `&ConnectionId=${connectionId}`;

  // Cloudflare Worker의 outgoing WebSocket 패턴: fetch with Upgrade header → resp.webSocket
  const upstream = await fetch(url, {
    headers: {
      'Upgrade': 'websocket',
      'Origin': SPOOF_ORIGIN,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        `(KHTML, like Gecko) Chrome/${CHROMIUM_VERSION} Safari/537.36 Edg/${CHROMIUM_VERSION}`,
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const ws = (upstream as any).webSocket as WebSocket | undefined;
  if (!ws) {
    // 디버그: 응답 본문/헤더 확인 (다음 배포 후 wrangler tail로 보임)
    let body = '';
    try { body = await upstream.text(); } catch {}
    const respHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => { respHeaders[k] = v; });
    console.log('upstream status:', upstream.status, 'headers:', respHeaders, 'body:', body.slice(0, 500));
    throw new Error(`upstream rejected (status ${upstream.status}): ${body.slice(0, 200)}`);
  }
  ws.accept();

  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      action();
    };

    const timeout = setTimeout(() => finish(() => reject(new Error('upstream timeout'))), 30000);

    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) {
          clearTimeout(timeout);
          finish(() => {
            const total = chunks.reduce((s, c) => s + c.length, 0);
            const merged = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { merged.set(c, off); off += c.length; }
            resolve(merged);
          });
        }
        return;
      }
      const audio = extractAudio(event.data as ArrayBuffer);
      if (audio && audio.length > 0) chunks.push(audio);
    });

    ws.addEventListener('error', () => finish(() => reject(new Error('upstream ws error'))));
    ws.addEventListener('close', () => {
      if (settled) return;
      clearTimeout(timeout);
      if (chunks.length > 0) {
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        settled = true;
        resolve(merged);
      } else {
        settled = true;
        reject(new Error('upstream closed without audio'));
      }
    });

    // 1. audio config
    ws.send(
      `X-Timestamp:${new Date().toISOString()}\r\n` +
      `Content-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`,
    );

    // 2. SSML
    const ssml =
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ko-KR'>` +
      `<voice name='${voice}'>` +
      `<prosody rate='${ratePct(rate)}' pitch='+0Hz'>${escapeSsml(text)}</prosody>` +
      `</voice></speak>`;
    ws.send(
      `X-RequestId:${uuid32()}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${new Date().toISOString()}\r\n` +
      `Path:ssml\r\n\r\n` +
      ssml,
    );
  });
}
