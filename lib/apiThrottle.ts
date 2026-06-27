// 우선순위 기반 글로벌 API 슬롯.
// 모든 Gemini/OpenRouter 호출이 이 throttle을 통과해야 함.
//
// 정책:
// - 전역 동시 호출 한도: POOL_CAPACITY
// - job 별 동시 호출 한도: rank 0(가장 오래된) → CAP_RANK_0, rank 1+ → CAP_RANK_REST
// - 우선순위: rank가 낮은(오래된) job의 대기자가 먼저 슬롯 획득
// - rank 0 job이 종료되면 rank 1이 0으로 승격 → 자동으로 큰 cap 적용 (다음 acquire부터)
//
// jobId가 없는 호출(레거시)은 단일 가상 job으로 처리되어 정상 동작.
import { getJobRank } from './generationManager';
import { getFastModeSync, getProviderSync } from './aiSettings';

const FAST_POOL_CAPACITY = 8;
const FAST_CAP_RANK_0 = 6;
const FAST_CAP_RANK_REST = 2;
// 슬로우 모드: 사용자 키 미등록 시. 전체 1개씩 직렬 처리.
const SLOW_POOL_CAPACITY = 1;
const SLOW_CAP = 1;
// Cerebras 무료 tier: 출력 throughput은 미친 듯이 빠른데 분당/초당 요청 수 한도가 빡빡.
// burst로 fire하면 즉시 429 폭격. 동시성 + 최소 요청 간격 두 단계로 throttle.
// 출력 자체가 너무 빨라서 동시성 낮아도 체감 차이 크지 않음.
const CEREBRAS_POOL_CAPACITY = 2;
const CEREBRAS_CAP_PER_JOB = 2;
// Cerebras 요청 사이 최소 간격(ms). 마지막 acquire로부터 이만큼 안 지났으면 차이만큼 지연.
// 실제 한도는 RPM이 아니라 TPM(분당 토큰), 청크당 60~100k 토큰이라 burst하면 즉시 TPM 초과 429.
// 5초 간격 = 분당 12 req × 평균 75k = ~900k tok/min로 1M TPM 한도 직전에서 평탄화.
// 가끔 맞는 429는 withRetry(5→10→20s)로 빠르게 회수.
const CEREBRAS_MIN_INTERVAL_MS = 5000;

const NO_JOB = '__none__';

type Waiter = { jobId: string; resolve: () => void };

let inUse = 0;
const inUsePerJob = new Map<string, number>();
const waiters: Waiter[] = [];
// Cerebras burst throttle용: 마지막 슬롯 부여 시각
let lastCerebrasAcquireAt = 0;

function getPoolCapacity(): number {
  const p = getProviderSync();
  // Cerebras는 분당 요청 수 한도가 빡빡 → 다른 모드보다 동시성 낮춤
  if (p === 'cerebras') return CEREBRAS_POOL_CAPACITY;
  // OpenAI는 paid tier라 RPM 한도 넉넉 → 빠른 모드 cap 그대로 사용
  if (p === 'openai') return FAST_POOL_CAPACITY;
  return getFastModeSync() ? FAST_POOL_CAPACITY : SLOW_POOL_CAPACITY;
}

function getJobCap(jobId: string): number {
  const p = getProviderSync();
  if (p === 'cerebras') return CEREBRAS_CAP_PER_JOB;
  if (p === 'openai') {
    // OpenAI도 빠른 모드처럼 rank별 cap 분배
    if (jobId === NO_JOB) return FAST_POOL_CAPACITY;
    const rank = getJobRank(jobId);
    if (rank < 0) return 1;
    if (rank === 0) return FAST_CAP_RANK_0;
    return FAST_CAP_RANK_REST;
  }
  if (!getFastModeSync()) return SLOW_CAP; // 슬로우: 누구든 1개씩
  if (jobId === NO_JOB) return FAST_POOL_CAPACITY;
  const rank = getJobRank(jobId);
  if (rank < 0) return 1;
  if (rank === 0) return FAST_CAP_RANK_0;
  return FAST_CAP_RANK_REST;
}

function tryWake(): void {
  if (inUse >= getPoolCapacity() || waiters.length === 0) return;
  // 우선순위 재정렬 (rank 낮은 = 오래된 job 우선)
  waiters.sort((a, b) => {
    const ra = a.jobId === NO_JOB ? 9999 : getJobRank(a.jobId);
    const rb = b.jobId === NO_JOB ? 9999 : getJobRank(b.jobId);
    return ra - rb;
  });
  // 캡 안 걸리는 첫 waiter를 깨움
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    const myInUse = inUsePerJob.get(w.jobId) ?? 0;
    if (myInUse < getJobCap(w.jobId)) {
      waiters.splice(i, 1);
      // 자원 차감은 acquire를 호출한 waiter 측이 해야 정확하므로 여기선 그냥 resolve만.
      // 하지만 race 방지를 위해 미리 카운터 올림.
      inUse++;
      inUsePerJob.set(w.jobId, myInUse + 1);
      w.resolve();
      return;
    }
  }
}

/** API 슬롯 획득. release 함수를 반환. */
export async function acquireApiSlot(jobId: string | null | undefined): Promise<() => void> {
  const jid = jobId || NO_JOB;
  const myInUse = inUsePerJob.get(jid) ?? 0;
  if (inUse < getPoolCapacity() && myInUse < getJobCap(jid)) {
    inUse++;
    inUsePerJob.set(jid, myInUse + 1);
  } else {
    // 대기열 진입
    await new Promise<void>((resolve) => {
      waiters.push({ jobId: jid, resolve });
    });
    // tryWake가 inUse/inUsePerJob을 미리 증가시킨 상태로 resolve함.
  }
  // Cerebras 전용: 슬롯은 받았지만 burst 방지를 위해 최소 간격 강제.
  // 동시 호출이 2개면 둘 다 여기서 직렬화돼서 1초 간격으로 빠져나감.
  if (getProviderSync() === 'cerebras') {
    const now = Date.now();
    const wait = CEREBRAS_MIN_INTERVAL_MS - (now - lastCerebrasAcquireAt);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    lastCerebrasAcquireAt = Date.now();
  }
  return () => releaseApiSlot(jid);
}

function releaseApiSlot(jobId: string): void {
  inUse = Math.max(0, inUse - 1);
  const cur = inUsePerJob.get(jobId) ?? 0;
  if (cur <= 1) inUsePerJob.delete(jobId);
  else inUsePerJob.set(jobId, cur - 1);
  // 다른 대기자에게 슬롯 줄 수 있는지 확인: 여러 번 시도 (멀티 슬롯 동시 회수 케이스 대비)
  for (let i = 0; i < FAST_POOL_CAPACITY; i++) {
    const beforeUse = inUse;
    tryWake();
    if (inUse === beforeUse) break; // 더 못 깨움
  }
}

/** rank가 바뀌었을 가능성이 있는 시점에 호출: manager가 job 추가/삭제 시 트리거 */
export function rebalance(): void {
  for (let i = 0; i < FAST_POOL_CAPACITY; i++) {
    const beforeUse = inUse;
    tryWake();
    if (inUse === beforeUse) break;
  }
}
