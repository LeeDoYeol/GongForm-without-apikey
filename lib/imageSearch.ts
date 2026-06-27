// Pixabay:  https://pixabay.com/api/docs/  (무료 가입 후 즉시 발급)
// Giphy:    https://developers.giphy.com    (무료 가입, 퀴즈 카드 GIF용 - 비워두면 비활성화)
export const PIXABAY_KEY = '여기 API 키 입력';
export const GIPHY_KEY = '여기 API 키 입력';

const cache = new Map<string, string[]>();

// 과목별 영문 키워드 보조 매핑 (Pixabay 이미지 품질 향상)
const KO_TO_EN: Record<string, string> = {
  세포: 'cell biology',
  미토콘드리아: 'mitochondria',
  DNA: 'DNA genetics',
  유전: 'genetics dna',
  진화: 'evolution darwin',
  생태계: 'ecosystem nature',
  광합성: 'photosynthesis plant',
  함수: 'mathematics function graph',
  미분: 'calculus derivative',
  적분: 'integral calculus',
  벡터: 'vector mathematics',
  확률: 'probability statistics',
  통계: 'statistics data',
  역사: 'history ancient',
  조선: 'korea joseon history',
  고려: 'korea goryeo history',
  일제: 'colonial history',
  화학: 'chemistry laboratory',
  원소: 'element periodic table',
  산화: 'oxidation chemistry',
  물리: 'physics science',
  전기: 'electricity circuit',
  자기: 'magnetic field',
  파동: 'wave physics',
  광학: 'optics light',
  지구: 'earth geology',
  대기: 'atmosphere climate',
  경제: 'economy finance',
  사회: 'society community',
  헌법: 'constitution law',
};

function extractKeywords(title: string, script?: string): string {
  const cleanTitle = title
    .replace(/^(OX 퀴즈[：:﹕]\s*|예시 문제[：:﹕]\s*|개념 정리[：:﹕]\s*)/g, '')
    .replace(/[：:—\-?!？！,，.。]/g, ' ')
    .trim();

  const words = cleanTitle.split(/\s+/).filter((w) => w.length > 1).slice(0, 4);

  const enBoost = Object.entries(KO_TO_EN).find(([ko]) =>
    cleanTitle.includes(ko) || (script ?? '').includes(ko)
  );
  if (enBoost) return enBoost[1];

  if (script) {
    const scriptWords = script
      .replace(/[^가-힣a-zA-Z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !words.includes(w))
      .slice(0, 2);
    return [...words, ...scriptWords].slice(0, 4).join(' ');
  }
  return words.join(' ');
}

// 다중 이미지 반환: 카드 1개당 여러 이미지를 받아 청크별로 순환
export async function fetchBackgroundMedia(
  shortformId: string,
  title: string,
  type: 'concept' | 'example' | 'quiz',
  script?: string,
  imageKeywords?: string[]
): Promise<string[]> {
  if (cache.has(shortformId)) return cache.get(shortformId) ?? [];

  // AI가 제공한 키워드 배열 우선, 없으면 fallback
  const queries: string[] = (imageKeywords ?? [])
    .map((k) => k?.trim())
    .filter((k): k is string => !!k);
  if (queries.length === 0) {
    const fallback = extractKeywords(title, script);
    if (fallback) queries.push(fallback);
  }
  if (queries.length === 0) { cache.set(shortformId, []); return []; }

  // 첫 번째 쿼리를 대표 키워드로 (Giphy 검색용)
  const keywords = queries[0];

  const results: string[] = [];

  // 키워드 토큰 풀: Giphy/Pixabay 모두 동일 기준으로 점수화
  const allKw = queries
    .join(' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  // 매칭 임계: 최소 1개 키워드는 메타데이터에 등장해야 채택 (무관한 사진 차단)
  const MIN_MATCH = 1;

  // Giphy (GIF): quiz 타입에 우선 사용. title/slug에서 키워드 매칭 후 점수 ≥ 1만 채택.
  if (GIPHY_KEY && type === 'quiz') {
    try {
      const res = await fetch(
        `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(keywords)}&limit=15&rating=g&lang=ko`
      );
      const data = await res.json();
      if (Array.isArray(data.data) && data.data.length > 0) {
        type ScoredGif = { gif: any; score: number; idx: number };
        const scored: ScoredGif[] = data.data.map((gif: any, idx: number) => {
          const meta = `${gif.title ?? ''} ${gif.slug ?? ''}`.toLowerCase();
          const matches = allKw.filter((kw) => meta.includes(kw)).length;
          return { gif, score: matches, idx };
        });
        const passed = scored
          .filter((s) => s.score >= MIN_MATCH)
          .sort((a, b) => b.score - a.score || a.idx - b.idx);
        for (const s of passed.slice(0, 4)) {
          const url: string =
            s.gif.images?.downsized_large?.url ?? s.gif.images?.original?.url ?? '';
          if (url) results.push(url);
        }
      }
    } catch {}
  }

  // Pixabay (이미지): quiz가 아니거나 GIF 부족시. 멀티 쿼리 병렬 검색 후 통합 점수화.
  // 매칭되는 사진이 없으면 빈 결과 반환 → 카드는 단색 배경으로 표시 (무관한 사진을 보여주는 것보다 나음).
  if (PIXABAY_KEY && results.length < 3) {
    try {
      const responses = await Promise.all(
        queries.map((q) =>
          fetch(
            `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(q)}&image_type=photo&per_page=15&min_width=720&safesearch=true&order=popular`
          )
            .then((r) => r.json())
            .catch(() => ({ hits: [] }))
        )
      );

      type Scored = { hit: any; score: number; popRank: number; queryIdx: number };
      const scored: Scored[] = [];
      const seenIds = new Set<number>();
      responses.forEach((data, qi) => {
        if (!Array.isArray(data?.hits)) return;
        data.hits.forEach((hit: any, idx: number) => {
          if (seenIds.has(hit.id)) return;
          seenIds.add(hit.id);
          const tags = (hit.tags ?? '').toLowerCase();
          const matches = allKw.filter((kw) => tags.includes(kw)).length;
          scored.push({ hit, score: matches, popRank: idx, queryIdx: qi });
        });
      });

      // 매칭 점수 ↓, 동점 시 쿼리 순서(앞쪽 = 더 구체적) ↑, 그 다음 인기순.
      let filtered = scored
        .filter((s) => s.score >= MIN_MATCH)
        .sort((a, b) => b.score - a.score || a.queryIdx - b.queryIdx || a.popRank - b.popRank);

      // Fallback: 조건 만족하는 이미지 없으면 인기순으로 사용 (무관한 이미지라도 이미지 없는 것보다 나음)
      if (filtered.length === 0) {
        filtered = scored
          .sort((a, b) => a.queryIdx - b.queryIdx || a.popRank - b.popRank)
          .slice(0, 10);
      }

      for (const s of filtered.slice(0, 5)) {
        const url: string = s.hit.webformatURL ?? s.hit.largeImageURL ?? '';
        if (url && !results.includes(url)) results.push(url);
      }
    } catch {}
  }

  cache.set(shortformId, results);
  return results;
}

export function clearImageCache() { cache.clear(); }
