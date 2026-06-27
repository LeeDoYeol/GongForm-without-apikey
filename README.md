# 공폼 (GongForm)

학습 자료(PDF, 이미지, 텍스트)를 AI로 분석해 숏폼 학습 카드(개념, 예시, 퀴즈)로 만들어 주는 학습 앱입니다.

## 설치 방법

```bash
npm install      # 의존성 설치
npx expo start   # 개발 서버 시작
```

개발 서버가 뜨면 터미널에서 `a`(안드로이드), `i`(iOS), `w`(웹)를 눌러 원하는 기기에서 실행합니다.

실행 전, 아래 위치의 placeholder(`여기 ... 입력`)를 본인 값으로 교체해야 합니다.

| 파일 | 항목 | 발급처 |
|------|------|--------|
| `lib/firebase.ts` | `firebaseConfig` (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId, measurementId) **(필수)** | Firebase 콘솔 / 프로젝트 설정 / 웹 앱 구성 |
| `lib/gemini.ts` | `OPENAI_DIRECT_KEY` | platform.openai.com/api-keys |
| `lib/gemini.ts` | `CEREBRAS_DIRECT_KEY` | cloud.cerebras.ai |
| `lib/gemini.ts` | `PROXY_URL` (OpenRouter Worker 주소) | 배포한 Cloudflare Worker URL |
| `lib/edgeTts.ts` | `EDGE_TTS_PROXY_URL` (Edge TTS Worker 주소) | 배포한 Cloudflare Worker URL |
| `lib/imageSearch.ts` | `PIXABAY_KEY` (선택) | pixabay.com/api/docs |
| `lib/imageSearch.ts` | `GIPHY_KEY` (선택) | developers.giphy.com |
| `lib/veo.ts` | `API_KEY` (현재 미사용) | Google AI Studio |
| `worker/wrangler-openrouter.toml` | `FIREBASE_PROJECT_ID` | Firebase 프로젝트 ID |
| `app.json` | `owner` | 본인 Expo 계정명 |

AI 생성은 다음 셋 중 하나만 갖추면 됩니다: 앱 마이 탭에서 본인 OpenRouter 키 등록, `lib/gemini.ts`에 직접 키 입력, Cloudflare Worker 배포 후 주소 입력.

웹에서 OpenRouter를 직접 호출할 때는 CORS 오류 우회를 위해 별도 터미널에서 로컬 프록시를 함께 실행하세요.

```bash
node proxy.js   # localhost:3001 에서 OpenRouter CORS 프록시 실행
```

## 사용 방법

1. 회원가입 / 로그인
2. 폴더와 프로젝트 생성
3. 프로젝트에 PDF, 이미지, 텍스트 업로드 (AI가 자동으로 숏폼 카드 생성)
4. 세로 플레이어로 학습 (스와이프로 넘기기, TTS 재생, 오답/개념 저장)
5. 오답노트/정리노트에서 복습, 홈에서 스트릭/학습 통계 확인

전체 기능 확인에는 개발 빌드 또는 EAS 빌드가 필요합니다 (PDF 썸네일 등 일부 네이티브 기능은 Expo Go에서 동작하지 않음).
