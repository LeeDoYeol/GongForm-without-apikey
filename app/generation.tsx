// 전체 화면 생성 상태: 우상단 배너 탭으로 진입.
// 여러 작업의 진행/완료/오류를 리스트로 표시. 뒤로 가기로 이전 화면 복귀.
import { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { subscribe, getJobs, dismissJob, dismissAllFinished, GenerationJob } from '@/lib/generationManager';
import { colors, fonts, radius, screen } from '@/lib/theme';

export default function GenerationScreen() {
  const router = useRouter();
  const [jobs, setJobs] = useState<GenerationJob[]>(getJobs());

  useEffect(() => {
    const unsub = subscribe(setJobs);
    return unsub;
  }, []);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const runningCount = jobs.filter((j) => j.status === 'running').length;
  const finishedCount = jobs.filter((j) => j.status !== 'running').length;

  if (jobs.length === 0) {
    return (
      <SafeAreaView style={screen.light}>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>생성 작업</Text>
        </View>
        <View style={styles.centered}>
          <Ionicons name="cloud-done-outline" size={56} color={colors.ink4} />
          <Text style={styles.emptyTitle}>진행 중인 작업이 없어요</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={goBack}>
            <Text style={styles.primaryBtnText}>뒤로</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={screen.light}>
      <View style={styles.headerCenter}>
        <Text style={styles.headerTitle}>생성 작업</Text>
        <Text style={styles.headerSub} numberOfLines={1}>
          진행 {runningCount} · 완료/오류 {finishedCount}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} onProject={() => {
            dismissJob(job.id);
            router.replace({ pathname: '/project/[id]', params: { id: job.projectId } });
          }} />
        ))}
      </ScrollView>

      <View style={styles.bottomBar}>
        {finishedCount > 0 && (
          <TouchableOpacity style={styles.clearBtn} onPress={dismissAllFinished}>
            <Ionicons name="trash-outline" size={14} color={colors.ink2} />
            <Text style={styles.clearBtnText}>완료/오류 모두 정리</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.bottomBackBtn} onPress={goBack}>
          <Ionicons name="arrow-back" size={16} color={colors.paper} />
          <Text style={styles.bottomBackText}>뒤로</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function JobCard({ job, onProject }: { job: GenerationJob; onProject: () => void }) {
  const isRunning = job.status === 'running';
  const isDone = job.status === 'done';
  const isError = job.status === 'error';
  const accent = isRunning ? colors.accent : isDone ? colors.good : colors.bad;

  return (
    <View style={[styles.card, { borderColor: accent }]}>
      <View style={styles.cardHeader}>
        <View style={[styles.statusDot, { backgroundColor: accent }]} />
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>{job.label}</Text>
          <Text style={styles.cardSub} numberOfLines={1}>📚 {job.projectTitle}</Text>
        </View>
        <TouchableOpacity
          onPress={() => dismissJob(job.id)}
          hitSlop={8}
          style={styles.cardClose}
        >
          <Ionicons name="close" size={16} color={colors.ink3} />
        </TouchableOpacity>
      </View>
      <View style={styles.cardBody}>
        <View style={styles.statusIconWrap}>
          {isRunning ? (
            <ActivityIndicator size="small" color={accent} />
          ) : isDone ? (
            <Ionicons name="checkmark-circle-outline" size={20} color={accent} />
          ) : (
            <Ionicons name="alert-circle-outline" size={20} color={accent} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.statusLabel, { color: accent }]}>
            {isRunning
              ? (job.progress.msg.replace(/^[^A-Za-z가-힣]+/, '') || '학습 자료 분석 중')
              : isDone ? `생성 완료 · ${job.generatedCount}개` : '생성 실패'}
          </Text>
          <Text style={styles.detail} numberOfLines={2}>
            {isError ? (job.errorMessage ?? '알 수 없는 오류') : job.progress.detail || job.progress.msg}
          </Text>
        </View>
      </View>
      {isDone && (
        <TouchableOpacity style={[styles.cardActionBtn, { backgroundColor: accent }]} onPress={onProject}>
          <Ionicons name="layers-outline" size={14} color={colors.paper} />
          <Text style={styles.cardActionText}>이 프로젝트로 가기</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerCenter: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.strokeSoft,
  },
  headerTitle: { fontFamily: fonts.body, fontSize: 16, color: colors.ink },
  headerSub: { fontFamily: fonts.mono, fontSize: 12, color: colors.ink3, marginTop: 3, letterSpacing: 0.3 },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 12 },
  emptyTitle: { fontFamily: fonts.body, color: colors.ink2, fontSize: 16, marginTop: 4 },

  list: { padding: 16, gap: 12, paddingBottom: 120 },

  card: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    borderWidth: 1.5,
    padding: 14,
    gap: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  cardTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 14 },
  cardSub: { fontFamily: fonts.body, color: colors.ink3, fontSize: 11, marginTop: 2 },
  cardClose: { padding: 2 },
  cardBody: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  statusIconWrap: { width: 20, alignItems: 'center', paddingTop: 1 },
  statusLabel: { fontFamily: fonts.body, fontSize: 13, fontWeight: '700', marginBottom: 3 },
  detail: { fontFamily: fonts.body, color: colors.ink2, fontSize: 12, lineHeight: 18 },
  cardActionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: 10,
  },
  cardActionText: { fontFamily: fonts.body, color: colors.paper, fontSize: 13, fontWeight: '700' },

  bottomBar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: colors.strokeSoft,
  },
  clearBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.paper2,
    borderWidth: 1.5,
    borderColor: colors.stroke,
  },
  clearBtnText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 13 },
  bottomBackBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.ink,
  },
  bottomBackText: { fontFamily: fonts.body, color: colors.paper, fontSize: 14, fontWeight: '700' },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 14, paddingHorizontal: 32, borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  primaryBtnText: { fontFamily: fonts.body, color: colors.paper, fontSize: 15, fontWeight: '700' },
});
