// 한글 자모 분해 기반 부분 검색 유틸
// 예) "삭"(ㅅㅏㄱ) → "사과"(ㅅㅏㄱㅘ) 매칭, "연과"(ㅇㅕㄴㄱㅘ) → "연관"(ㅇㅕㄴㄱㅘㄴ) 매칭

const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

// 음절 → 자모 시퀀스. 한글 외 문자는 그대로 유지
export function decomposeKorean(text: string): string {
  if (!text) return '';
  const normalized = text.normalize('NFC');
  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const offset = code - 0xAC00;
      out += CHO[Math.floor(offset / 588)];
      out += JUNG[Math.floor((offset % 588) / 28)];
      const jongIdx = offset % 28;
      if (jongIdx > 0) out += JONG[jongIdx];
    } else {
      out += normalized[i];
    }
  }
  return out;
}

// 검색어가 텍스트에 포함되는지: 공백 무시, 자모 시퀀스 prefix/substring 매칭
// "삭" → "사과" 발견, "연과" → "연관" 발견 같은 부분 입력 매칭 지원
export function matchesKoreanQuery(haystack: string, query: string): boolean {
  if (!query) return true;
  if (!haystack) return false;
  const h = haystack.toLowerCase().replace(/\s+/g, '');
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (h.includes(q)) return true;
  return decomposeKorean(h).includes(decomposeKorean(q));
}

// 큰 데이터셋에서 키 입력마다 분해를 반복하지 않도록 미리 만들어두는 검색용 인덱스.
// 한 번 만들면 매 키 입력 시 단순 substring 비교만 하면 됨.
export interface SearchIndex {
  lower: string;       // 소문자 + 공백 제거
  decomposed: string;  // 위 결과를 자모 분해
}

export function buildSearchIndex(text: string): SearchIndex {
  if (!text) return { lower: '', decomposed: '' };
  const lower = text.toLowerCase().replace(/\s+/g, '');
  return { lower, decomposed: decomposeKorean(lower) };
}

// 사전 분해된 query에 대해 사전 분해된 haystack을 매치, 매 키 입력 시 사용
export function matchesPrebuilt(index: SearchIndex, queryLower: string, queryDecomposed: string): boolean {
  if (!queryLower) return true;
  if (!index.lower) return false;
  if (index.lower.includes(queryLower)) return true;
  return index.decomposed.includes(queryDecomposed);
}
