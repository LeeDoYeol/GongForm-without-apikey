import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { getStudyTimeMap, formatStudyTime } from '@/lib/studyTime';
import { colors, fonts, radius, screen, text as tk } from '@/lib/theme';

// 이번주(월~일) 날짜 키 7개 생성
function thisWeekKeys(): string[] {
  const out: string[] = [];
  const now = new Date();
  // 주의 시작 = 월요일 기준
  const day = now.getDay(); // 0=일 1=월 ... 6=토
  const offset = day === 0 ? -6 : 1 - day; // 일요일은 -6, 월요일은 0, 화 -1...
  const monday = new Date(now);
  monday.setDate(now.getDate() + offset);
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

// 평균: 0이 아닌 날 기준 (학습 안 한 날 제외)
function avgPerActiveDay(seconds: number[]): number {
  const active = seconds.filter((s) => s > 0);
  if (active.length === 0) return 0;
  return Math.round(active.reduce((a, b) => a + b, 0) / active.length);
}

export default function StatsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [studyTimeMap, setStudyTimeMap] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!user) return;
    let alive = true;
    getStudyTimeMap(user.uid)
      .then((m) => { if (alive) setStudyTimeMap(m); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [user]);

  const weekKeys = useMemo(() => thisWeekKeys(), []);
  const weekSecs = useMemo(() => weekKeys.map((k) => studyTimeMap[k] ?? 0), [weekKeys, studyTimeMap]);
  const total = useMemo(() => weekSecs.reduce((a, b) => a + b, 0), [weekSecs]);
  const avg = useMemo(() => avgPerActiveDay(weekSecs), [weekSecs]);
  const maxVal = useMemo(() => Math.max(60, ...weekSecs), [weekSecs]); // 최소 1분 단위 정규화

  const todayIdx = useMemo(() => {
    const d = new Date();
    const day = d.getDay(); // 0=일
    return day === 0 ? 6 : day - 1; // 월=0 ... 일=6
  }, []);

  const dayLabels = ['월', '화', '수', '목', '금', '토', '일'];

  return (
    <SafeAreaView style={screen.light}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
          style={styles.backBtn}
          hitSlop={8}
        >
          <Ionicons name="arrow-back" size={22} color={colors.ink} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>학습 시간</Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {/* 주간 카드 */}
          <View style={styles.weekCard}>
            <View style={styles.summaryRow}>
              <View style={{ flex: 1 }}>
                <Text style={[tk.meta, { color: colors.ink3 }]}>이번주</Text>
                <Text style={styles.summaryNum}>{formatStudyTime(total)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[tk.meta, { color: colors.ink3 }]}>평균/일</Text>
                <Text style={[styles.summaryNum, { color: colors.accentDeep }]}>
                  {avg > 0 ? formatStudyTime(avg) : '0초'}
                </Text>
              </View>
            </View>

            {/* 7일 막대 차트 */}
            <View style={styles.barsRow}>
              {weekSecs.map((v, i) => {
                const heightPct = maxVal > 0 ? (v / maxVal) * 100 : 0;
                const isToday = i === todayIdx;
                return (
                  <View key={i} style={styles.barCol}>
                    <View style={styles.barTrack}>
                      <View
                        style={[
                          styles.barFill,
                          {
                            height: `${heightPct}%`,
                            backgroundColor: isToday ? colors.accent : colors.ink3,
                          },
                        ]}
                      />
                    </View>
                    <Text style={[styles.dayLabel, isToday && { color: colors.accent, fontWeight: '700' }]}>
                      {dayLabels[i]}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>

          {/* 전체 통계 */}
          <View style={styles.totalCard}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>전체 누적 시간</Text>
              <Text style={styles.totalValue}>
                {formatStudyTime(Object.values(studyTimeMap).reduce((a, b) => a + b, 0))}
              </Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>학습한 날</Text>
              <Text style={styles.totalValue}>
                {Object.values(studyTimeMap).filter((s) => s > 0).length}일
              </Text>
            </View>
          </View>

          <Text style={styles.note}>
            ※ 플레이어를 보는 동안 자동으로 누적돼요. 홈의 학습일 카드를 탭하면 캘린더로 볼 수 있어요.
          </Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.strokeSoft,
    gap: 10,
  },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontFamily: fonts.body, fontSize: 17, color: colors.ink, textAlign: 'center' },

  scroll: { padding: 20, paddingBottom: 60 },

  // 주간 카드
  weekCard: {
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.stroke,
    borderRadius: radius.lg,
    padding: 18,
    marginBottom: 14,
  },
  summaryRow: { flexDirection: 'row', gap: 20, marginBottom: 18 },
  summaryNum: {
    fontFamily: fonts.display,
    fontSize: 30,
    color: colors.ink,
    lineHeight: 34,
    marginTop: 4,
  },

  // 막대 차트
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    height: 120,
    paddingVertical: 6,
  },
  barCol: { flex: 1, alignItems: 'center', height: '100%', justifyContent: 'flex-end', gap: 4 },
  barTrack: {
    width: '100%',
    flex: 1,
    backgroundColor: colors.paper2,
    borderRadius: 4,
    justifyContent: 'flex-end',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.strokeSoft,
  },
  barFill: { width: '100%', borderRadius: 4 },
  dayLabel: { fontFamily: fonts.mono, fontSize: 11, color: colors.ink3 },

  // 전체 통계 카드
  totalCard: {
    backgroundColor: colors.paper2,
    borderWidth: 1.5,
    borderColor: colors.strokeSoft,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: 16,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  totalLabel: { fontFamily: fonts.body, fontSize: 13, color: colors.ink2 },
  totalValue: { fontFamily: fonts.display, fontSize: 18, color: colors.accent },

  note: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.ink3,
    lineHeight: 16,
    marginTop: 6,
    paddingHorizontal: 4,
  },
});
