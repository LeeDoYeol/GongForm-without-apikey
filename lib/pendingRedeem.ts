// 외부에서 받은 공유 코드를 잠시 보관: gongform://share/CODE 링크로 앱이 열렸을 때,
// 폴더 탭이 mount/focus될 때 한 번만 꺼내 redeem 모달을 자동으로 띄우기 위함.
//
// AsyncStorage 사용 이유:
//   - 콜드 스타트(앱이 꺼져있을 때 링크 탭)에서도 유실 없이 전달돼야 함.
//   - 로그아웃 상태라면 로그인 후 처음 폴더 탭에 들어왔을 때 소비됨.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@gongform/share/pendingRedeem';

export async function setPendingRedeemCode(code: string): Promise<void> {
  try { await AsyncStorage.setItem(KEY, code); } catch {}
}

// 읽고 즉시 비움. 한 번만 소비됨.
export async function consumePendingRedeemCode(): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v) await AsyncStorage.removeItem(KEY);
    return v;
  } catch {
    return null;
  }
}

// 공폼 공유 URL에서 8자리 코드 파싱. 형식:
//   gongform://share/CODE
//   https://gongform.app/share/CODE  (향후 universal link)
// 코드는 영문 대문자+숫자 8자만 인정 (shareProject 알파벳과 호환).
export function parseShareCodeFromUrl(url: string): string | null {
  if (!url) return null;
  const m = url.match(/share\/([A-Z2-9]{8})/i);
  if (!m) return null;
  return m[1].toUpperCase();
}
