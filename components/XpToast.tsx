// 레벨업 알림 토스트. 화면 중앙 상단에 잠깐 떠올랐다 사라짐.
// XP 적립은 조용히, 레벨업은 명시적으로 알림.
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { subscribeXpEvents, LevelInfo } from '@/lib/levelSystem';

export function XpToast() {
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const [newLevel, setNewLevel] = useState(1);
  const [info, setInfo] = useState<LevelInfo | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-20)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = subscribeXpEvents((e) => {
      if (!e.result.leveledUp) return;
      setNewLevel(e.result.newLevel);
      setInfo(e.result.info);
      setVisible(true);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start();
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        Animated.parallel([
          Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
          Animated.timing(translateY, { toValue: -20, duration: 220, useNativeDriver: true }),
        ]).start(() => setVisible(false));
      }, 2400);
    });
    return () => {
      unsub();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [opacity, translateY]);

  if (!visible) return null;

  const wrapStyle =
    Platform.OS === 'web'
      ? ({ position: 'fixed', top: Math.max(20, insets.top + 12), left: 0, right: 0, alignItems: 'center', zIndex: 10000 } as any)
      : { position: 'absolute' as const, top: Math.max(20, insets.top + 12), left: 0, right: 0, alignItems: 'center' as const, zIndex: 10000, elevation: 40 };

  return (
    <Animated.View pointerEvents="none" style={[wrapStyle, { opacity, transform: [{ translateY }] }]}>
      <View style={styles.toast}>
        <View style={styles.iconWrap}>
          <Ionicons name="trophy" size={22} color="#FBBF24" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>레벨업! · Lv. {newLevel}</Text>
          {info ? (
            <Text style={styles.sub}>누적 {info.totalXP.toLocaleString()} XP</Text>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#1A1A1A',
    borderWidth: 1, borderColor: '#FBBF2470',
    borderRadius: 14,
    paddingVertical: 10, paddingHorizontal: 14,
    minWidth: 220, maxWidth: 320,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 4 },
  },
  iconWrap: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: '#FBBF2418',
    borderWidth: 1, borderColor: '#FBBF2450',
    alignItems: 'center', justifyContent: 'center',
  },
  title: { color: '#FBBF24', fontSize: 14, fontWeight: '800' },
  sub: { color: '#aaa', fontSize: 11, marginTop: 2 },
});
