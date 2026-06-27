// 우측 상단 부유 배너: 백그라운드 생성 작업들의 진행/완료/오류를 어디서든 표시.
// 여러 작업이 동시에 돌 수 있으므로 stack 형태로 위→아래 배치.
// _layout.tsx에서 한 번 렌더 → 라우팅과 무관하게 화면 위에 떠 있음.
import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { subscribe, getJobs, dismissJob, GenerationJob } from '@/lib/generationManager';
import { colors, fonts, radius } from '@/lib/theme';

const MAX_VISIBLE = 3;

export function GenerationStatusBanner() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [jobs, setJobs] = useState<GenerationJob[]>(getJobs());

  useEffect(() => {
    const unsub = subscribe(setJobs);
    return unsub;
  }, []);

  if (jobs.length === 0) return null;

  // 너무 많이 쌓이면 위 MAX_VISIBLE개만 표시, 나머지는 요약 카드로
  const visible = jobs.slice(0, MAX_VISIBLE);
  const hiddenCount = jobs.length - visible.length;

  // 우하단 배치: 탭바·자료 추가 버튼 등 상단 컨트롤을 가리지 않도록.
  // 여러 작업은 아래에서 위로 쌓이도록 flexDirection: 'column-reverse'.
  const bottomOffset = Math.max(16, insets.bottom + 72); // 탭바 높이 고려
  const wrapStyle =
    Platform.OS === 'web'
      ? ({ position: 'fixed', bottom: bottomOffset, right: 12, zIndex: 9999, gap: 8, flexDirection: 'column-reverse', alignItems: 'flex-end' } as any)
      : { position: 'absolute' as const, bottom: bottomOffset, right: 12, zIndex: 9999, elevation: 30, gap: 8, flexDirection: 'column-reverse' as const, alignItems: 'flex-end' as const };

  return (
    <View pointerEvents="box-none" style={wrapStyle}>
      {visible.map((job) => (
        <BannerCard key={job.id} job={job} onOpen={() => router.push('/generation')} />
      ))}
      {hiddenCount > 0 && (
        <TouchableOpacity
          style={styles.moreBanner}
          activeOpacity={0.85}
          onPress={() => router.push('/generation')}
        >
          <Ionicons name="layers-outline" size={16} color={colors.ink2} />
          <Text style={styles.moreText}>+{hiddenCount}개 더 보기</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function BannerCard({ job, onOpen }: { job: GenerationJob; onOpen: () => void }) {
  const isRunning = job.status === 'running';
  const isError = job.status === 'error';
  const isDone = job.status === 'done';
  const accent = isRunning ? colors.accent : isDone ? colors.good : colors.bad;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      style={[styles.banner, { borderColor: accent }]}
      onPress={onOpen}
    >
      <View style={styles.iconCol}>
        {isRunning ? (
          <ActivityIndicator size="small" color={accent} />
        ) : isDone ? (
          <Ionicons name="checkmark-circle-outline" size={22} color={accent} />
        ) : (
          <Ionicons name="alert-circle-outline" size={22} color={accent} />
        )}
      </View>
      <View style={styles.textCol}>
        <Text style={[styles.title, { color: accent }]} numberOfLines={1}>
          {job.label}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {isError
            ? `❌ ${job.errorMessage ?? '알 수 없는 오류'}`
            : isDone
            ? `✅ ${job.projectTitle} · ${job.generatedCount}개 추가`
            : `${job.projectTitle} · ${job.progress.msg.replace(/^[^A-Za-z가-힣]+/, '')}`}
        </Text>
      </View>
      <TouchableOpacity
        onPress={(e) => { (e as any).stopPropagation?.(); dismissJob(job.id); }}
        hitSlop={10}
        style={styles.closeBtn}
      >
        <Ionicons name="close" size={16} color={colors.ink3} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.paper2,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    minWidth: 220,
    maxWidth: 320,
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '0 4px 12px rgba(0,0,0,0.5)' } as any)
      : { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 12, elevation: 6 }),
  },
  iconCol: { width: 22, alignItems: 'center', justifyContent: 'center' },
  textCol: { flex: 1, gap: 2 },
  title: { fontFamily: fonts.body, fontSize: 13, fontWeight: '700' },
  subtitle: { fontFamily: fonts.body, color: colors.ink2, fontSize: 11 },
  closeBtn: { padding: 2 },

  moreBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.paper2,
    borderWidth: 1,
    borderColor: colors.stroke,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minWidth: 220,
    maxWidth: 320,
  },
  moreText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 12, fontWeight: '700' },
});
