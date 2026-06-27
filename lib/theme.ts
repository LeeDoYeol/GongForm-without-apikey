// GongForm hi-fi 다크 테마: UI 리워크 이전 팔레트로 복원.
// 토큰 이름은 wireframe 시절 그대로 유지 (paper/ink), 값만 다크 hi-fi로 매핑.
import { Platform, StyleSheet, TextStyle, ViewStyle } from 'react-native';

export const colors = {
  // ink = 본문 텍스트 (라이트 톤)
  ink: '#ffffff',
  ink2: '#aaaaaa',
  ink3: '#666666',
  ink4: '#3a3a3a',
  // paper = 배경 (다크 톤)
  paper: '#0D0D0D',         // 메인 배경
  paper2: '#1A1A1A',        // 카드/표면
  // accent = 코발트 블루 (원래 유지)
  accent: '#4F8EF7',
  accentSoft: '#1D2A44',    // 다크 배경 위의 옅은 액센트 (어두운 파랑 톤)
  accentDeep: '#8AB4F8',    // 강조 (다크에서 더 밝은 톤)
  // 보조 액센트: 다양성을 위해 그린/오렌지 톤 추가 (다크 배경 위 톤)
  accentGreen: '#65B765',
  accentGreenSoft: '#222922',
  accentGreenDeep: '#86D586',
  accentOrange: '#D67735',
  accentOrangeSoft: '#2C231D',
  accentOrangeDeep: '#E89A5F',
  // 정리 노트 카테고리 전용: sky와 코발트 사이 톤 (hue를 accent 쪽으로 옮겨 묵직하게)
  note: '#5DAEF5',
  noteSoft: '#1A2638',      // 다크 배경 위 옅은 톤 (배경)
  noteDeep: '#A8D0F8',      // 밝은 강조 (텍스트/숫자)
  // 레벨/XP 카테고리 전용: 학습 보상 신호 (톤다운된 머스타드, 트로피·진행바·통계값)
  accentYellow: '#D4BE75',
  // 상태 색
  good: '#22C55E',
  goodSoft: '#1A2E1F',      // 다크 배경 위의 옅은 success 톤 (아이콘 박스 배경 등)
  bad: '#EF4444',
  badSoft: '#2E1C1C',       // 다크 배경 위의 옅은 destructive 톤
  // stroke = 카드/요소 보더 (어두운 회색)
  stroke: '#2A2A2A',
  strokeSoft: '#1F1F1F',
  strokeDashed: '#3a3a3a',
} as const;

// 폰트: UI 리워크 이전 선호도 복구
// 디스플레이/숫자 강조: Jua (둥글둥글, 친근, 학습 앱 톤)
// 본문/UI: 시스템 기본 (가독성 우선, fontFamily 미지정 효과)
// 로고/장식: CuteFont (홈 로고 등 특수 위치)
// 모노: 시스템 기본
export const fonts = {
  body: undefined as unknown as string,        // 시스템 기본 sans-serif
  display: 'Jua_400Regular',                   // 헤더·강조 숫자
  logo: 'CuteFont_400Regular',                 // 브랜드 로고만 사용 (선택)
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace' }) as string,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const spacing = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const text = StyleSheet.create({
  h1: { fontFamily: fonts.display, fontSize: 26, lineHeight: 30, color: colors.ink, fontWeight: '700' },
  h2: { fontFamily: fonts.display, fontSize: 20, lineHeight: 24, color: colors.ink, fontWeight: '700' },
  h3: { fontSize: 17, lineHeight: 22, color: colors.ink, fontWeight: '700' } as TextStyle,
  p: { fontSize: 15, lineHeight: 21, color: colors.ink2 } as TextStyle,
  meta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.ink3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  } as TextStyle,
  muted: { color: colors.ink3 } as TextStyle,
  accent: { color: colors.accent } as TextStyle,
  display: { fontFamily: fonts.display, color: colors.ink, fontWeight: '700' } as TextStyle,
});

// 부드러운 카드 그림자: 다크 위에서 깊이감만 약하게.
export const shadow = {
  hard: Platform.select({
    web: {} as any,
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.4,
      shadowRadius: 8,
    },
    android: { elevation: 4 },
    default: {},
  }) as ViewStyle,
};

// 카드/박스: 다크 카드에 1px 보더가 hi-fi 표준
export const box = StyleSheet.create({
  base: {
    borderWidth: 1,
    borderColor: colors.stroke,
    borderRadius: radius.md,
    backgroundColor: colors.paper2,
  },
  dashed: { borderStyle: 'dashed', borderColor: colors.strokeDashed },
  fill: { backgroundColor: colors.paper2 },
  accent: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  ink: { backgroundColor: colors.ink, borderColor: colors.ink },
  pill: { borderRadius: radius.pill },
  sharp: { borderRadius: radius.sm },
});

export const line = StyleSheet.create({
  base: { height: 0, borderTopWidth: 1, borderTopColor: colors.stroke },
  thin: { borderTopWidth: 1, borderTopColor: colors.strokeSoft },
  dashed: { borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: colors.strokeDashed },
  accent: { borderTopColor: colors.accent },
});

// 화면 컨테이너: 다크 배경 (이름은 wireframe 시절 'light' 유지, 값만 dark)
export const screen = StyleSheet.create({
  light: { flex: 1, backgroundColor: colors.paper },   // 다크 hi-fi
  dark: { flex: 1, backgroundColor: '#000' },
});
