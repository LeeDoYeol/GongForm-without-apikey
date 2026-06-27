// API 보안 모델:
// - 일반 사용자(키 미등록) → Cloudflare Worker 프록시 경유 (Firebase ID 토큰 + 분당 한도). 공용 키는 Worker만 알고 있음.
// - 자기 OpenRouter 키를 등록한 사용자 → 클라이언트가 OpenRouter로 직접 호출 (빠른 모드, 자기 quota 사용).
//
// 공용 프록시 path 한정: 마이 탭에서 provider 토글로 OpenRouter ↔ Cerebras 비교 가능.
// 같은 모델(`gpt-oss-120b`)이지만 호스팅 인프라가 달라 출력 throughput이 5~6배 차이 (Cerebras가 빠름).
// 사용자 본인 키 path는 OpenRouter direct만 지원.
const MODEL_OPENROUTER = 'openai/gpt-oss-120b:free';
const MODEL_CEREBRAS = 'gpt-oss-120b';
const MODEL_OPENAI = 'gpt-5-mini'; // 균형 (속도/비용/품질). 더 싸게 쓰려면 'gpt-5-nano', 품질 우선이면 'gpt-5'.
const OPENROUTER_DIRECT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CEREBRAS_DIRECT_URL = 'https://api.cerebras.ai/v1/chat/completions';
const OPENAI_DIRECT_URL = 'https://api.openai.com/v1/chat/completions';
const IS_WEB = typeof document !== 'undefined';

// Worker 프록시 URL (배포된 도메인)
const PROXY_URL = '여기 Worker 주소 입력';

// ⚠️ 임시: 키가 클라이언트 번들에 노출. 베타·내부 테스트용.
// 정식 배포 전 사용자별 키 등록 UI 또는 Worker 프록시로 이전 필요.
const CEREBRAS_DIRECT_KEY = '여기 API 키 입력';
const OPENAI_DIRECT_KEY = '여기 API 키 입력';

// 공용 프록시 path에서 사용할 model 이름: 토글에 따라 자동 선택.
// (cerebras/openai 토글은 클라이언트 direct path로 가므로 사실상 'openrouter'만 여기 도달)
function resolveModelForProxy(_provider: 'openrouter' | 'cerebras' | 'openai'): string {
  return MODEL_OPENROUTER;
}

/**
 * 퀴즈 모드: 한 quiz 카드 안에서 어떤 인터랙션을 쓸지.
 * - 'ox' (기본·기존): 진술 + "정답: O|X" + "해설:" 패턴이 script에 내장됨
 * - 'mcq': 객관식. choices[0..n] 중 answerIndex가 정답
 * - 'fillblank': 단답형 자유 입력. blankAnswer가 정답
 */
export type QuizMode = 'ox' | 'mcq' | 'fillblank';

/**
 * 생성 밀도: 자료에서 얼마나 많은 개념을 뽑을지 + Phase 2 derivative를 얼마나 만들지 제어.
 * - 'summary': 자료의 핵심 개념만. 청크당 5~10개. 짧은 시간에 핵심 정리용.
 * - 'standard' (default): 균형 잡힌 추출. 청크당 10~15개.
 * - 'detailed': 자료의 거의 모든 학습 포인트. 청크당 20~30개. 시험 대비용.
 *
 * 어떤 밀도여도 **총합 최대 30개 카드**로 제한 (HARD_CAP, 자료 분량 크면 청크 비례로 증가).
 * importance ≥ 5인 개념만 example + quiz 파생. < 5는 concept 카드만.
 */
export type GenerationDensity = 'summary' | 'standard' | 'detailed';

/** 1개 생성 작업의 최종 카드 수 상한: 개념 10개 × 3카드(concept+example+quiz) = 30. */
export const HARD_CAP = 30;
/**
 * 자료 분량(청크 수) 기반 동적 cap.
 * 청크 4개당 30카드 (= PDF 20p 또는 텍스트 12,000자당 30카드). 올림 처리.
 * 예: 1청크=30, 4청크=30, 5청크=60, 20청크(=100p)=150, 60청크(=300p)=450.
 */
function computeHardCap(chunkCount: number): number {
  return Math.ceil(Math.max(1, chunkCount) / 4) * 30;
}
/** Phase 2 derivative(예시+퀴즈)를 만들 importance 컷오프 */
const FOLLOWUP_IMPORTANCE_THRESHOLD = 5;
/** importance ≥ 컷오프 개념 1개당 생성되는 카드 수 (concept + example + quiz) */
const CARDS_PER_FULL_CONCEPT = 3;

export interface ShortFormScript {
  type: 'concept' | 'example' | 'quiz';
  title: string;
  script: string;
  imageKeywords?: string[];
  /** 중요도 1~10. AI가 시험 출제 가능성·핵심도 기준으로 채점. 누락 시 기본 5 */
  importance?: number;
  /** Phase 2 (예시·OX 생성) 출력에만 임시로 포함: 어떤 concept에서 파생됐는지 매칭용. interleave 후 parentConceptTitle로 승격되고 제거 */
  forConcept?: string;
  /** 파생 카드(example/quiz)의 부모 concept title: 플레이어의 "개념 보러가기" 정확 매칭용. 저장 시점에 영구 보존. */
  parentConceptTitle?: string;

  // quiz 타입 전용 (type==='quiz'일 때만 의미 있음)
  /** 누락 시 'ox'로 간주 (기존 데이터 호환) */
  quizMode?: QuizMode;
  /** MCQ: 보기 (보통 3~4개) */
  choices?: string[];
  /** MCQ: 정답 인덱스 (0-based) */
  answerIndex?: number;
  /** Fillblank: 정답 문자열 (대소문자·공백 정규화 후 비교) */
  blankAnswer?: string;
}

export type FileInput =
  | { kind: 'binary'; base64: string; mimeType: string }
  | {
      kind: 'text';
      content: string;
      /** PDF 페이지 수·PPT 슬라이드 수 등 원본 단위 수. 있으면 cap을 글자 수 대신 단위 수 기준으로 산정(네이티브 PDF와 동일 척도). */
      unitCount?: number;
    };

// Phase 1: 자료에서 학습 개념만 추출하고 채점. example/quiz는 Phase 2에서 생성
const PROMPT_TEMPLATE = (
  unitName: string,
  pageRange?: { start: number; end: number },
  density: GenerationDensity = 'standard',
) => {
  const pageText = pageRange ? `(분석 대상 페이지: ${pageRange.start} ~ ${pageRange.end}페이지)` : '';
  const unitText = unitName ? `"${unitName}" 단원 ` : '';

  // 밀도별 분량/포함 범위 가이드. count는 **상한**이지 의무가 아님.
  // 최종 출력은 importance 상위 10개 개념(×3카드 = 30카드)으로 컷되므로,
  // 청크당 카운트도 거기에 맞춰 보수적으로. 자료가 빈약하면 더 적게 뽑는 게 옳다 (양보다 질).
  const densityGuide =
    density === 'summary'
      ? {
          headline: '핵심 개념만 추출 (요약 모드)',
          countGuide: '청크당 **최대 4개**까지. 정말 핵심만 (자료 전체에서 6개 안팎이 적정)',
          include: '시험·평가·발표에 반드시 나올 정도로 중요한 개념만',
          skip: '각주·보조 정보·한 줄 언급·부수 사례 등 자투리는 **제외**',
          importanceFocus: '핵심만 추출하되 1~3 별점 카드도 자료당 1~2개는 자투리로 포함 (난이도 위계 시각화용)',
        }
      : density === 'detailed'
      ? {
          headline: '자료의 학습 포인트 빠짐없이 추출 (상세 모드)',
          countGuide: '청크당 **최대 12개**까지. 자료 밀도에 비례 — 페이지에 학습거리가 적으면 적게',
          include: '용어·공식·과정 단계·비교 쌍·각주·보조 정보·고유명사 등 폭넓게',
          skip: '같은 개념을 다른 표현으로 중복 등장하는 경우만',
          importanceFocus: '1~10 전 범위 골고루 분포. 1~3 별 카드를 전체의 15~25% 비중으로 적극 부여 (각주·예외·한 줄 언급)',
        }
      : {
          headline: '균형 잡힌 추출 (표준 모드)',
          countGuide: '청크당 **최대 7개**까지. 자료에 의미 있는 개념이 3개뿐이면 3개만 뽑기 (자료 전체에서 6~10개가 적정)',
          include: '핵심 정의·공식·과정·중요한 비교 대상·자주 출제되는 응용 사례',
          skip: '한 줄로 지나가는 자투리 정보, 부수적 각주는 **제외**',
          importanceFocus: '대부분 5~10이되, 1~3 별 카드를 전체의 10~15% 비중으로 부여 (자투리·곁가지 정보)',
        };

  return `당신은 한국 입시 1타 강사 출신의 학습 콘텐츠 크리에이터입니다.
첨부된 학습 자료${unitText ? `의 ${unitText}` : ''}${pageText}에서 학생이 알아야 할 핵심 학습 개념을 추출하세요.

⚠️ 이 단계에서는 **concept 카드만 생성**합니다. 예시 문제·OX 퀴즈는 다음 단계에서 만듭니다. 절대 example·quiz를 출력하지 마세요.

⚠️ **분량 가이드는 "상한"이지 의무가 아님**. 자료에 실제로 학습 가치가 있는 만큼만 뽑으세요. 억지로 채우려고 부수 정보·중복·뻔한 내용을 끌어다 쓰지 마세요. **양보다 질**.

## 🎯 추출 모드: ${densityGuide.headline}

- 분량: ${densityGuide.countGuide}
- 포함: ${densityGuide.include}
- 스킵: ${densityGuide.skip}
- 중요도: ${densityGuide.importanceFocus}
- 자료에 명시되지 않은 내용은 추측 금지.
- 같은 개념을 다른 단어로 두 번 추출하는 중복 금지.

## 🔍 포함 대상 — 모드에 따라 다름

자료에 등장하는 학습 가치가 있는 항목 중, **위 모드 가이드에 맞는 것**만 concept 카드화하세요.

**일반 포함**:
- 용어/정의 · 공식·법칙·원리
- 헷갈리기 쉬운 오개념·함정 대상
- 외워야 할 사실 (수치·연도·이름)
- 단계가 있는 과정의 각 단계
- 비교 대상 개념 쌍 (A vs B는 두 개념으로)
${density === 'summary'
  ? '\n**요약 모드에서는 위 5종 중 정말 핵심만 선별**. 자투리/각주/부수 사례는 모두 제외.'
  : density === 'detailed'
    ? '\n**상세 모드에서는 추가로 포함**:\n- 한 줄로 지나가는 보조 정보·각주·예외 사항\n- 자료에 명시된 고유명사·도구·인물 (관련 학습 포인트면)\n- 응용·활용 사례의 세부 항목'
    : '\n**표준 모드에서는 추가로 포함**:\n- 응용·활용 사례의 핵심 (자투리 각주는 제외)'}

## 📝 concept 작성 기준 (200~350자)

- 첫 문장: 핵심 한 줄 정의
- 본문: 구성요소·왜·어떻게 1~2가지 추가
- 마지막: "그래서 ~할 때 떠올리면 된다" 같은 활용 팁
- **문체 통일**: 단단한 평서체(~다, ~이다, ~한다, ~된다). 모든 문장의 종결 어미는 평서체.
  - ✅ "관성은 운동 상태를 유지하려는 성질이다."
  - ❌ 친근체(~야, ~해, ~지) — "관성은 ~ 성질이야" 금지
  - ❌ 공손체(~합니다, ~입니다) — "관성은 ~ 성질입니다" 금지
  - ❌ 한 카드 안에 ~다와 ~야를 섞어 쓰는 것 금지

## 🌡️ 중요도(importance) — 각 정수마다 세세하게 차등

각 개념에 1~10 정수로 중요도를 매기세요. **자료 내 상대적 비중** 기준:

- **10** — 단원의 정의적 핵심. "이거 모르면 단원 통째로 모름". 자료당 0~2개.
- **9** — 단원 핵심. 정의·공식·대표 사례가 시험 단골. 자료당 2~5개.
- **8** — 매우 중요한 응용·심화 주제. 자료당 5~10%.
- **7** — 기본기 중 중요한 것. 자료당 10~15%.
- **6** — 평균적인 기본기. 자료당 15~20%.
- **5** — 보조 디테일이지만 알면 좋음. 자료당 15~20%.
- **4** — 부수 정보. 자료당 10~15%.
- **3** — 곁가지·예외 사항. 자료당 5~10%.
- **2** — 한 줄 언급 보조 정보. 자료당 2~5%.
- **1** — 거의 무시해도 되는 자투리. 자료당 0~5%.

**같은 점수를 무작정 반복하지 마세요**. 비슷해 보여도 우열을 가려 7과 8을, 4와 5를 구분하세요.

이 중요도는 다음 단계에서 만들 예시·OX 카드에 그대로 상속됩니다. 지금 정확하게 채점하세요.

## 🚫 절대 금지

- example, quiz 타입 출력 (이 단계는 concept 전용)
- 자료에 없는 내용 추측
- 같은 개념의 다른 표현 중복
- 한 줄짜리 부실 script

## 출력 형식 (JSON만, 다른 텍스트 절대 금지)

⚠️ JSON 키·문자열 따옴표는 반드시 ASCII 큰따옴표("). 스마트 따옴표 금지.

{
  "shortforms": [
    { "type": "concept", "title": "핵심 개념 제목", "script": "200~350자 대화체 설명", "imageKeywords": ["kw1","kw2","kw3"], "importance": 9 }
  ]
}

## imageKeywords 규칙 (Pixabay 사진 검색) — 매우 엄격

이미지 검색은 영문 tag 매칭이므로, **사진으로 찍을 수 있는 실물**만 사용. 추상어는 무관한 사진을 부른다.

각 카드마다 정확히 3개. 모두 영문 2~3단어. **앞쪽일수록 구체적**:
- [0] **카드 핵심 주제의 실물 한 가지** — 사람이 사진 찍을 수 있는 사물/생물/장소. 분야 한정어 1개 동반 권장.
- [1] **그 실물이 등장하는 장면/맥락** — 동사형 보다는 명사구.
- [2] **분야 도메인 키워드** — 학문 분야명 + 보조 키워드. (예: \`biology lab\`, \`chemistry experiment\`)

**예시 (좋음)**:
- 관성: \`["billiard ball motion", "moving train passenger", "physics mechanics"]\`
- 미토콘드리아: \`["mitochondria microscope", "animal cell organelle", "cell biology"]\`
- 조선 후기 실학: \`["joseon hanok village", "old korean book", "korea history museum"]\`

**금지어 (절대 사용 금지 — tag 매칭이 거의 안 됨)**:
model, graph, function, theory, principle, idea, formula, equation, concept,
study, education, learning, lesson, knowledge, school, student, classroom,
abstract, diagram, illustration, chart, infographic

**카드 주제와 직접 관련된 실물만**. 막연히 "공부 분위기" 사진을 부르는 키워드 금지.

## 마지막 점검

- 자료에 등장한 모든 학습 포인트가 개념화됐는가?
- example·quiz를 실수로 섞지 않았는가? (concept만!)
- 중요도가 1~10에 골고루 분포하는가?`;
};

// Phase 2: Phase 1에서 추출된 개념들을 입력으로 example + OX quiz를 생성
const FOLLOWUP_PROMPT_TEMPLATE = (
  concepts: { title: string; script: string; importance: number }[],
) => `당신은 한국 입시 1타 강사 출신의 출제 전문가입니다.
아래 학습 개념들 각각에 대해 **example 카드 1개 + quiz 카드 1~2개**를 생성하세요.

## 입력 개념 (각각 importance가 매겨져 있음)

${concepts.map((c, i) => `■ [${i + 1}] title: "${c.title}" (importance: ${c.importance})
${c.script}`).join('\n\n')}

## 작성 기준

**문체 통일 (모든 카드 공통)**
- 단단한 평서체(~다, ~이다, ~한다, ~된다)로 통일.
  - ✅ "정답은 X다."  ✅ "옳지 않다."  ✅ "~이 발생한다."
  - ❌ "정답은 X야"·"X입니다"·"옳지 않아"·"발생해" — 친근체·공손체 금지
- 한 카드 안에서 ~다 / ~야 / ~합니다 섞어 쓰지 말 것.

**example (250~400자) — 반드시 "물어보는" 형식. 개념 설명만 늘어놓으면 안 됨**
- 구조: **질문 문장(물음표 필수)** → 잠시 생각 유도 → "정답은 ~다" → 풀이 단계 → 핵심 교훈
- script **첫 문단은 반드시 의문문**으로 시작. "~할까?", "~인가?", "~는 무엇인가?", "다음 중 ~?", "어떻게 ~?" 형식
- 진술문/설명문으로 시작 금지 — "관성은 ~이다. 이는 ~다" 같은 진술 흐름은 quiz가 아니라 concept이 됨
- ✅ "달리는 차에서 컵이 미끄러지는 이유는 무엇일까? ... 정답은 관성이다. 관성이란 ~"
- ❌ "관성은 운동 상태를 유지하려는 성질이다. 예를 들어 ~" (질문 없이 설명만 — 금지)
- 한 개념당 1개

**quiz — 3가지 모드 중 개념에 가장 맞는 모드로 출제**

각 quiz 카드는 \`quizMode\` 필드로 다음 셋 중 하나를 지정:

### 모드 1) \`quizMode: "ox"\` — 진위 판단 (참/거짓 함정)
- 가장 적합: "항상/절대" 일반화, 단위 함정, 흔한 오개념 검증
- script 형식 (150~250자, **엄격 준수**):
\`\`\`
<중립적 진술 한 문장>

정답: O (또는 X)
해설: <30~50자>
\`\`\`
- "정답:" 마커 **이전**에 정답을 시사·암시·예고 금지 (스포 방지 절대 규칙)
- choices/answerIndex/blankAnswer 필드 **출력 금지**

### 모드 2) \`quizMode: "mcq"\` — 4지선다
- 가장 적합: 여러 선지 중 하나 고르기 (개념 식별, 연도, 인물, 결과 비교)
- 필수 필드: \`choices\` (정확히 4개 문자열), \`answerIndex\` (0~3 정수)
- script: 질문 본문만 1~2줄 (150자 이하). 정답·해설은 script에 넣지 말고 **별도 필드**로:
  - 정답은 \`answerIndex\`로 (script엔 적지 말 것)
- title 예: "객관식: 1차 세계대전 도화선"
- choices는 비슷한 유형(연도 vs 연도, 사건 vs 사건)으로 매력적인 오답 포함

### 모드 3) \`quizMode: "fillblank"\` — 단답형 자유 입력
- 가장 적합: 핵심 키워드·연도·인물·용어 (간단·명확한 정답)
- 필수 필드: \`blankAnswer\` (정답 문자열, 보통 단어/숫자 1~3개)
- script: 질문 본문만 (예: "사라예보 사건이 일어난 연도는?")
- 정답은 짧고 명확해야 함 (대소문자·공백 정규화로 매칭). 띄어쓰기·조사 변형 가능한 답변은 피할 것
- 동의어가 있다면 가장 일반적인 표기 1개만

### 모드 분배 (개념 1개당 quiz 1~2개)
- 개념 성격에 맞게 mode 선택 (전부 OX로 몰지 말 것)
- 가능한 한 한 개념에 서로 다른 mode 조합 (예: OX 1개 + MCQ 1개)
- "이거 외워야 함" 류 = fillblank, "헷갈리기 쉬움" 류 = OX·MCQ

### title도 정답 힌트 금지 (모든 모드 공통)
- ❌ "잘못된 ~ / 옳지 않은 ~" → 정답 노출
- ✅ "OX: 주제명" / "객관식: 주제명" / "빈칸: 주제명" — 주제만

## ⚠️ 절대 규칙

- 각 출력 카드에 **\`forConcept\` 필드 필수**. 부모 개념의 title을 **정확히 같은 글자로** 적을 것.
- **importance는 부모 개념의 importance를 그대로** 적을 것. 변경 금지.
- 입력 개념 범위 밖 내용 생성 금지.
- 같은 개념에 같은 각도 카드 두 개 금지.
- concept 타입 출력 금지 (이 단계는 example·quiz 전용).
- quiz 카드는 반드시 \`quizMode\` 필드 포함.

## 출력 형식 (JSON만, 다른 텍스트 절대 금지)

ASCII 큰따옴표(")만 사용. 스마트 따옴표 금지.

{
  "shortforms": [
    { "forConcept": "관성의 법칙", "type": "example", "title": "예시: 정지한 버스가 출발할 때", "script": "정지해 있던 버스가 갑자기 출발하면 승객의 몸이 뒤로 쏠리는 이유는 무엇일까? 잠시 생각해보자. ...\\n\\n정답은 관성 때문이다. 승객의 몸은 정지 상태를 유지하려 하기 때문에 버스가 앞으로 움직일 때 상대적으로 뒤로 쏠리는 것처럼 보인다. ...", "imageKeywords": ["kw1","kw2","kw3"], "importance": 9 },
    { "forConcept": "관성의 법칙", "type": "quiz", "quizMode": "ox", "title": "OX: 관성의 법칙", "script": "관성은 ...\\n\\n정답: X\\n해설: ...", "imageKeywords": ["kw1","kw2","kw3"], "importance": 9 },
    { "forConcept": "관성의 법칙", "type": "quiz", "quizMode": "mcq", "title": "객관식: 관성 예시", "script": "다음 중 관성의 예시가 아닌 것은?", "choices": ["달리는 차에서 컵이 미끄러짐", "지구가 태양을 도는 것", "급정거 시 몸이 앞으로 쏠림", "정지한 공이 가만히 있음"], "answerIndex": 1, "imageKeywords": ["kw1","kw2","kw3"], "importance": 9 },
    { "forConcept": "관성의 법칙", "type": "quiz", "quizMode": "fillblank", "title": "빈칸: 관성 법칙 발견자", "script": "관성의 법칙을 정식화한 과학자는?", "blankAnswer": "뉴턴", "imageKeywords": ["kw1","kw2","kw3"], "importance": 9 }
  ]
}

## imageKeywords 규칙 — 매우 엄격

이미지 검색은 영문 tag 매칭. **사진으로 찍을 수 있는 실물**만 사용. 추상어는 무관한 사진을 부른다.

각 카드마다 정확히 3개. 모두 영문 2~3단어. **앞쪽일수록 구체적**:
- [0] **카드 핵심 주제의 실물 한 가지** + 분야 한정어 1개 (예: \`billiard ball motion\`, \`mitochondria microscope\`)
- [1] **그 실물이 등장하는 장면/맥락** — 명사구.
- [2] **분야 도메인 키워드** — 학문 분야명 + 보조 키워드 (예: \`physics mechanics\`, \`cell biology\`)

**금지어**: model, graph, function, theory, principle, idea, formula, equation, concept,
study, education, learning, lesson, knowledge, school, student, classroom,
abstract, diagram, illustration, chart, infographic.

카드 주제와 직접 관련된 실물만. "공부 분위기" 일반 사진 금지.`;

async function callOpenRouter(messages: any[], jobId?: string): Promise<string> {
  // 우선순위 기반 글로벌 slot 획득 → 다른 job과 공정 분배.
  const { acquireApiSlot } = await import('./apiThrottle');
  const release = await acquireApiSlot(jobId);
  try {
    return await doCallOpenRouter(messages);
  } finally {
    release();
  }
}

// HTTP status / 응답 패턴을 사용자 친화 한국어 메시지로 변환.
// 디버그용 원본 메시지는 메인 메시지 뒤에 작게 붙임.
function friendlyApiError(status: number, raw: string): string {
  // 본문에서 OpenRouter/Gemini 의미 있는 부분만 추출
  let detail = raw;
  try {
    const j = JSON.parse(raw);
    detail = j?.error?.message ?? j?.message ?? raw;
  } catch {}
  const isQuota = /quota|rate.?limit|too many|insufficient/i.test(detail);
  const isAuth = /unauthor|invalid.?key|forbidden|api.?key/i.test(detail);
  const isTimeout = /timeout|timed.?out|deadline/i.test(detail);
  const isModelNotFound = /not.?found|no.?model|invalid.?model/i.test(detail) && status === 404;
  const isOverload = /overload|busy|503/i.test(detail);

  if (status === 429 || isQuota) {
    return '너무 많은 요청이 들어왔어요. 잠시(1~2분) 후 다시 시도해주세요.';
  }
  if (status === 401 || status === 403 || isAuth) {
    return 'AI 서비스 인증에 문제가 생겼어요. 잠시 후 다시 시도하거나 관리자에게 문의해주세요.';
  }
  if (isModelNotFound) {
    return 'AI 모델을 찾을 수 없어요. 앱이 최신 상태인지 확인해주세요.';
  }
  if (status === 504 || isTimeout) {
    return '응답이 너무 오래 걸려요. 자료가 너무 크거나 복잡할 수 있어요 — 더 작은 단위로 나눠 시도해주세요.';
  }
  if (status === 502 || status === 503 || isOverload) {
    return 'AI 서버가 일시적으로 혼잡해요. 잠시 후 다시 시도해주세요.';
  }
  if (status >= 500) {
    return 'AI 서버에 일시적인 문제가 있어요. 잠시 후 다시 시도해주세요.';
  }
  if (status === 400) {
    return '요청 형식이 올바르지 않아요. 자료 내용을 확인해주세요.';
  }
  // fallback: 상태 코드 + 원본 메시지 앞부분
  return `요청 처리에 실패했어요. (${status}) ${detail.slice(0, 120)}`;
}

async function doCallOpenRouter(messages: any[]): Promise<string> {
  // 라우팅 규칙:
  // - provider='openai' → OpenAI 직접 (번들의 키 사용)
  // - provider='cerebras' → Cerebras 직접 (Worker는 CF WAF에 막힘)
  // - provider='openrouter' + 사용자 키 등록 → OpenRouter direct (빠른 모드)
  // - provider='openrouter' + 키 없음 → Worker 프록시
  const { getUserApiKeySync, getProviderSync, ensureSettingsLoaded } = await import('./aiSettings');
  await ensureSettingsLoaded();
  const userKey = getUserApiKeySync();
  const provider = getProviderSync();
  const useOpenAIDirect = provider === 'openai';
  const useCerebrasDirect = provider === 'cerebras';
  const useOpenRouterDirect = provider === 'openrouter' && !!userKey;

  let url: string;
  let model: string;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (useOpenAIDirect) {
    url = OPENAI_DIRECT_URL;
    model = MODEL_OPENAI;
    headers['Authorization'] = `Bearer ${OPENAI_DIRECT_KEY}`;
  } else if (useCerebrasDirect) {
    // Cerebras 직접 호출 (Worker 우회). CF→CF WAF 차단 회피.
    url = CEREBRAS_DIRECT_URL;
    model = MODEL_CEREBRAS;
    headers['Authorization'] = `Bearer ${CEREBRAS_DIRECT_KEY}`;
  } else if (useOpenRouterDirect) {
    // 사용자 자기 키 → OpenRouter 직접
    url = OPENROUTER_DIRECT_URL;
    model = MODEL_OPENROUTER;
    headers['Authorization'] = `Bearer ${userKey!}`;
    // OpenRouter 직접 호출에만 추가 (프록시 경유 시엔 Worker가 자기가 붙여서 보냄: CORS preflight 차단 회피)
    headers['HTTP-Referer'] = 'https://gongform.app';
    headers['X-Title'] = 'GongForm';
  } else {
    // 공용 호출 → Worker 프록시 + Firebase ID 토큰. provider 토글에 따라 X-Upstream 헤더 + model 이름 선택.
    if (!PROXY_URL || PROXY_URL.includes('YOUR-SUBDOMAIN')) {
      throw new Error('서버 설정이 완료되지 않았어요. 설정에서 자신의 OpenRouter API 키를 등록해주세요.');
    }
    const { auth } = await import('./firebase');
    const user = auth.currentUser;
    if (!user) throw new Error('로그인이 필요해요.');
    let idToken: string;
    try {
      idToken = await user.getIdToken();
    } catch {
      throw new Error('인증 토큰을 가져올 수 없어요. 다시 로그인해주세요.');
    }
    url = PROXY_URL;
    model = resolveModelForProxy(provider);
    headers['Authorization'] = `Bearer ${idToken}`;
    headers['X-Upstream'] = provider;
  }

  const routeLabel = useOpenAIDirect
    ? 'direct/openai'
    : useCerebrasDirect
    ? 'direct/cerebras'
    : useOpenRouterDirect
    ? 'direct/openrouter'
    : `proxy/${provider}`;
  console.log('[OpenRouter] 요청 시작 -', model, 'route:', routeLabel);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages }),
    });
  } catch (e: any) {
    console.error('[OpenRouter] fetch 실패:', e);
    // 네트워크 단절·DNS 실패·CORS 등
    const m = e?.message ?? String(e);
    if (/abort|cancel/i.test(m)) {
      throw new Error('요청이 취소됐어요.');
    }
    throw new Error('서버로 전달이 안 됐어요. 인터넷 연결을 확인하고 다시 시도해주세요.');
  }

  console.log('[OpenRouter] 응답 status:', res.status);
  const rawText = await res.text();
  if (!res.ok) {
    // 디버그용: 업스트림 에러 본문을 콘솔에 풀로 찍어서 원인 파악.
    console.error(`[OpenRouter] ${res.status} 에러 본문:`, rawText.slice(0, 800));
    throw new Error(friendlyApiError(res.status, rawText));
  }

  // 응답 본문이 비어있거나 비-JSON
  if (!rawText || !rawText.trim()) {
    throw new Error('AI 서버에서 응답을 받지 못했어요. 잠시 후 다시 시도해주세요.');
  }
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error('AI 응답 형식이 이상해요. 잠시 후 다시 시도해주세요.');
  }

  if (data?.error) {
    const code = data.error.code ?? res.status;
    const detail = data.error.message ?? JSON.stringify(data.error);
    throw new Error(friendlyApiError(Number(code) || 500, detail));
  }

  const text: string = data?.choices?.[0]?.message?.content ?? '';
  if (!text || !text.trim()) {
    // 모델이 빈 응답을 줬을 때: 파일이 비었거나 분석 거부됐을 가능성
    throw new Error('자료에서 학습할 내용을 찾지 못했어요. 파일이 비어있거나 인식이 어려울 수 있어요.');
  }
  return text;
}

// LLM 응답에서 JSON 본문을 추출. 우선순위:
// (1) ```json ... ``` 코드블록 (가장 자주 나오는 형태): 첫 번째 fenced 블록
// (2) 일반 ``` ... ``` 코드블록
// (3) raw 텍스트에서 첫 '{'~마지막 '}' 슬라이스: 중첩 객체가 있어도 균형 잡힘
function extractJsonBody(text: string): string | null {
  const fencedJson = text.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson) return fencedJson[1].trim();
  const fenced = text.match(/```\s*([\s\S]*?)```/);
  if (fenced && fenced[1].trim().startsWith('{')) return fenced[1].trim();
  // greedy: 첫 '{' 부터 마지막 '}' 까지 (중간에 설명문이 들어와도 외부 객체 균형은 유지됨)
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return null;
}

function parseShortForms(text: string): ShortFormScript[] {
  const raw = extractJsonBody(text);
  if (!raw) throw new Error(`JSON 파싱 실패. 응답: ${text.slice(0, 200)}`);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 흔한 LLM 실수 자동 복구: 스마트 따옴표, 잘못된 줄바꿈 이스케이프, trailing comma
    const sanitized = raw
      .replace(/[“”„‟]/g, '"')
      .replace(/[‘’‚‛]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');
    try {
      parsed = JSON.parse(sanitized);
    } catch (e: any) {
      throw new Error(`JSON 파싱 실패: ${e?.message ?? e}\n응답 일부: ${raw.slice(0, 300)}`);
    }
  }
  if (!Array.isArray(parsed.shortforms)) throw new Error('shortforms 배열이 없습니다.');
  return (parsed.shortforms as ShortFormScript[]).map((s) => normalizeShortForm(s));
}

// quizMode + 관련 필드 정규화. 모드 부적합 시 OX(기본)로 폴백.
function normalizeShortForm(s: ShortFormScript): ShortFormScript {
  const out: ShortFormScript = {
    ...s,
    importance: clampImportance(s.importance),
  };
  if (out.type !== 'quiz') {
    // quiz 모드 필드는 quiz 카드에만 의미 있음. 다른 타입에서는 제거
    delete out.quizMode;
    delete out.choices;
    delete out.answerIndex;
    delete out.blankAnswer;
    return out;
  }
  const mode = out.quizMode;
  if (mode === 'mcq') {
    const choices = Array.isArray(out.choices) ? out.choices.filter((c) => typeof c === 'string' && c.trim()) : [];
    const idx = typeof out.answerIndex === 'number' ? Math.round(out.answerIndex) : -1;
    if (choices.length < 2 || idx < 0 || idx >= choices.length) {
      // 데이터 불완전 → OX 폴백
      out.quizMode = 'ox';
      delete out.choices; delete out.answerIndex; delete out.blankAnswer;
    } else {
      out.choices = choices;
      out.answerIndex = idx;
      delete out.blankAnswer;
    }
  } else if (mode === 'fillblank') {
    const ans = typeof out.blankAnswer === 'string' ? out.blankAnswer.trim() : '';
    if (!ans) {
      out.quizMode = 'ox';
      delete out.choices; delete out.answerIndex; delete out.blankAnswer;
    } else {
      out.blankAnswer = ans;
      delete out.choices; delete out.answerIndex;
    }
  } else {
    // 기본 OX (mode 누락 포함)
    out.quizMode = 'ox';
    delete out.choices; delete out.answerIndex; delete out.blankAnswer;
  }
  return out;
}

function clampImportance(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.round(n)));
}

// PDF 단일 페이지를 JPG base64로 변환 (실패 시 null)
async function convertSinglePdfPage(
  pdfPath: string,
  page0Based: number,
): Promise<string | null> {
  const FileSystem = require('expo-file-system/legacy');
  const { manipulateAsync, SaveFormat } = require('expo-image-manipulator');
  const PdfThumbnail = require('react-native-pdf-thumbnail');
  try {
    const { uri } = await PdfThumbnail.default.generate(pdfPath, page0Based);
    const compressed = await manipulateAsync(
      uri,
      [{ resize: { width: 900 } }],
      { compress: 0.55, format: SaveFormat.JPEG }
    );
    return await FileSystem.readAsStringAsync(compressed.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch {
    return null;
  }
}

// 간단한 세마포어: 동시 실행 수 제한
class Semaphore {
  private permits: number;
  private waiters: (() => void)[] = [];
  constructor(n: number) { this.permits = n; }
  async acquire(): Promise<void> {
    if (this.permits > 0) { this.permits--; return; }
    await new Promise<void>((res) => this.waiters.push(res));
    this.permits--;
  }
  release(): void {
    this.permits++;
    const w = this.waiters.shift();
    if (w) w();
  }
}

// 청크 분할 설정: 한 번에 보낼 분량 (너무 크면 컨텍스트/응답 잘림, 너무 작으면 호출 횟수 증가)
const PDF_PAGES_PER_BATCH = 5;
const TEXT_CHARS_PER_BATCH = 6000;
// 동시 실행 청크 수: 너무 크면 OpenRouter rate limit, 너무 작으면 느림
const CONCURRENCY = 4;

// 제한된 동시성으로 작업 실행: 결과를 입력 순서로 반환
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettle?: (index: number) => void,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e: any) {
        console.warn(`[runWithConcurrency] item ${i + 1} 실패:`, e?.message);
        results[i] = undefined;
      } finally {
        onSettle?.(i);
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export interface GenerateProgress {
  /** 0-indexed 현재 청크 */
  current: number;
  /** 총 청크 수 */
  total: number;
  /** 사용자에게 보여줄 메시지 */
  message?: string;
  /** 누적 생성된 카드 수 */
  generated: number;
}

// 자연스러운 경계(빈 줄 > 줄바꿈 > 마침표 > 그냥 자르기)로 텍스트 분할
function splitTextIntoChunks(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const remaining = text.length - i;
    if (remaining <= maxLen) {
      chunks.push(text.slice(i));
      break;
    }
    const end = i + maxLen;
    const candidates = [
      text.lastIndexOf('\n\n', end),
      text.lastIndexOf('\n', end),
      text.lastIndexOf('. ', end),
      text.lastIndexOf('.', end),
    ];
    const cutAt = Math.max(...candidates.map((p) => (p > i + maxLen / 2 ? p : -1)));
    const stop = cutAt > 0 ? cutAt + 1 : end;
    chunks.push(text.slice(i, stop));
    i = stop;
  }
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}

// API 호출 또는 JSON 파싱이 실패한 청크를 재시도: 단발성 quota·네트워크 흔들림·LLM JSON 실수를 흡수.
// 429(rate limit)는 매우 길게 + 더 많이 재시도. Cerebras 무료 tier가 burst에 민감하고
// 한 번 throttle 걸리면 분 단위로 풀리는 경우도 있음.
// 마지막 실패면 호출자에게 throw → runWithConcurrency가 undefined로 swallow.
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  attempts = 5,
  baseDelayMs = 1500,
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (i < attempts - 1) {
        const msg: string = e?.message ?? String(e);
        // 429 메시지면 짧은 지수 백오프 (5s → 10s → 20s → 40s).
        // Cerebras TPM은 rolling window라 길게 안 기다려도 보통 풀림. + jitter로 stampede 방지.
        const isRateLimit = /너무 많은 요청|429|rate.?limit|too many/i.test(msg);
        let delay: number;
        if (isRateLimit) {
          delay = 5000 * Math.pow(2, i);
        } else {
          delay = baseDelayMs;
        }
        const jitter = delay * (Math.random() * 0.3);
        delay = Math.floor(delay + jitter);
        console.warn(`[gemini] ${label} 실패 (${i + 1}/${attempts}), ${delay}ms 후 재시도${isRateLimit ? ' [rate-limited]' : ''}:`, msg);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// 단일 청크 API 호출: userContent 만들어 보내고 카드 배열 반환. 1회 재시도 포함.
async function generateSingleBatch(
  userContent: any,
  jobId?: string,
  label = 'chunk',
): Promise<ShortFormScript[]> {
  return withRetry(async () => {
    const text = await callOpenRouter([{ role: 'user', content: userContent }], jobId);
    return parseShortForms(text);
  }, label);
}

// 텍스트 청크용 userContent
function buildTextContent(prompt: string, text: string): any {
  return `${prompt}\n\n[학습 자료 내용]\n${text}`;
}

// 이미지 청크용 userContent (PDF 페이지 JPG들)
function buildImagesContent(prompt: string, jpegs: string[]): any {
  return [
    { type: 'text', text: prompt },
    ...jpegs.map((imgBase64) => ({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${imgBase64}` },
    })),
  ];
}

// 한 Phase 2 호출에 넣을 최대 개념 수. 청크당 concept이 이보다 적으면 그대로 1배치로 fire,
// 더 많으면 N개씩 쪼개 여러 배치로 fire.
const CONCEPTS_PER_FOLLOWUP_CALL = 12;

// concept 순서대로 정렬하고, 각 concept 뒤에 그 파생(example/quiz) 카드를 흘려 넣음.
// 부모 매칭 안 된 고아 카드는 맨 뒤로.
function interleaveDerivatives(
  concepts: ShortFormScript[],
  derived: ShortFormScript[],
): ShortFormScript[] {
  const byParent = new Map<string, ShortFormScript[]>();
  for (const d of derived) {
    const key = d.forConcept ?? '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(d);
  }
  const final: ShortFormScript[] = [];
  const consumed = new Set<string>();
  for (const c of concepts) {
    final.push(c);
    const derivs = byParent.get(c.title);
    if (derivs) {
      for (const d of derivs) {
        if (d.forConcept) d.parentConceptTitle = d.forConcept;
        delete d.forConcept;
        final.push(d);
      }
      consumed.add(c.title);
    }
  }
  for (const [key, list] of byParent) {
    if (consumed.has(key)) continue;
    for (const d of list) {
      if (d.forConcept) d.parentConceptTitle = d.forConcept;
      delete d.forConcept;
      final.push(d);
    }
  }
  return final;
}

/**
 * Phase 2 파이프라인 (budget-aware).
 * Phase 1 청크에서 추출된 concept을 모두 수집한 뒤, finalize()에서:
 *   1. importance 내림차순 정렬
 *   2. HARD_CAP(35) 예산에 맞춰 개념 선별
 *      - importance ≥ FOLLOWUP_IMPORTANCE_THRESHOLD(5) → 풀세트 (concept + example + quiz) = 3카드 예산
 *      - importance < 5 → concept 카드만 (1카드 예산)
 *   3. 풀세트 개념만 Phase 2 dispatch
 *   4. interleave + concept-only 뒤로 추가 + 최종 35개 hard-trim
 *
 * 이전엔 inline pipelining(청크 끝나는 즉시 Phase 2 fire)이었지만, budget을 적용하려면
 * 모든 Phase 1을 본 뒤 선별해야 해서 defer만 사용.
 */
class Phase2Pipeline {
  private allConcepts: ShortFormScript[] = [];
  private tasks: Promise<ShortFormScript[]>[] = [];
  private launched = 0;
  private done = 0;

  constructor(
    private readonly jobId: string | undefined,
    private readonly onChange?: () => void,
    /** 동적 cap: 미지정 시 HARD_CAP. 청크 수 기반 산정 가능 (예: 20p당 30 = ceil(청크/4)*30) */
    private readonly hardCap: number = HARD_CAP,
  ) {}

  /** Phase 1 청크 결과를 받아 concept만 수집 (dispatch는 finalize에서). */
  feedFromPhase1(cards: ShortFormScript[] | undefined): void {
    if (!cards) return;
    const concepts = cards.filter((c) => c.type === 'concept');
    if (concepts.length === 0) return;
    this.allConcepts.push(...concepts);
    this.onChange?.();
  }

  private async runBatch(batch: ShortFormScript[], idx: number): Promise<ShortFormScript[]> {
    try {
      const conceptsForPrompt = batch.map((c) => ({
        title: c.title,
        script: c.script,
        importance: c.importance ?? 5,
      }));
      const prompt = FOLLOWUP_PROMPT_TEMPLATE(conceptsForPrompt);
      const followups = await generateSingleBatch(prompt, this.jobId, `phase2 batch ${idx}`);
      const titleToImportance = new Map(batch.map((c) => [c.title, c.importance ?? 5]));
      return followups
        .filter((f) => f.type === 'example' || f.type === 'quiz')
        .map((f) => {
          const parentImp = f.forConcept ? titleToImportance.get(f.forConcept) : undefined;
          if (parentImp !== undefined) f.importance = parentImp;
          return f;
        });
    } catch (e: any) {
      console.warn(`[Phase2Pipeline] batch ${idx} 실패:`, e?.message);
      return [];
    } finally {
      this.done += 1;
      this.onChange?.();
    }
  }

  /**
   * Phase 1 종료 후 호출: budget 적용 → Phase 2 dispatch → interleave → hard-trim.
   */
  async finalize(): Promise<ShortFormScript[]> {
    // 1) importance 내림차순 정렬
    const sorted = [...this.allConcepts].sort(
      (a, b) => (b.importance ?? 0) - (a.importance ?? 0),
    );

    // 2) budget 분배: this.hardCap은 **상한** (청크 수 기반 동적 산정 가능).
    //    importance ≥ THRESHOLD(5): 풀세트 (concept + example + quiz)
    //    importance < THRESHOLD:    concept-only로 1카드만 (자투리/낮은 별점 표시용, 난이도 위계 시각화)
    const fullSet: ShortFormScript[] = [];
    const conceptOnlySet: ShortFormScript[] = [];
    let budget = this.hardCap;
    for (const c of sorted) {
      const imp = c.importance ?? 0;
      if (imp >= FOLLOWUP_IMPORTANCE_THRESHOLD) {
        if (budget < CARDS_PER_FULL_CONCEPT) break;
        fullSet.push(c);
        budget -= CARDS_PER_FULL_CONCEPT;
      } else {
        if (budget < 1) break;
        conceptOnlySet.push(c);
        budget -= 1;
      }
    }

    // 3) 풀세트에 대해 Phase 2 dispatch (배치 단위)
    for (let i = 0; i < fullSet.length; i += CONCEPTS_PER_FOLLOWUP_CALL) {
      const batch = fullSet.slice(i, i + CONCEPTS_PER_FOLLOWUP_CALL);
      this.launched += 1;
      const idx = this.launched;
      this.tasks.push(this.runBatch(batch, idx));
    }
    this.onChange?.();

    // 4) Phase 2 await + interleave + concept-only append + hard-trim (안전망)
    const results = await Promise.all(this.tasks);
    const allDerived = results.flat();
    const interleaved = interleaveDerivatives(fullSet, allDerived);
    return interleaved.concat(conceptOnlySet).slice(0, this.hardCap);
  }

  get conceptCount(): number { return this.allConcepts.length; }
  get launchedCount(): number { return this.launched; }
  get doneCount(): number { return this.done; }
}

function composePipelineMessage(
  phase1Done: number,
  phase1Total: number,
  pipeline: Phase2Pipeline,
): string {
  const p1 = phase1Total > 1 ? `분석 ${phase1Done}/${phase1Total}` : '분석';
  const p2 = pipeline.launchedCount > 0
    ? ` · 예시·OX ${pipeline.doneCount}/${pipeline.launchedCount}`
    : '';
  const acc = pipeline.conceptCount > 0 ? ` (개념 ${pipeline.conceptCount}개)` : '';
  return `${p1}${p2}${acc}`;
}

export async function generateShortForms(
  file: FileInput,
  unitName: string,
  pageRange?: { start: number; end: number },
  onProgress?: (p: GenerateProgress) => void,
  jobId?: string,
  density: GenerationDensity = 'standard',
): Promise<ShortFormScript[]> {
  // budget(HARD_CAP=35) 적용을 위해 Phase 2는 항상 Phase 1 종료 후 dispatch (이전 Cerebras-only deferPhase2 분기 제거)
  const { ensureSettingsLoaded } = await import('./aiSettings');
  await ensureSettingsLoaded();

  // 1) 텍스트: 길이로 분할
  if (file.kind === 'text') {
    const chunks = splitTextIntoChunks(file.content, TEXT_CHARS_PER_BATCH);
    const prompt = PROMPT_TEMPLATE(unitName, undefined, density);
    let phase1Done = 0;
    const phase1Total = chunks.length;
    // cap 산정용 청크 수: PDF/PPT는 원본 단위(페이지·슬라이드) 기준. 네이티브 PDF와 동일 척도(20단위당 30장).
    // 슬라이드형 자료는 글자가 적어 글자 수로 재면 항상 30에 눌러앉으므로 단위 수로 잰다. 그 외(붙여넣기·.txt)는 글자 분할 청크 수로 폴백.
    const capChunks = file.unitCount != null
      ? Math.ceil(Math.max(1, file.unitCount) / PDF_PAGES_PER_BATCH)
      : chunks.length;
    const pipeline = new Phase2Pipeline(jobId, () => emitProgress(), computeHardCap(capChunks));
    const emitProgress = () => {
      onProgress?.({
        current: phase1Done + pipeline.doneCount,
        total: phase1Total + pipeline.launchedCount,
        generated: pipeline.conceptCount,
        message: composePipelineMessage(phase1Done, phase1Total, pipeline),
      });
    };
    emitProgress();
    await runWithConcurrency(
      chunks,
      CONCURRENCY,
      async (chunk) => {
        const cards = await generateSingleBatch(buildTextContent(prompt, chunk), jobId);
        pipeline.feedFromPhase1(cards);
        return cards;
      },
      () => {
        phase1Done += 1;
        emitProgress();
      },
    );
    const final = await pipeline.finalize();
    onProgress?.({
      current: phase1Total + pipeline.launchedCount,
      total: phase1Total + pipeline.launchedCount,
      generated: final.length,
      message: '완료',
    });
    return final;
  }

  // 2) PDF 네이티브: 페이지 단위로 분할
  const base64 = file.base64.includes(',') ? file.base64.split(',')[1] : file.base64;
  const isPdf = file.mimeType === 'application/pdf';

  if (isPdf && !IS_WEB) {
    console.log('[PDF] 변환+API 스트리밍 시작, pageRange:', pageRange);
    const FileSystem = require('expo-file-system/legacy');
    const tmpPath = FileSystem.cacheDirectory + 'upload_tmp.pdf';
    await FileSystem.writeAsStringAsync(tmpPath, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const startPage0 = (pageRange?.start ?? 1) - 1;
    const endPage0 = (pageRange?.end ?? 100) - 1;

    const apiSem = new Semaphore(CONCURRENCY);
    const apiTasks: Promise<void>[] = [];
    let phase1Done = 0;
    let phase1Total = 0; // 청크 launch될 때마다 증가

    // PDF 청크 수 = ceil(페이지수 / PDF_PAGES_PER_BATCH). over-estimate면 cap만 커지고 미만은 자유라 무방.
    const estPageCount = Math.max(1, endPage0 - startPage0 + 1);
    const estChunks = Math.ceil(estPageCount / PDF_PAGES_PER_BATCH);
    const pipeline = new Phase2Pipeline(jobId, () => emitProgress(), computeHardCap(estChunks));
    const emitProgress = () => {
      onProgress?.({
        current: phase1Done + pipeline.doneCount,
        total: phase1Total + pipeline.launchedCount,
        generated: pipeline.conceptCount,
        message: composePipelineMessage(phase1Done, phase1Total, pipeline),
      });
    };

    const launchBatch = async (
      jpegs: string[],
      start1: number,
      end1: number,
    ) => {
      phase1Total += 1;
      await apiSem.acquire();
      const task = (async () => {
        try {
          const prompt = PROMPT_TEMPLATE(unitName, { start: start1, end: end1 }, density);
          const cards = await generateSingleBatch(buildImagesContent(prompt, jpegs), jobId);
          pipeline.feedFromPhase1(cards);
        } catch (e: any) {
          console.warn(`[generateShortForms] PDF 배치 페이지 ${start1}~${end1} 실패:`, e?.message);
        } finally {
          apiSem.release();
          phase1Done += 1;
          emitProgress();
        }
      })();
      apiTasks.push(task);
    };

    onProgress?.({ current: 0, total: 0, generated: 0, message: 'PDF 페이지 변환 중...' });

    // 페이지를 순차 변환하면서 PDF_PAGES_PER_BATCH개 모이면 즉시 API에 던짐
    let buf: string[] = [];
    let bufStart1 = startPage0 + 1;
    for (let page = startPage0; page <= endPage0; page++) {
      const img = await convertSinglePdfPage(tmpPath, page);
      if (img === null) break;
      buf.push(img);
      if (buf.length >= PDF_PAGES_PER_BATCH) {
        const jpegs = buf;
        const end1 = bufStart1 + jpegs.length - 1;
        await launchBatch(jpegs, bufStart1, end1);
        buf = [];
        bufStart1 = page + 2; // 0-based page → 다음 1-based 페이지
      }
    }
    if (buf.length > 0) {
      const end1 = bufStart1 + buf.length - 1;
      await launchBatch(buf, bufStart1, end1);
    }

    await Promise.all(apiTasks);
    const final = await pipeline.finalize();
    onProgress?.({
      current: phase1Total + pipeline.launchedCount,
      total: phase1Total + pipeline.launchedCount,
      generated: final.length,
      message: '완료',
    });
    return final;
  }

  // 3) 웹 PDF / 단일 이미지: 분할 불가, 한 번에 전송
  onProgress?.({ current: 0, total: 1, generated: 0, message: '분석 중...' });
  const prompt = PROMPT_TEMPLATE(unitName, pageRange, density);
  let userContent: any;
  if (isPdf && IS_WEB) {
    userContent = [
      { type: 'text', text: prompt },
      { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${base64}` } },
    ];
  } else {
    userContent = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${base64}` } },
    ];
  }
  // 이미지 / PDF web: 단일 호출이라 청크 1개 분량으로 cap 산정 → 기본 HARD_CAP(30)
  const pipeline = new Phase2Pipeline(jobId, () => {
    onProgress?.({
      current: 1 + pipeline.doneCount,
      total: 1 + pipeline.launchedCount,
      generated: pipeline.conceptCount,
      message: composePipelineMessage(1, 1, pipeline),
    });
  }, computeHardCap(1));
  const phase1Cards = await generateSingleBatch(userContent, jobId);
  pipeline.feedFromPhase1(phase1Cards);
  const final = await pipeline.finalize();
  onProgress?.({
    current: 1 + pipeline.launchedCount,
    total: 1 + pipeline.launchedCount,
    generated: final.length,
    message: '완료',
  });
  return final;
}

export async function generateFromConcepts(
  conceptScripts: string[]
): Promise<ShortFormScript[]> {
  const prompt = `당신은 한국 입시 1타 강사 출신의 문제 출제 전문가입니다.
학생이 정리해둔 개념들을 바탕으로 응용·심화 문제를 **적정 분량** 생성하세요.

## 입력 개념
${conceptScripts.map((s, i) => `${i + 1}. ${s}`).join('\n\n')}

## 🎯 생성 목표 (강제 아님)

각 개념마다 평균 **2~3 카드** (자료 풍부도에 따라 1~4):
- **quiz**: 1~2개 (정의 확인 + 오개념 함정 또는 세부사항)
- **example**: 1개 (개념 응용/계산/분석)

즉 개념 N개 → **2N~3N개**가 적정. 비슷한 각도 중복은 피하고 정말 유용한 것만.

## 작성 기준

**문체 통일 (모든 카드 공통)**
- 단단한 평서체(~다, ~이다, ~한다, ~된다)로 통일.
- 친근체(~야/~해)·공손체(~합니다/~입니다) 금지. 한 카드 안에서 어미 섞지 말 것.

**quiz (150~250자) — OX 퀴즈는 정답이 새기 전에 절대 노출 금지**

**script 구조 (엄격 준수, 매우 심플하게)**:
\`\`\`
<중립적 진술 한 문장>

정답: O (또는 X)
해설: <30~50자>
\`\`\`
- "다음 문장이 옳은가?" 같은 도입·메타 질문 절대 금지. 진술만 단독으로 적을 것.
- 문제 1줄 → 정답 1줄 → 해설 1줄, 그뿐. 그 외 안내문 금지.

**스포 방지**:
- "정답:" 이전 텍스트에 정답을 시사·암시 금지 (❌ "잘못된 진술:" / ❌ "옳지 않은 부분이 있다")
- title에 정답 힌트 금지 (❌ "OX 퀴즈: 잘못된 ~" / ✅ "OX 퀴즈: <주제>")
- 함정 적극 활용: 단위 함정, "항상/절대" 일반화, 예외, 유사 개념 혼동 — 모두 진술 자체를 중립적으로 출제

**example (250~400자) — 반드시 "물어보는" 형식. 개념 설명만 늘어놓으면 안 됨**
- 구조: **질문 문장(물음표 필수)** → 잠시 생각 유도 → "정답은 ~다" → 풀이 → 핵심 포인트
- script **첫 문단은 반드시 의문문**으로 시작. "~할까?", "~인가?", "다음 중 ~?", "어떻게 ~?" 형식
- 진술문/설명문 흐름 금지 — 그건 concept 카드의 역할. example은 항상 질문이 먼저
- ✅ "다음 중 관성의 예시는? ... 정답은 ~"
- ❌ "관성은 ~이다. 예를 들어 ~" (질문 없이 설명만 — 금지)
- 한 개념당 1개면 충분, 정말 다른 시나리오일 때만 2번째 추가

## 금지

- 입력 개념 범위 밖 내용 만들기
- 같은 각도로 두 번 묻는 중복 카드
- 부실한 한 줄 답변

## 🌡️ 중요도(importance) 1~10 — 모든 카드 필수

각 카드에 1~10 정수로 중요도를 매기세요 (시험·실무에서 마주칠 확률 기준):
- **10**: 핵심 중 핵심  · **8~9**: 매우 중요  · **6~7**: 보통  · **4~5**: 보조  · **1~3**: 부수적
- 응용 문제는 보통 **7~9**, 정의 확인 quiz는 **6~8**, 함정 quiz는 **7~9**, 부차적 디테일은 **3~5**

## 출력 JSON

{
  "shortforms": [
    { "type": "quiz", "title": "OX 퀴즈: [핵심 진술]", "script": "문제 → 정답(O/X) → 해설 150~250자", "imageKeywords": ["kw1", "kw2", "kw3"], "importance": 8 },
    { "type": "example", "title": "예시: [주제]", "script": "<의문문으로 시작하는 질문 문장> 잠시 생각해보자. ...\\n\\n정답은 ~다. 풀이 ~. 핵심은 ~.", "imageKeywords": ["kw1", "kw2", "kw3"], "importance": 7 }
  ]
}

## imageKeywords 규칙 — 매우 엄격

이미지 검색은 영문 tag 매칭. **사진으로 찍을 수 있는 실물**만 사용. 추상어는 무관한 사진을 부른다.

각 카드마다 정확히 3개. 모두 영문 2~3단어. **앞쪽일수록 구체적**:
- [0] **카드 핵심 주제의 실물 한 가지** + 분야 한정어 (예: \`billiard ball motion\`, \`mitochondria microscope\`)
- [1] **그 실물이 등장하는 장면/맥락** — 명사구.
- [2] **분야 도메인 키워드** — 학문 분야명 + 보조 키워드 (예: \`physics mechanics\`, \`cell biology\`)

**금지어**: model, graph, function, theory, principle, idea, formula, equation, concept,
study, education, learning, lesson, knowledge, school, student, classroom,
abstract, diagram, illustration, chart, infographic.

카드 주제와 직접 관련된 실물만. "공부 분위기" 일반 사진 금지.

JSON 외 다른 텍스트 절대 금지.`;

  const shortforms = await generateSingleBatch(prompt, undefined, 'generateFromConcepts');
  return shortforms.filter((s) => s.type === 'quiz' || s.type === 'example');
}

export async function generateSimilarOXQuizzes(
  wrongScripts: string[]
): Promise<ShortFormScript[]> {
  const prompt = `당신은 한국 입시 1타 강사 출신의 오답 분석 전문가입니다.
학생이 틀린 OX 퀴즈를 보고, 같은 개념을 **여러 각도에서** 다시 묻는 새 OX 퀴즈를 폭발적으로 생성해 학생이 완전히 이해하도록 도와주세요.

## 학생이 틀린 문제
${wrongScripts.map((s, i) => `${i + 1}. ${s}`).join('\n\n')}

## 🎯 생성 목표 (강제 아님)

각 틀린 문제마다 다음 각도 중 **2~3개**를 골라 새 OX 퀴즈 생성:

1. **정의 직격탄** — 학생이 놓친 핵심 정의를 정면으로 묻기
2. **반대 함정** — 원문제와 정/오 답이 뒤집힌 비슷한 진술
3. **세부/예외** — 원문제 개념의 세부 사항·예외·경계 사례
4. **인접 개념 비교** — 헷갈리기 쉬운 유사 개념과의 차이
5. **실전 적용** — 개념을 짧은 시나리오에 적용

즉 틀린 문제 N개 → **2N~3N개** 정도. 같은 각도 두 번 묻기 금지.

## 작성 기준 (150~250자)

**문체**: 단단한 평서체(~다, ~이다, ~한다)로 통일. 친근체·공손체 금지. 한 카드 안에서 어미 섞지 말 것.

**script 구조 (엄격 준수, 매우 심플하게)**:
\`\`\`
<중립적 진술 한 문장>

정답: O (또는 X)
해설: <30~80자>
\`\`\`
- "다음 문장이 옳은가?" 같은 도입·메타 질문 절대 금지. 진술만 단독으로 적을 것.
- 문제  → 정답 → 해설 , 그뿐. 그 외 안내문 금지.
- 이 때 쓸 대 없는 문장 금지 (예시: 다음 문장이 옳은가? / 이 진술은 거짓이다 등등)

**스포 방지 절대 규칙**:
- "정답:" 마커 **이전** 텍스트에 정답을 시사·암시·예고 금지
  - ❌ "잘못된 진술:" / ❌ "이 문장은 틀린 부분이 있다" / ❌ "옳지 않은 ~"
  - ✅ 진술 그 자체를 중립적으로 던질 것 — 학생이 판단해야 함
- title에 정답 힌트 금지 (❌ "OX 퀴즈: 잘못된 ~" / ✅ "OX 퀴즈: <주제>")

- 정답(O/X) 명확히 발표
- 왜 그런지 30~80자 해설 — 학생이 헷갈렸을 만한 포인트를 짚어줄 것
- 원문제와 정확히 같은 문장 금지 (각도가 달라야 함)
- 함정 활용: "항상/절대", 단위 누락, 예외 사항, 유사 단어 혼동 — 진술 자체를 중립적으로

## 금지 사항

- 원문제 범위 밖 새 개념 도입
- 비슷한 quiz 두 개 (각도가 정말 달라야)
- 어색한 한국어, 한 줄짜리 부실 답변

## 🌡️ 중요도(importance) 1~10 — 모든 카드 필수

각 카드에 1~10 정수로 중요도. 오답에서 파생된 문제이므로 보통 **7~9** 범위.
정의 직격탄·반대 함정은 **8~9**, 세부/예외·인접 개념은 **6~8**.

## 출력 JSON

{
  "shortforms": [
    { "type": "quiz", "title": "OX 퀴즈: [핵심 진술]", "script": "문제 → 정답(O/X) → 해설 150~250자", "imageKeywords": ["kw1", "kw2", "kw3"], "importance": 8 }
  ]
}

## imageKeywords 규칙 — 매우 엄격

이미지 검색은 영문 tag 매칭. **사진으로 찍을 수 있는 실물**만 사용. 추상어는 무관한 사진을 부른다.

각 카드마다 정확히 3개. 모두 영문 2~3단어. **앞쪽일수록 구체적**:
- [0] **카드 핵심 주제의 실물 한 가지** + 분야 한정어 (예: \`billiard ball motion\`, \`mitochondria microscope\`)
- [1] **그 실물이 등장하는 장면/맥락** — 명사구.
- [2] **분야 도메인 키워드** — 학문 분야명 + 보조 키워드 (예: \`physics mechanics\`, \`cell biology\`)

**금지어**: model, graph, function, theory, principle, idea, formula, equation, concept,
study, education, learning, lesson, knowledge, school, student, classroom,
abstract, diagram, illustration, chart, infographic.

카드 주제와 직접 관련된 실물만. "공부 분위기" 일반 사진 금지.

JSON 외 다른 텍스트 절대 금지.`;

  const shortforms = await generateSingleBatch(prompt, undefined, 'generateSimilarOXQuizzes');
  return shortforms.filter((s) => s.type === 'quiz');
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

function buildChatMessages(question: string, history: ChatMessage[], context?: string): any[] {
  // 채팅 UI가 마크다운은 렌더링하지만 LaTeX 수식은 plain text로 떨어짐.
  // 마크다운(헤더·리스트·표·코드블록·볼드) 자유롭게 허용, 수식은 한국어로 풀어 쓰도록.
  const formatRule = `답변 형식:
- 한국어로 답변. 가독성을 위해 단락·리스트·강조(굵게)·표 같은 일반 마크다운은 사용 OK.
- 수식 기호는 사용 금지: \\, $, \\frac, \\Delta, \\phi 같은 LaTeX/TeX 표기 금지.
- 수식이 필요하면 "Δφ = 2π × 주파수 × 시간차" 처럼 한글·기본 유니코드(Δ, π, ×, ÷, ², ³ 등)로 풀어 쓸 것.
- 코드는 \`\`\` 코드블록에 넣어도 OK.`;
  const systemContent = context
    ? `당신은 학습 도우미입니다. 아래 학습 내용을 참고해 학생의 질문에 친절하고 명확하게 답변해주세요.\n\n${formatRule}\n\n[학습 내용]\n${context}`
    : `당신은 학습 도우미입니다. 학생의 질문에 친절하고 명확하게 답변해주세요.\n\n${formatRule}`;
  return [
    { role: 'system', content: systemContent },
    ...history.map((m) => ({
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.text,
    })),
    { role: 'user', content: question },
  ];
}

export async function askAI(
  question: string,
  history: ChatMessage[],
  context?: string
): Promise<string> {
  return callOpenRouter(buildChatMessages(question, history, context));
}

/**
 * SSE 스트리밍 버전. `onDelta`가 토큰이 도착하는 대로 호출됨 → 점진 표시 가능.
 * 호출자는 fetch abort용 signal을 넘겨 화면 이탈/새 질문 시 끊을 수 있음.
 * Slow 모드(공용 키)에서 진행 중 생성 job 뒤에 줄 설 수 있지만, chat은 jobId='chat'로 들어가
 * 대기열에서 가장 높은 우선순위(rank -1)를 받음 → 슬롯 비는 즉시 처리.
 */
export async function askAIStream(
  question: string,
  history: ChatMessage[],
  context: string | undefined,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const messages = buildChatMessages(question, history, context);
  const { acquireApiSlot } = await import('./apiThrottle');
  const release = await acquireApiSlot('chat');
  try {
    await streamOpenRouter(messages, onDelta, signal);
  } finally {
    release();
  }
}

// stream:true로 OpenRouter 호출 → SSE 본문 파싱 → 각 delta를 onDelta로 흘림.
// JSON 답변 path(callOpenRouter)와 인증·헤더 셋업은 동일하되 body 파싱이 다름.
async function streamOpenRouter(
  messages: any[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { getUserApiKeySync, getProviderSync, ensureSettingsLoaded } = await import('./aiSettings');
  await ensureSettingsLoaded();
  const userKey = getUserApiKeySync();
  const provider = getProviderSync();
  // doCallOpenRouter와 동일 라우팅
  const useOpenAIDirect = provider === 'openai';
  const useCerebrasDirect = provider === 'cerebras';
  const useOpenRouterDirect = provider === 'openrouter' && !!userKey;

  let url: string;
  let model: string;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };

  if (useOpenAIDirect) {
    url = OPENAI_DIRECT_URL;
    model = MODEL_OPENAI;
    headers['Authorization'] = `Bearer ${OPENAI_DIRECT_KEY}`;
  } else if (useCerebrasDirect) {
    url = CEREBRAS_DIRECT_URL;
    model = MODEL_CEREBRAS;
    headers['Authorization'] = `Bearer ${CEREBRAS_DIRECT_KEY}`;
  } else if (useOpenRouterDirect) {
    url = OPENROUTER_DIRECT_URL;
    model = MODEL_OPENROUTER;
    headers['Authorization'] = `Bearer ${userKey!}`;
    headers['HTTP-Referer'] = 'https://gongform.app';
    headers['X-Title'] = 'GongForm';
  } else {
    if (!PROXY_URL || PROXY_URL.includes('YOUR-SUBDOMAIN')) {
      throw new Error('서버 설정이 완료되지 않았어요. 설정에서 자신의 OpenRouter API 키를 등록해주세요.');
    }
    const { auth } = await import('./firebase');
    const user = auth.currentUser;
    if (!user) throw new Error('로그인이 필요해요.');
    let idToken: string;
    try {
      idToken = await user.getIdToken();
    } catch {
      throw new Error('인증 토큰을 가져올 수 없어요. 다시 로그인해주세요.');
    }
    url = PROXY_URL;
    model = resolveModelForProxy(provider);
    headers['Authorization'] = `Bearer ${idToken}`;
    headers['X-Upstream'] = provider;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream: true, max_tokens: 800 }),
      signal,
    });
  } catch (e: any) {
    const m = e?.message ?? String(e);
    if (/abort|cancel/i.test(m)) throw new Error('요청이 취소됐어요.');
    throw new Error('서버로 전달이 안 됐어요. 인터넷 연결을 확인하고 다시 시도해주세요.');
  }

  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch {}
    throw new Error(friendlyApiError(res.status, errText));
  }

  if (!res.body) {
    // 일부 환경에서 body가 ReadableStream으로 안 오면 그냥 text로 떨어뜨림 (deg-radation, 한 번에 표시)
    const fallback = await res.text();
    try {
      const j = JSON.parse(fallback);
      const content: string | undefined = j?.choices?.[0]?.message?.content;
      if (content) onDelta(content);
    } catch { /* 무시 */ }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE는 라인 단위. 'data: {...}\n' / 'data: [DONE]\n' / ': keepalive\n' 등.
    let nlIdx: number;
    while ((nlIdx = buffer.indexOf('\n')) >= 0) {
      const rawLine = buffer.slice(0, nlIdx);
      buffer = buffer.slice(nlIdx + 1);
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const delta: string | undefined = j?.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch { /* keepalive / comment / 부분 JSON — 무시 */ }
    }
  }
}
