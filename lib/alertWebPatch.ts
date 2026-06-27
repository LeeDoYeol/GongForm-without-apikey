// React Native의 Alert.alert는 iOS/Android 네이티브에서만 동작하고 웹에서는 no-op.
// 결과: 웹에서 로그인 실패 등 모든 에러/확인 다이얼로그가 침묵으로 사라짐.
//
// 해결: 앱 부팅 시 1회 monkey-patch.
//   - 0~1 버튼 → window.alert + 버튼 onPress 실행
//   - 2개 이상 버튼 → window.confirm로 cancel/action 분기
//   - 'cancel' 스타일 버튼이 있으면 그것이 confirm=false 경로
//
// 이 모듈은 import 부수 효과(side-effect)만 발생시킨다.
// app/_layout.tsx 최상단에서 한 번만 import.

import { Alert, Platform } from 'react-native';

type AlertButton = {
  text?: string;
  onPress?: (value?: any) => void;
  style?: 'default' | 'cancel' | 'destructive';
};

if (Platform.OS === 'web' && typeof window !== 'undefined') {
  (Alert as any).alert = (title: string, message?: string, buttons?: AlertButton[]) => {
    const text = [title, message].filter(Boolean).join('\n\n');

    if (!buttons || buttons.length === 0) {
      window.alert(text);
      return;
    }

    if (buttons.length === 1) {
      window.alert(text);
      buttons[0].onPress?.();
      return;
    }

    // 2개 이상: cancel과 action으로 분기
    const cancelBtn = buttons.find(
      (b) => b.style === 'cancel' || b.text === '취소' || b.text === 'Cancel',
    );
    // 우선순위: destructive > 첫 비-cancel 버튼
    const actionBtn =
      buttons.find((b) => b !== cancelBtn && b.style === 'destructive') ||
      buttons.find((b) => b !== cancelBtn);

    const ok = window.confirm(text);
    if (ok) {
      actionBtn?.onPress?.();
    } else {
      cancelBtn?.onPress?.();
    }
  };
}

export {};
