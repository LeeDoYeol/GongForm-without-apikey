import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Slider from '@react-native-community/slider';
import { useAuth } from '@/contexts/AuthContext';
import { colors, fonts, text as t, screen } from '@/lib/theme';
import { Box, Chip, Btn } from '@/components/wf';
import {
  saveLearnerProfile,
  SUBJECTS,
  GRADES,
} from '@/lib/learnerProfile';
import { clearNeedsFirstSetup } from '@/lib/onboardingFlag';

const MIN_GOAL = 5;
const MAX_GOAL = 30;

export default function OnboardingSetupScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [subjects, setSubjects] = useState<Set<string>>(new Set());
  const [grade, setGrade] = useState<string | null>(null);
  const [dailyGoal, setDailyGoal] = useState(10);
  const [saving, setSaving] = useState(false);

  const toggleSubject = (key: string) => {
    setSubjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const canSubmit = subjects.size > 0 && grade !== null && !saving;

  const finish = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await saveLearnerProfile(user.uid, {
        subjects: Array.from(subjects),
        grade: grade!,
        dailyGoal,
      });
      await clearNeedsFirstSetup();
      router.replace('/(tabs)');
    } catch (e: any) {
      Alert.alert('저장 실패', e?.message ?? '잠시 후 다시 시도해주세요.');
    } finally {
      setSaving(false);
    }
  };

  const skip = async () => {
    await clearNeedsFirstSetup();
    router.replace('/(tabs)');
  };

  return (
    <SafeAreaView style={screen.light}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* 진행 바: 가입(1) · 설정(2) · 완료(3) 중 2 활성 */}
        <View style={styles.progress}>
          <View style={[styles.progressSeg, { backgroundColor: colors.accent }]} />
          <View style={[styles.progressSeg, { backgroundColor: colors.accent }]} />
          <View style={[styles.progressSeg, { backgroundColor: colors.ink4 }]} />
        </View>

        <View style={styles.titleRow}>
          <Text style={t.meta}>STEP 2 OF 3</Text>
          <TouchableOpacity onPress={skip} hitSlop={8}>
            <Text style={styles.skip}>건너뛰기 →</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.h1}>뭘 공부해요?</Text>
        <Text style={styles.p}>관심 과목을 골라주세요 (여러 개 OK)</Text>

        {/* 과목 그리드 */}
        <View style={styles.subjectGrid}>
          {SUBJECTS.map((s) => {
            const on = subjects.has(s.key);
            return (
              <TouchableOpacity
                key={s.key}
                style={[styles.subjectCard, on && styles.subjectCardOn]}
                onPress={() => toggleSubject(s.key)}
                activeOpacity={0.8}
              >
                <Text style={[styles.subjectGlyph, on && styles.subjectGlyphOn]}>{s.glyph}</Text>
                <Text style={styles.subjectLabel}>{s.key}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* 학년 */}
        <Text style={styles.h3}>학년</Text>
        <View style={styles.chipsRow}>
          {GRADES.map((g) => (
            <TouchableOpacity key={g} onPress={() => setGrade(g)} activeOpacity={0.8}>
              <Chip accent={grade === g}>
                {g}
              </Chip>
            </TouchableOpacity>
          ))}
        </View>

        {/* 하루 공부 목표 */}
        <Text style={styles.h3}>하루 공부 목표</Text>
        <Box style={styles.goalBox}>
          <View style={styles.goalRow}>
            <Text style={styles.goalLabel}>숏폼</Text>
            <Text style={styles.goalNum}>{dailyGoal}개</Text>
          </View>
          <Slider
            style={{ width: '100%', height: 36 }}
            minimumValue={MIN_GOAL}
            maximumValue={MAX_GOAL}
            step={1}
            value={dailyGoal}
            onValueChange={setDailyGoal}
            minimumTrackTintColor={colors.accent}
            maximumTrackTintColor={colors.ink4}
            thumbTintColor={colors.accent}
          />
          <View style={styles.goalScale}>
            <Text style={styles.goalScaleText}>{MIN_GOAL}</Text>
            <Text style={styles.goalScaleText}>{MAX_GOAL}</Text>
          </View>
        </Box>

        <Btn primary lg full onPress={finish} loading={saving} disabled={!canSubmit}>
          계속
        </Btn>

        <Text style={styles.note}>
          {!canSubmit && subjects.size === 0
            ? '과목을 하나 이상 골라주세요'
            : !canSubmit && grade === null
            ? '학년을 골라주세요'
            : '나중에 설정에서 바꿀 수 있어요'}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 30 },

  progress: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  progressSeg: { flex: 1, height: 5, borderRadius: 3 },

  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  skip: { fontFamily: fonts.mono, fontSize: 12, color: colors.ink3, letterSpacing: 0.5, textTransform: 'uppercase' },

  h1: { fontFamily: fonts.body, fontSize: 28, color: colors.ink, lineHeight: 32, marginBottom: 6 },
  p: { fontFamily: fonts.body, fontSize: 15, color: colors.ink2, lineHeight: 21, marginBottom: 22 },
  h3: { fontFamily: fonts.body, fontSize: 18, color: colors.ink, marginBottom: 10, marginTop: 4 },

  subjectGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 24 },
  subjectCard: {
    width: '31%',
    borderWidth: 1.5,
    borderColor: colors.stroke,
    borderRadius: 14,
    backgroundColor: 'transparent',
    paddingVertical: 14,
    alignItems: 'center',
    gap: 4,
  },
  subjectCardOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  subjectGlyph: { fontFamily: fonts.display, fontSize: 26, color: colors.ink2 },
  subjectGlyphOn: { color: colors.accentDeep },
  subjectLabel: { fontFamily: fonts.body, fontSize: 14, color: colors.ink },

  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 26 },

  goalBox: { padding: 14, marginBottom: 24 },
  goalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  goalLabel: { fontFamily: fonts.body, fontSize: 15, color: colors.ink },
  goalNum: { fontFamily: fonts.display, fontSize: 24, color: colors.accent },
  goalScale: { flexDirection: 'row', justifyContent: 'space-between' },
  goalScaleText: { fontFamily: fonts.mono, fontSize: 11, color: colors.ink3 },

  note: { fontFamily: fonts.mono, fontSize: 11, color: colors.ink3, textAlign: 'center', marginTop: 14 },
});
