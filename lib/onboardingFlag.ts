// 온보딩 진행 플래그: AsyncStorage 로컬 only.
// 두 가지를 관리:
//   - hasSeenOnboarding: 인트로 캐러셀(A)을 본 적이 있는가
//   - needsFirstSetup: 가입 직후 첫 설정(B)을 보여줘야 하는가
// 두 플래그 모두 기기-로컬. 다른 기기에서는 다시 표시될 수 있음 (의도된 동작).
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_SEEN_INTRO = '@gongform/onboarding/hasSeenIntro';
const KEY_NEEDS_SETUP = '@gongform/onboarding/needsFirstSetup';

export async function hasSeenIntro(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(KEY_SEEN_INTRO)) === '1'; }
  catch { return false; }
}

export async function markIntroSeen(): Promise<void> {
  try { await AsyncStorage.setItem(KEY_SEEN_INTRO, '1'); } catch {}
}

export async function needsFirstSetup(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(KEY_NEEDS_SETUP)) === '1'; }
  catch { return false; }
}

export async function markNeedsFirstSetup(): Promise<void> {
  try { await AsyncStorage.setItem(KEY_NEEDS_SETUP, '1'); } catch {}
}

export async function clearNeedsFirstSetup(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY_NEEDS_SETUP); } catch {}
}
