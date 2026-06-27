import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from './firebase';

const API_KEY = '여기 API 키 입력';
const VEO_MODEL = 'veo-3.1-generate-preview';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const TYPE_STYLE: Record<string, string> = {
  concept:
    'Clean modern educational explainer video. Dark background with glowing blue accent colors. Animated text, icons, and diagrams illustrating the concept. Professional Korean educational content style.',
  example:
    'Step-by-step educational problem-solving video. Dark background with green accent colors. Animated walkthrough with clear visual steps. Korean educational content style.',
  quiz:
    'Interactive quiz video with a question reveal. Dark background with orange accent colors. Bold question text, countdown timer animation, then answer reveal. Korean educational quiz style.',
};

function buildVideoPrompt(
  title: string,
  script: string,
  type: 'concept' | 'example' | 'quiz'
): string {
  const style = TYPE_STYLE[type] ?? TYPE_STYLE.concept;
  // Keep Korean title/script in prompt: Veo 3 handles multilingual prompts
  return `${style} Topic: "${title}". Content: ${script.slice(0, 300)}. Vertical 9:16 format. No human faces. Smooth transitions.`;
}

async function uploadVideoToStorage(
  videoData: { uri?: string; bytesBase64Encoded?: string },
  docId: string
): Promise<string> {
  const storageRef = ref(storage, `shortform-videos/${docId}.mp4`);

  if (videoData.bytesBase64Encoded) {
    // base64 → Uint8Array → upload
    const binary = atob(videoData.bytesBase64Encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await uploadBytes(storageRef, bytes, { contentType: 'video/mp4' });
  } else if (videoData.uri) {
    // Fetch from signed URL and re-upload to Firebase Storage
    const response = await fetch(videoData.uri);
    if (!response.ok) throw new Error(`영상 다운로드 실패: ${response.status}`);
    const blob = await response.blob();
    await uploadBytes(storageRef, blob, { contentType: 'video/mp4' });
  } else {
    throw new Error('영상 데이터가 없습니다.');
  }

  return getDownloadURL(storageRef);
}

async function pollOperation(operationName: string): Promise<string> {
  const maxAttempts = 60; // 최대 5분 (5초 간격)
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 5000));

    const res = await fetch(
      `${API_BASE}/${operationName}?key=${API_KEY}`
    );
    if (!res.ok) throw new Error(`폴링 오류: ${res.status}`);

    const data = await res.json();
    if (data.done) {
      const samples =
        data.response?.generateVideoResponse?.generatedSamples;
      if (!samples?.length) throw new Error('생성된 영상이 없습니다.');
      return JSON.stringify(samples[0].video); // uri or bytesBase64Encoded
    }
    if (data.error) throw new Error(data.error.message ?? '영상 생성 오류');
  }
  throw new Error('영상 생성 시간 초과 (5분)');
}

export async function generateShortFormVideo(
  title: string,
  script: string,
  type: 'concept' | 'example' | 'quiz',
  docId: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const prompt = buildVideoPrompt(title, script, type);

  onProgress?.('Veo에 영상 생성 요청 중...');

  const startRes = await fetch(
    `${API_BASE}/models/${VEO_MODEL}:predictLongRunning?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          aspectRatio: '9:16',
          durationSeconds: 8,
        },
      }),
    }
  );

  if (!startRes.ok) {
    const errText = await startRes.text();
    let msg = `Veo API 오류 (${startRes.status})`;
    try {
      const errJson = JSON.parse(errText);
      msg = errJson.error?.message ?? msg;
    } catch {}
    throw new Error(msg);
  }

  const operation = await startRes.json();
  if (!operation.name) throw new Error('operation name을 받지 못했습니다.');

  onProgress?.('영상 렌더링 중... (최대 2분 소요)');
  const videoJson = await pollOperation(operation.name);
  const videoData = JSON.parse(videoJson);

  onProgress?.('Firebase Storage에 업로드 중...');
  return uploadVideoToStorage(videoData, docId);
}
