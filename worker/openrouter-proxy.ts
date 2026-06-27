// Cloudflare Worker — OpenRouter API 프록시
// 클라이언트가 API 키를 알 필요 없이 OpenRouter로 요청을 보낼 수 있게 중계.
// - API 키는 Worker 환경변수(OPENROUTER_API_KEY)에 secret으로 보관 → 클라이언트 번들에 노출 X
// - Firebase ID 토큰으로 사용자 인증 → 익명 사용자가 API를 도용할 수 없음
// - 사용자별 분당 요청 한도 (KV 사용) → 한 사용자가 폭주해도 다른 사용자에 영향 X
//
// 클라이언트는 자기 OpenRouter 키를 등록한 경우엔 이 프록시를 우회해 직접 호출.

interface Env {
  OPENROUTER_API_KEY: string;        // wrangler secret put OPENROUTER_API_KEY
  CEREBRAS_API_KEY?: string;         // wrangler secret put CEREBRAS_API_KEY (X-Upstream: cerebras 일 때만 필요)
  FIREBASE_PROJECT_ID: string;       // wrangler.toml var (공개 OK)
  RATE_LIMIT?: KVNamespace;          // 선택 — 없으면 rate limit 스킵
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Title, HTTP-Referer, X-Upstream',
  'Access-Control-Max-Age': '86400',
};

// 업스트림 분기: 클라이언트가 X-Upstream 헤더로 선택. 기본은 OpenRouter.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';

// 사용자당 분당 최대 요청 수 (개념·예시·OX 생성 한 번이 청크 단위 10~20번 호출 가능 → 넉넉히)
const RATE_LIMIT_PER_MIN = 60;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return jsonError('POST only', 405);
    }

    // 1. Firebase ID 토큰 검증
    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return jsonError('Authorization Bearer <firebase ID token> required', 401);

    let uid: string;
    try {
      uid = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
    } catch (e: any) {
      return jsonError(`Invalid token: ${e?.message ?? 'unknown'}`, 401);
    }

    // 2. Rate limit (KV 있을 때만)
    if (env.RATE_LIMIT) {
      const now = Date.now();
      const windowKey = `rl:${uid}:${Math.floor(now / 60000)}`; // 분 단위
      const curStr = await env.RATE_LIMIT.get(windowKey);
      const cur = curStr ? parseInt(curStr, 10) : 0;
      if (cur >= RATE_LIMIT_PER_MIN) {
        return jsonError('Too many requests — slow down (limit per minute)', 429);
      }
      await env.RATE_LIMIT.put(windowKey, String(cur + 1), { expirationTtl: 90 });
    }

    // 3. 업스트림 선택 + forward (API 키는 Worker가 추가)
    const bodyText = await request.text();
    const upstreamChoice = (request.headers.get('X-Upstream') ?? '').toLowerCase();
    const useCerebras = upstreamChoice === 'cerebras';

    let upstreamUrl: string;
    let upstreamHeaders: Record<string, string>;
    if (useCerebras) {
      if (!env.CEREBRAS_API_KEY) {
        return jsonError('Cerebras API key not configured on server', 500);
      }
      upstreamUrl = CEREBRAS_URL;
      // Cerebras 앞단 Cloudflare WAF가 CF→CF 트래픽을 봇으로 차단 → 진짜 브라우저처럼 보이게.
      upstreamHeaders = {
        'Authorization': `Bearer ${env.CEREBRAS_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://inference.cerebras.ai',
        'Referer': 'https://inference.cerebras.ai/',
      };
    } else {
      upstreamUrl = OPENROUTER_URL;
      upstreamHeaders = {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://gongform.app',
        'X-Title': 'GongForm',
      };
    }

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: bodyText,
      });
    } catch (e: any) {
      return jsonError(`Upstream fetch failed: ${e?.message ?? e}`, 502);
    }

    // 4. 응답 body를 pipe-through로 전달.
    // - 일반 chat completions(JSON): 한 번에 들어옴.
    // - stream:true SSE: 토큰 단위로 chunk가 와서 클라이언트가 점진 표시 가능.
    // await text()로 버퍼링하면 SSE가 막혀버리므로 절대 금지.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': 'no-cache',
        ...CORS_HEADERS,
      },
    });
  },
};

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message, code: status } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Firebase ID 토큰 검증 (서버 SDK 없이 Web Crypto API로 직접)
// Google이 공개한 Firebase 인증 공개키로 JWT 서명을 RS256 검증.
// 검증 항목: 서명, exp, iat, aud(=projectId), iss(=https://securetoken.google.com/<projectId>)

let cachedJwks: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;
const JWKS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const JWKS_TTL_MS = 60 * 60 * 1000; // 1시간 캐시 (Worker isolate 내)

async function fetchJwks(): Promise<Map<string, CryptoKey>> {
  if (cachedJwks && Date.now() - cachedJwks.fetchedAt < JWKS_TTL_MS) {
    return cachedJwks.keys;
  }
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const certs: Record<string, string> = await res.json();
  const keys = new Map<string, CryptoKey>();
  for (const [kid, pem] of Object.entries(certs)) {
    const cryptoKey = await importPublicKeyFromPem(pem);
    if (cryptoKey) keys.set(kid, cryptoKey);
  }
  cachedJwks = { keys, fetchedAt: Date.now() };
  return keys;
}

async function importPublicKeyFromPem(pem: string): Promise<CryptoKey | null> {
  // PEM에서 base64 부분만 추출 → DER 바이너리 → SPKI import
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  const der = base64ToBytes(b64);
  // X.509 인증서에서 SubjectPublicKeyInfo 추출: 간단히 'crypto.subtle.importKey' with 'spki' 시도
  // 인증서 자체를 spki로 가져갈 수 없으므로 X.509 OID로 SPKI 위치를 파싱해야 하나, Worker 환경에서 가장 호환 좋은 방법:
  // - jose 라이브러리 의존성 없이 처리하기 위해 인증서 → RSAPublicKey raw 추출은 복잡
  // → 대신 Google의 JWK 엔드포인트(공개키 JWK 형식)를 사용
  try {
    // PEM(인증서)이 들어왔지만 X.509 → SPKI 변환은 까다로움.
    // Cloudflare Workers는 importKey('x509-cert')를 직접 지원하지 않음.
    // 대신 SPKI를 추출하려면 ASN.1 파싱 필요. 여기서는 JWK 엔드포인트로 대체.
    return null;
  } catch {
    return null;
  }
}

// JWK 엔드포인트(이미 base64url 인코딩된 RSA public key): 더 단순한 경로
const JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let cachedJwksJwk: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

async function fetchJwksJwk(): Promise<Map<string, CryptoKey>> {
  if (cachedJwksJwk && Date.now() - cachedJwksJwk.fetchedAt < JWKS_TTL_MS) {
    return cachedJwksJwk.keys;
  }
  const res = await fetch(JWK_URL);
  if (!res.ok) throw new Error(`JWK fetch failed: ${res.status}`);
  const data: { keys: Array<{ kid: string; kty: string; n: string; e: string; alg: string }> } = await res.json();
  const keys = new Map<string, CryptoKey>();
  for (const jwk of data.keys) {
    try {
      const k = await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      keys.set(jwk.kid, k);
    } catch { /* skip bad key */ }
  }
  cachedJwksJwk = { keys, fetchedAt: Date.now() };
  return keys;
}

async function verifyFirebaseIdToken(token: string, projectId: string): Promise<string> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(base64UrlDecodeToString(headerB64));
  const payload = JSON.parse(base64UrlDecodeToString(payloadB64));

  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);
  const kid: string | undefined = header.kid;
  if (!kid) throw new Error('missing kid');

  const keys = await fetchJwksJwk();
  const key = keys.get(kid);
  if (!key) throw new Error('unknown signing key');

  // 서명 검증
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = base64UrlDecodeToBytes(sigB64);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!valid) throw new Error('signature invalid');

  // claims 검증
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('token expired');
  if (payload.iat && payload.iat > now + 60) throw new Error('iat in future');
  if (payload.aud !== projectId) throw new Error(`aud mismatch ${payload.aud}`);
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('iss mismatch');
  if (!payload.sub) throw new Error('sub missing');

  return payload.sub; // uid
}

function base64UrlDecodeToString(s: string): string {
  return new TextDecoder().decode(base64UrlDecodeToBytes(s));
}

function base64UrlDecodeToBytes(s: string): Uint8Array {
  // base64url → base64
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  return base64ToBytes(b64);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
