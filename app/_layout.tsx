import '@/lib/alertWebPatch';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts } from 'expo-font';
import { Jua_400Regular } from '@expo-google-fonts/jua';
import { GowunDodum_400Regular } from '@expo-google-fonts/gowun-dodum';
import { BlackHanSans_400Regular } from '@expo-google-fonts/black-han-sans';
import { CuteFont_400Regular } from '@expo-google-fonts/cute-font';

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { GenerationStatusBanner } from '@/components/GenerationStatusBanner';
import { XpToast } from '@/components/XpToast';
import { ensureSettingsLoaded } from '@/lib/aiSettings';
import { ensureFontLoaded } from '@/lib/fontSettings';
import { cleanupUnusedCache } from '@/lib/cacheManager';
import { hasSeenIntro, needsFirstSetup } from '@/lib/onboardingFlag';
import { parseShareCodeFromUrl, setPendingRedeemCode } from '@/lib/pendingRedeem';
import { prefetchHome, invalidateHomeCache } from '@/lib/homePrefetch';

function RootNavigator() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => { ensureSettingsLoaded(); }, []);

  // 로그인된 사용자별로 1회씩 Edge TTS mp3 캐시 자동 정리.
  // 같은 uid에 대해 중복 실행 방지, 앱 시작 부담 줄이려 3초 지연 후 fire-and-forget.
  const cleanedUidRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = user?.uid;
    if (!uid || cleanedUidRef.current === uid) return;
    cleanedUidRef.current = uid;
    const t = setTimeout(() => {
      cleanupUnusedCache(uid)
        .then((r) => {
          if (r.deleted > 0) {
            console.log(`[cacheManager] auto-cleanup: ${r.deleted}개 파일 · ${(r.freedBytes / 1024 / 1024).toFixed(1)} MB`);
          }
        })
        .catch(() => { /* 실패해도 무시 — 다음 로그인 때 재시도 */ });
    }, 3000);
    return () => clearTimeout(t);
  }, [user?.uid]);

  // 홈탭 prefetch: player 화면이 아니고 로그인 상태이면 백그라운드로 shortforms + 첫 이미지 준비.
  // 사용자가 user 변경 시 캐시 무효화. player 진입 동안에는 트리거하지 않아 player 리소스에 양보.
  const prefetchedUidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!user) {
      invalidateHomeCache();
      prefetchedUidRef.current = null;
      return;
    }
    if (prefetchedUidRef.current !== user.uid) {
      invalidateHomeCache();
      prefetchedUidRef.current = user.uid;
    }
    if (segments[0] === 'player') return;
    prefetchHome(user.uid);
  }, [user, segments]);

  // gongform://share/CODE 수신: 콜드 스타트 + 백그라운드 → 포그라운드 둘 다 처리.
  // 코드를 AsyncStorage에 저장한 뒤 폴더 탭으로 라우팅; 폴더 탭이 focus 시 자동으로 redeem 모달 오픈.
  useEffect(() => {
    const handleUrl = async (url: string | null) => {
      const code = url ? parseShareCodeFromUrl(url) : null;
      if (!code) return;
      await setPendingRedeemCode(code);
      // 로그인 상태일 때만 즉시 폴더 탭으로 이동; 비로그인이면 RootNavigator가 login으로 보내고,
      // 로그인 완료 후 사용자가 폴더 탭에 들어오는 시점에 consume.
      if (user) router.push('/(tabs)/folders');
    };
    // 콜드 스타트: 앱을 링크로 열었을 때 최초 1회
    Linking.getInitialURL().then(handleUrl).catch(() => {});
    // 워밍 스타트: 앱 실행 중 링크 수신
    const sub = Linking.addEventListener('url', (e) => handleUrl(e.url));
    return () => sub.remove();
  }, [user, router]);

  // 웹 전역 단축키: ESC = 뒤로가기. 입력창에 포커스 있을 땐 무시 (브라우저 기본 동작 보존).
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const r: any = router;
      if (typeof r.canDismiss === 'function' && r.canDismiss()) {
        r.dismiss();
      } else if (router.canGoBack()) {
        router.back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  // 온보딩 플래그: segments[0] 변경마다 재읽기. 인트로/설정 화면이 markIntroSeen / clearNeedsFirstSetup
  // 후 라우팅하면 그 다음 segment 변경이 이 effect를 깨워 캐시 갱신.
  const [introSeen, setIntroSeen] = useState<boolean | null>(null);
  const [setupNeeded, setSetupNeeded] = useState<boolean | null>(null);
  const seg0 = segments[0];
  useEffect(() => {
    let alive = true;
    Promise.all([hasSeenIntro(), needsFirstSetup()]).then(([i, s]) => {
      if (!alive) return;
      setIntroSeen(i);
      setSetupNeeded(s);
    });
    return () => { alive = false; };
  }, [user, seg0]);

  useEffect(() => {
    if (loading || introSeen === null || setupNeeded === null) return;
    const inAuthGroup = seg0 === '(auth)';
    const inOnboarding = seg0 === 'onboarding';

    if (!user) {
      // 로그아웃 상태:
      //   - 첫 실행(인트로 미경험) → /onboarding/intro
      //   - 인트로 경험 후 → /(auth)/login
      if (!introSeen && !inOnboarding && !inAuthGroup) {
        router.replace('/onboarding/intro');
      } else if (introSeen && !inAuthGroup && !inOnboarding) {
        router.replace('/(auth)/login');
      }
    } else {
      // 로그인 상태:
      //   - 가입 직후(setupNeeded) → /onboarding/setup
      //   - 평상시 + auth/onboarding 그룹에 있으면 → /(tabs)
      if (setupNeeded && !inOnboarding) {
        router.replace('/onboarding/setup');
      } else if (!setupNeeded && (inAuthGroup || inOnboarding)) {
        router.replace('/(tabs)');
      }
    }
  }, [user, loading, seg0, introSeen, setupNeeded, router]);

  return (
    <>
      <Stack>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen name="folder/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="project/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="upload/[projectId]" options={{ headerShown: false }} />
        <Stack.Screen name="generation" options={{ headerShown: false }} />
        <Stack.Screen name="wrong-answers" options={{ headerShown: false }} />
        <Stack.Screen name="study-notes" options={{ headerShown: false }} />
        <Stack.Screen name="search" options={{ headerShown: false }} />
        <Stack.Screen name="stats" options={{ headerShown: false }} />
        <Stack.Screen name="ai-chat" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen
          name="player/[id]"
          options={{ headerShown: false, presentation: 'fullScreenModal' }}
        />
      </Stack>
      {/* 백그라운드 숏폼 생성 작업 상태: 모든 화면 위에 떠 있음 */}
      <GenerationStatusBanner />
      <XpToast />
      <StatusBar style="light" />
    </>
  );
}

export default function RootLayout() {
  // 한글 디스플레이 폰트 4종: 사용자가 설정에서 선택. 로드 완료 전에도 시스템 폰트로 fallback.
  useFonts({
    Jua_400Regular,
    GowunDodum_400Regular,
    BlackHanSans_400Regular,
    CuteFont_400Regular,
  });
  // 저장된 폰트 선택 로드
  useEffect(() => { ensureFontLoaded(); }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
