// 숏폼 생성 작업 관리자: 백그라운드에서 여러 작업을 동시에 유지.
// 업로드 화면이 unmount돼도 작업이 계속 돌아가도록 모듈 레벨 상태로 관리.
// 다른 화면에 떠있는 GenerationStatusBanner가 진행/완료/오류를 알림.
import { addDoc, collection, doc, getDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { generateShortForms, FileInput, GenerationDensity } from './gemini';
import { awardXP } from './levelSystem';

export interface GenerationProgress {
  current: number;
  total: number;
  generated: number;
  message?: string;
}

export type GenerationStatus = 'running' | 'done' | 'error';

export interface GenerationJob {
  id: string;
  userId: string;
  projectId: string;
  projectTitle: string;
  /** 화면에 표시될 식별자: 단원명/파일명/대표 텍스트 중 가장 의미 있는 것 */
  label: string;
  folderId: string | null;
  status: GenerationStatus;
  progress: { msg: string; detail: string };
  generatedCount: number;
  errorMessage?: string;
  startedAt: number;
  endedAt?: number;
}

// 진행/완료/오류 모든 job을 보관. 사용자가 명시적으로 dismiss할 때까지 유지.
const activeJobs: Map<string, GenerationJob> = new Map();
const listeners = new Set<(jobs: GenerationJob[]) => void>();

// 동시 실행 가능 작업 수 (UI 혼잡 + Gemini rate limit 고려)
const MAX_CONCURRENT = 3;

function snapshot(): GenerationJob[] {
  // 최신 작업이 위로 오도록 startedAt desc 정렬
  return Array.from(activeJobs.values()).sort((a, b) => b.startedAt - a.startedAt);
}

function notify(): void {
  const arr = snapshot();
  for (const l of listeners) {
    try { l(arr); } catch {}
  }
  // job 추가/완료 → rank가 바뀌었을 수 있으므로 throttle 깨움
  // 순환 import: 동적 require로 회피 (모듈 초기화 시점 의존성 끊기)
  try {
    const { rebalance } = require('./apiThrottle');
    rebalance?.();
  } catch {}
}

function patchJob(jobId: string, patch: Partial<GenerationJob>): void {
  const cur = activeJobs.get(jobId);
  if (!cur) return;
  activeJobs.set(jobId, { ...cur, ...patch });
  notify();
}

function patchProgress(jobId: string, msg: string, detail: string): void {
  patchJob(jobId, { progress: { msg, detail } });
}

export function getJobs(): GenerationJob[] {
  return snapshot();
}

export function getJob(id: string): GenerationJob | undefined {
  return activeJobs.get(id);
}

export function getRunningCount(): number {
  let n = 0;
  for (const j of activeJobs.values()) if (j.status === 'running') n++;
  return n;
}

/**
 * 우선순위 산정용 rank: 진행 중(running)인 job 중 startedAt 오름차순 인덱스.
 * 가장 오래된(=먼저 시작된) running job이 0, 그 다음이 1...
 * 종료/오류 상태는 무시. 등록 안 된 jobId는 -1.
 */
export function getJobRank(jobId: string): number {
  const runningOrdered = Array.from(activeJobs.values())
    .filter((j) => j.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt);
  const idx = runningOrdered.findIndex((j) => j.id === jobId);
  return idx;
}

export function subscribe(cb: (jobs: GenerationJob[]) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function dismissJob(id: string): void {
  if (activeJobs.has(id)) {
    activeJobs.delete(id);
    notify();
  }
}

// 완료/오류 상태인 모든 job 일괄 정리
export function dismissAllFinished(): void {
  let changed = false;
  for (const [id, job] of Array.from(activeJobs.entries())) {
    if (job.status !== 'running') {
      activeJobs.delete(id);
      changed = true;
    }
  }
  if (changed) notify();
}

export interface StartParams {
  userId: string;
  projectId: string;
  projectTitle: string;
  folderId: string | null;
  fileInput: FileInput;
  unitName: string;
  /** 업로드한 파일의 이름 (label 추출용) */
  fileName?: string;
  pageRange?: { start: number; end: number };
  /** 생성 밀도: 'summary' | 'standard' | 'detailed'. 누락 시 'standard' */
  density?: GenerationDensity;
}

// label 추출: 단원명 > 파일명 > 텍스트 입력 첫 30자 > 프로젝트명
function buildLabel(params: StartParams): string {
  const unit = params.unitName?.trim();
  if (unit) return unit;
  const fn = params.fileName?.trim();
  if (fn) {
    // 확장자 제거
    return fn.replace(/\.[^./\\]+$/, '');
  }
  if (params.fileInput.kind === 'text' && params.fileInput.content) {
    // 첫 문장 또는 30자
    const text = params.fileInput.content.trim().replace(/\s+/g, ' ');
    const firstSentence = text.match(/^[^.!?。!?]+[.!?。!?]?/)?.[0] ?? text;
    return firstSentence.length > 30 ? firstSentence.slice(0, 30) + '…' : firstSentence;
  }
  return params.projectTitle || '프로젝트';
}

// 새 작업 시작. 동시 실행 한도 초과 시 reject.
// 반환: jobId (즉시). 실제 작업은 백그라운드에서 진행.
export function startGeneration(params: StartParams): string {
  if (getRunningCount() >= MAX_CONCURRENT) {
    throw new Error(`동시에 최대 ${MAX_CONCURRENT}개까지 생성 가능합니다`);
  }
  const id = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeJobs.set(id, {
    id,
    userId: params.userId,
    projectId: params.projectId,
    projectTitle: params.projectTitle,
    label: buildLabel(params),
    folderId: params.folderId,
    status: 'running',
    progress: { msg: '📖 학습 자료 분석 중...', detail: 'AI가 파일을 읽고 있습니다' },
    generatedCount: 0,
    startedAt: Date.now(),
  });
  notify();

  // 백그라운드 실행: await 안 하고 fire-and-forget
  runJob(id, params).catch((e) => {
    if (!activeJobs.has(id)) return; // dismiss됨
    patchJob(id, {
      status: 'error',
      errorMessage: e?.message ?? '알 수 없는 오류',
      endedAt: Date.now(),
    });
  });

  return id;
}

async function runJob(jobId: string, params: StartParams): Promise<void> {
  const raw = await generateShortForms(
    params.fileInput,
    params.unitName.trim(),
    params.pageRange,
    (p) => {
      if (!activeJobs.has(jobId)) return;
      const msg = p.total > 1
        ? `📖 분석 진행 ${Math.min(p.current + 1, p.total)}/${p.total}`
        : '📖 학습 자료 분석 중...';
      patchProgress(jobId, msg, p.message ?? `누적 ${p.generated}개 생성`);
    },
    jobId,
    params.density,
  );

  if (!activeJobs.has(jobId)) return;

  const TYPE_ORDER: Record<string, number> = { concept: 0, example: 1, quiz: 2 };
  const scripts = raw
    .filter(s => ['concept', 'example', 'quiz'].includes(s.type))
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99));

  patchProgress(jobId, '💾 콘텐츠 저장 중...', `${scripts.length}개 항목을 저장합니다`);

  const projDoc = await getDoc(doc(db, 'projects', params.projectId));
  if (!projDoc.exists()) {
    throw new Error('프로젝트가 삭제되어 저장할 수 없습니다');
  }

  for (let i = 0; i < scripts.length; i++) {
    if (!activeJobs.has(jobId)) return;
    const s = scripts[i];
    // quiz 모드 필드는 type==='quiz'이고 값이 있을 때만 저장. Firestore는 undefined 거부.
    const quizFields: Record<string, any> = {};
    if (s.type === 'quiz') {
      if (s.quizMode) quizFields.quizMode = s.quizMode;
      if (s.quizMode === 'mcq' && Array.isArray(s.choices) && typeof s.answerIndex === 'number') {
        quizFields.choices = s.choices;
        quizFields.answerIndex = s.answerIndex;
      } else if (s.quizMode === 'fillblank' && typeof s.blankAnswer === 'string') {
        quizFields.blankAnswer = s.blankAnswer;
      }
    }
    await addDoc(collection(db, 'shortforms'), {
      projectId: params.projectId,
      folderId: params.folderId,
      userId: params.userId,
      type: s.type,
      content: { title: s.title, script: s.script },
      imageKeywords: s.imageKeywords ?? [],
      importance: s.importance ?? 5,
      ...quizFields,
      ...(s.parentConceptTitle ? { parentConceptTitle: s.parentConceptTitle } : {}),
      order: i,
      createdAt: serverTimestamp(),
    });
  }

  if (!activeJobs.has(jobId)) return;
  patchJob(jobId, {
    status: 'done',
    generatedCount: scripts.length,
    endedAt: Date.now(),
    progress: { msg: '✅ 생성 완료', detail: `${scripts.length}개 항목 추가됨` },
  });
  // 생성 완료 보너스 XP
  awardXP(params.userId, 'project_generated').catch(() => {});
}
