// 홈탭 진입 즉시 표시용 prefetch.
// player 화면이 아닐 때 _layout에서 한 번 호출되며, shortforms 목록 + 랜덤 4픽의 첫 이미지 URL
// + Image.prefetch까지 백그라운드에서 완료해 둔다. 홈탭은 캐시된 데이터를 즉시 표시.
import { collection, getDocs, query, where } from 'firebase/firestore';
import { Image } from 'react-native';
import { db } from './firebase';
import { fetchBackgroundMedia } from './imageSearch';

export interface PrefetchedShort {
  id: string;
  projectId: string;
  title: string;
  type: 'concept' | 'example' | 'quiz';
  script?: string;
  imageKeywords?: string[];
}

interface HomeCache {
  userId: string;
  picks: PrefetchedShort[];
  imageMap: Record<string, string>;
}

let cache: HomeCache | null = null;
let inFlight: Promise<void> | null = null;

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export function getHomeCache(userId: string): HomeCache | null {
  return cache?.userId === userId ? cache : null;
}

export function invalidateHomeCache(): void {
  cache = null;
}

export function prefetchHome(userId: string): Promise<void> {
  if (inFlight) return inFlight;
  if (cache?.userId === userId && cache.picks.length > 0) return Promise.resolve();

  inFlight = (async () => {
    try {
      const sSnap = await getDocs(query(collection(db, 'shortforms'), where('userId', '==', userId)));
      const picks = pickRandom(
        sSnap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            projectId: data.projectId as string,
            title: data.content?.title ?? '제목 없음',
            type: (data.type as 'concept' | 'example' | 'quiz') ?? 'concept',
            script: data.content?.script as string | undefined,
            imageKeywords:
              (data.imageKeywords as string[] | undefined) ??
              (data.imageKeyword ? [data.imageKeyword as string] : undefined),
          };
        }),
        4,
      );
      const imageMap: Record<string, string> = {};
      await Promise.all(
        picks.map(async (sf) => {
          try {
            const urls = await fetchBackgroundMedia(sf.id, sf.title, sf.type, sf.script, sf.imageKeywords);
            if (urls.length > 0) {
              imageMap[sf.id] = urls[0];
              // 디코드까지 미리 완료, 홈 진입 시 즉시 표시
              Image.prefetch(urls[0]).catch(() => {});
            }
          } catch {
            /* 개별 실패 무시 */
          }
        }),
      );
      cache = { userId, picks, imageMap };
    } catch {
      /* 전체 실패 시 다음 트리거에서 재시도 */
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
