import { useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  useWindowDimensions,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors, fonts, screen } from '@/lib/theme';
import { Btn, ImgSlot } from '@/components/wf';
import { markIntroSeen } from '@/lib/onboardingFlag';

interface Slide {
  heading: string;
  highlight: string;        // accent-colored portion of heading
  body: string;
  imageLabel: string;
}

const SLIDES: Slide[] = [
  {
    heading: '공부도 ',
    highlight: '숏폼',
    body: 'PDF · 필기 · 녹음을 올리면 AI가\n30초 학습 카드로 만들어줘요',
    imageLabel: 'hero · upload to shorts',
  },
  {
    heading: 'AI가 알아서 ',
    highlight: '개념·예시·퀴즈',
    body: '자료에서 학습 포인트를 뽑아\n숏폼 3종으로 정리해드려요',
    imageLabel: 'cards: concept · example · quiz',
  },
  {
    heading: '복습은 ',
    highlight: '똑똑하게',
    body: '틀린 문제는 간격을 두고 다시 풀어\n자연스럽게 기억에 박혀요',
    imageLabel: 'spaced repetition · wrong answers',
  },
];

export default function OnboardingIntroScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const listRef = useRef<FlatList<Slide>>(null);

  const finish = async () => {
    await markIntroSeen();
    router.replace('/(auth)/login');
  };

  const onNext = () => {
    if (index < SLIDES.length - 1) {
      const nextIdx = index + 1;
      listRef.current?.scrollToIndex({ index: nextIdx, animated: true });
      setIndex(nextIdx);
    } else {
      finish();
    }
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== index) setIndex(i);
  };

  const renderItem = ({ item }: { item: Slide }) => (
    <View style={[styles.slide, { width }]}>
      <View style={styles.brand}>
        <Text style={styles.logo}>공폼</Text>
        <Text style={styles.brandMeta}>GongForm</Text>
      </View>

      <ImgSlot label={item.imageLabel} h={200} dashed style={{ marginBottom: 28 }} />

      <Text style={styles.h1}>
        {item.heading}
        <Text style={styles.h1Accent}>{item.highlight}</Text>
        <Text>처럼</Text>
      </Text>
      <Text style={styles.p}>{item.body}</Text>
    </View>
  );

  return (
    <SafeAreaView style={screen.light}>
      <View style={styles.topBar}>
        <Text style={styles.pageIndicator}>{index + 1} / {SLIDES.length}</Text>
        <TouchableOpacity onPress={finish} hitSlop={8}>
          <Text style={styles.skip}>건너뛰기 →</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={SLIDES}
        keyExtractor={(_, i) => String(i)}
        renderItem={renderItem}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        bounces={false}
      />

      <View style={styles.footer}>
        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                i === index ? styles.dotActive : styles.dotInactive,
              ]}
            />
          ))}
        </View>

        <Btn primary lg full onPress={onNext}>
          {index < SLIDES.length - 1 ? '다음' : '시작하기'}
        </Btn>

        <View style={styles.loginRow}>
          <Text style={styles.loginText}>이미 계정이 있어요 · </Text>
          <TouchableOpacity onPress={finish} hitSlop={8}>
            <Text style={styles.linkAccent}>로그인</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 24,
  },
  pageIndicator: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.ink3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  skip: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.ink3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  slide: { paddingHorizontal: 22, paddingTop: 8 },
  brand: { alignItems: 'center', marginBottom: 28 },
  logo: { fontFamily: fonts.display, fontSize: 56, lineHeight: 54, color: colors.accent },
  brandMeta: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.ink3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 4,
  },

  h1: { fontFamily: fonts.body, fontSize: 28, lineHeight: 36, color: colors.ink, textAlign: 'center', marginBottom: 10 },
  h1Accent: { color: colors.accent },
  p: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22, color: colors.ink2, textAlign: 'center' },

  footer: { paddingHorizontal: 22, paddingBottom: 20 },

  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginBottom: 24 },
  dot: { height: 6, borderRadius: 3 },
  dotActive: { width: 24, backgroundColor: colors.accent },
  dotInactive: { width: 6, backgroundColor: colors.ink4 },

  loginRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: 14 },
  loginText: { fontFamily: fonts.body, fontSize: 14, color: colors.ink3 },
  linkAccent: { fontFamily: fonts.body, fontSize: 14, color: colors.accent },
});
