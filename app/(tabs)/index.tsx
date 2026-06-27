import { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { getStreakData, StreakData, getMotivationalMessage } from '@/lib/streak';
import { getLevelInfo, LevelInfo, subscribeXpEvents } from '@/lib/levelSystem';
import { getStudyTimeMap } from '@/lib/studyTime';
import { getDueReviews, WrongAnswer } from '@/lib/wrongAnswers';
import { loadReviewSession, saveReviewSession, ReviewSession } from '@/lib/reviewSession';
import StreakShareModal from '@/components/StreakShareModal';
import { CalendarView } from '@/components/home/CalendarView';
import { LevelDetailModal } from '@/components/home/LevelDetailModal';
import { colors, fonts, radius, text as t, screen } from '@/lib/theme';
import { Box, ImgSlot, Avatar } from '@/components/wf';
import { fetchBackgroundMedia } from '@/lib/imageSearch';
import { getHomeCache } from '@/lib/homePrefetch';

interface RecentProject { id: string; title: string }
interface RecShortform {
  id: string;
  projectId: string;
  title: string;
  type: 'concept' | 'example' | 'quiz';
  script?: string;
  imageKeywords?: string[];
}

function formatDateHeader(d: Date): string {
  const wkd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${wkd}요일 · ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();

  const [projectCount, setProjectCount] = useState(0);
  const [shortformCount, setShortformCount] = useState(0);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  // prefetch 캐시가 있으면 첫 렌더부터 즉시 표시 (네트워크 대기 0)
  const initialCache = user ? getHomeCache(user.uid) : null;
  const [randomShorts, setRandomShorts] = useState<RecShortform[]>(initialCache?.picks ?? []);
  const [recImages, setRecImages] = useState<Record<string, string>>(initialCache?.imageMap ?? {});
  const [streak, setStreak] = useState<StreakData | null>(null);
  const [levelInfo, setLevelInfo] = useState<LevelInfo | null>(null);
  const [studyTimeMap, setStudyTimeMap] = useState<Record<string, number>>({});
  const [dueReviews, setDueReviews] = useState<WrongAnswer[]>([]);
  const [reviewSession, setReviewSession] = useState<ReviewSession | null>(null);
  const [loading, setLoading] = useState(true);

  const [shareVisible, setShareVisible] = useState(false);
  const [calendarVisible, setCalendarVisible] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [levelDetailOpen, setLevelDetailOpen] = useState(false);

  useEffect(() => {
    const unsub = subscribeXpEvents((e) => {
      if (e.result.awarded > 0) setLevelInfo(e.result.info);
    });
    return unsub;
  }, []);

  const loadData = useCallback(async () => {
    if (!user) return;
    try {
      const [pSnap, sSnap, streakData, timeMap, due] = await Promise.all([
        getDocs(query(collection(db, 'projects'), where('userId', '==', user.uid))),
        getDocs(query(collection(db, 'shortforms'), where('userId', '==', user.uid))),
        getStreakData(user.uid),
        getStudyTimeMap(user.uid),
        getDueReviews(user.uid),
      ]);
      setProjectCount(pSnap.size);
      setShortformCount(sSnap.size);
      setRecentProjects(
        pSnap.docs
          .map((d) => ({ id: d.id, title: d.data().title, createdAt: d.data().createdAt }))
          .sort((a: any, b: any) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0))
          .slice(0, 3)
          .map(({ id, title }) => ({ id, title }))
      );
      // 다시 보기: prefetch 캐시가 있으면 그대로 사용 (즉시 표시 보장).
      // 캐시 없으면 새로 4개 랜덤 픽 + 이미지 fetch.
      const cached = getHomeCache(user.uid);
      if (cached && cached.picks.length > 0) {
        setRandomShorts(cached.picks);
        setRecImages(cached.imageMap);
      } else {
        const picked = pickRandom(
          sSnap.docs.map((d) => {
            const data = d.data() as any;
            return {
              id: d.id,
              projectId: data.projectId as string,
              title: data.content?.title ?? '제목 없음',
              type: (data.type as 'concept' | 'example' | 'quiz') ?? 'concept',
              script: data.content?.script as string | undefined,
              imageKeywords:
                (data.imageKeywords as string[] | undefined) ??
                (data.imageKeyword ? [data.imageKeyword as string] : undefined),
            };
          }),
          4,
        );
        setRandomShorts(picked);
        picked.forEach((sf) => {
          fetchBackgroundMedia(sf.id, sf.title, sf.type, sf.script, sf.imageKeywords)
            .then((urls) => {
              if (urls.length > 0) {
                setRecImages((prev) => ({ ...prev, [sf.id]: urls[0] }));
              }
            })
            .catch(() => {});
        });
      }
      setStreak(streakData);
      setStudyTimeMap(timeMap);
      setDueReviews(due);
      getLevelInfo(user.uid).then(setLevelInfo).catch(() => {});
      const session = await loadReviewSession();
      setReviewSession(session);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  // 복습 진입: 3 스탯 가운데 카드(숏폼+복습뱃지) 탭에서 사용.
  const handleStartStudy = useCallback(async () => {
    let pendingShortformIds: string[] = [];
    let pendingReviewIds: string[] = [];
    let pendingProjectIds: string[] = [];

    if (reviewSession && reviewSession.shortformIds.length > 0) {
      pendingShortformIds = reviewSession.shortformIds;
      pendingReviewIds = reviewSession.reviewDocIds;
      pendingProjectIds = reviewSession.projectIds;
    } else {
      const now = Date.now();
      const pending = dueReviews.filter((d) => {
        const nextIso = d.nextReviewAt;
        if (!nextIso) return true;
        return new Date(nextIso).getTime() <= now;
      });
      pendingShortformIds = pending.map((d) => d.shortformId);
      pendingReviewIds = pending.map((d) => d.id);
      pendingProjectIds = pending.map((d) => d.projectId);
      if (pendingShortformIds.length > 0) {
        await saveReviewSession({
          shortformIds: pendingShortformIds,
          reviewDocIds: pendingReviewIds,
          projectIds: pendingProjectIds,
        });
      }
    }

    if (pendingShortformIds.length > 0) {
      router.push({
        pathname: '/player/[id]',
        params: {
          id: pendingProjectIds[0] || 'review',
          shortformId: pendingShortformIds[0],
          ids: pendingShortformIds.join(','),
          reviewIds: pendingReviewIds.join(','),
        },
      });
    } else if (shortformCount > 0) {
      router.push({ pathname: '/player/[id]', params: { id: '__all__', startIndex: 0, shuffle: '1' } });
    }
  }, [reviewSession, dueReviews, shortformCount, router]);

  const pendingReviewCount = (() => {
    if (reviewSession && reviewSession.shortformIds.length > 0) return reviewSession.shortformIds.length;
    const now = Date.now();
    return dueReviews.filter((d) => {
      const nextIso = d.nextReviewAt;
      if (!nextIso) return true;
      return new Date(nextIso).getTime() <= now;
    }).length;
  })();

  const greetingName = user?.displayName?.trim() || (user?.email?.split('@')[0] ?? '');
  const userInitial = greetingName ? greetingName.charAt(0) : '나';

  return (
    <SafeAreaView style={screen.light}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* 헤더 */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.logo}>공폼</Text>
            <Text style={styles.dateMeta}>{formatDateHeader(new Date())}</Text>
            <Text style={styles.greeting}>
              {greetingName ? `안녕, ${greetingName} 👋` : '안녕하세요 👋'}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.headerIcon}
              onPress={() => router.push('/search')}
              hitSlop={8}
            >
              <Ionicons name="search" size={18} color={colors.ink} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.headerIcon}
              onPress={() => router.push('/stats' as any)}
              hitSlop={8}
            >
              <Ionicons name="bar-chart-outline" size={18} color={colors.ink} />
            </TouchableOpacity>
            <Avatar initials={userInitial} size={40} />
          </View>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* 스트릭 칩 */}
            {streak && (
              <TouchableOpacity
                activeOpacity={0.85}
                style={styles.streakStrip}
                onPress={() => setShareVisible(true)}
              >
                <Text style={styles.streakEmoji}>🔥</Text>
                <Text style={styles.streakDays}>{streak.currentStreak}일</Text>
                <Text style={styles.streakLabel}>연속 학습</Text>
                <Text style={styles.streakMessage} numberOfLines={1}>
                  {getMotivationalMessage(streak.currentStreak)}
                </Text>
                <Ionicons name="share-social-outline" size={14} color={colors.ink3} />
              </TouchableOpacity>
            )}

            {/* 레벨 카드 */}
            {levelInfo && (
              <TouchableOpacity
                activeOpacity={0.85}
                style={styles.levelCard}
                onPress={() => setLevelDetailOpen(true)}
              >
                <View style={styles.levelIconBox}>
                  <Ionicons name="trophy-outline" size={24} color={colors.accentYellow} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.levelTopRow}>
                    <Text style={styles.levelText}>Lv. {levelInfo.level}</Text>
                    <Text style={styles.levelXp}>
                      {levelInfo.xpInCurrentLevel.toLocaleString()} / {levelInfo.xpNeededForNext.toLocaleString()} XP
                    </Text>
                  </View>
                  <View style={styles.levelBarBg}>
                    <View
                      style={[
                        styles.levelBarFill,
                        { width: `${Math.min(100, Math.max(0, levelInfo.progress * 100))}%` },
                      ]}
                    />
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.ink3} />
              </TouchableOpacity>
            )}

            {/* 3 스탯 카드: 카드별 색조 (파랑/초록/주황) */}
            <View style={styles.statsRow}>
              <StatCard
                icon="layers-outline"
                num={projectCount}
                label="프로젝트"
                tint="blue"
                onPress={() => router.push('/(tabs)/folders')}
              />
              <StatCard
                icon={pendingReviewCount > 0 ? 'refresh-circle-outline' : 'play-circle-outline'}
                num={shortformCount}
                label="숏폼"
                tint="green"
                badge={pendingReviewCount > 0 ? `복습 ${pendingReviewCount}` : undefined}
                onPress={handleStartStudy}
              />
              <StatCard
                icon="calendar-outline"
                num={streak?.totalStudyDays ?? 0}
                label="학습일"
                tint="orange"
                onPress={() => setCalendarVisible(true)}
              />
            </View>

            {/* 최근 프로젝트 */}
            {recentProjects.length > 0 && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>최근 프로젝트</Text>
                  <TouchableOpacity onPress={() => router.push('/(tabs)/folders')} hitSlop={8}>
                    <Text style={styles.sectionMore}>전체 →</Text>
                  </TouchableOpacity>
                </View>
                <View style={{ gap: 8 }}>
                  {recentProjects.map((p) => (
                    <View key={p.id} style={styles.recentRow}>
                      <TouchableOpacity
                        style={styles.recentLeft}
                        onPress={() =>
                          router.push({ pathname: '/player/[id]', params: { id: p.id, startIndex: 0, shuffle: '1' } })
                        }
                        activeOpacity={0.7}
                      >
                        <View style={styles.recentPlayBtn}>
                          <Ionicons name="play" size={14} color={colors.paper} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.recentTitle} numberOfLines={1}>{p.title}</Text>
                          <Text style={styles.recentMeta}>탭하여 셔플 재생</Text>
                        </View>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.recentDetail}
                        onPress={() => router.push({ pathname: '/project/[id]', params: { id: p.id } })}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.recentDetailGlyph}>›</Text>
                        <Text style={styles.recentDetailText}>상세</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* 다시 보기: 보유 숏폼 중 랜덤 4개. 탭하면 해당 숏폼으로 진입. */}
            {shortformCount > 0 && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>다시 보기</Text>
                  <Text style={[t.meta, { color: colors.ink3 }]}>랜덤 {randomShorts.length}개</Text>
                </View>
                <View style={styles.recGrid}>
                  {randomShorts.map((target) => {
                    const typeMeta = target.type === 'concept'
                      ? { label: '개념', color: colors.accent }
                      : target.type === 'example'
                      ? { label: '예시', color: colors.accentGreen }
                      : { label: '퀴즈', color: colors.accentOrange };
                    return (
                      <TouchableOpacity
                        key={target.id}
                        style={styles.recCell}
                        onPress={() => {
                          router.push({
                            pathname: '/player/[id]',
                            params: { id: target.projectId, shortformId: target.id },
                          });
                        }}
                        activeOpacity={0.7}
                      >
                        {recImages[target.id] ? (
                          <Image
                            source={{ uri: recImages[target.id] }}
                            style={styles.recCellImage}
                            resizeMode="cover"
                          />
                        ) : (
                          <ImgSlot label={target.title} h={120} dashed style={{ marginBottom: 6 }} />
                        )}
                        <View style={styles.recCellMetaRow}>
                          <View style={[styles.recTypeChip, { backgroundColor: typeMeta.color }]}>
                            <Text style={styles.recTypeChipText}>{typeMeta.label}</Text>
                          </View>
                          <Text style={styles.recCellTitle} numberOfLines={1}>
                            {target.title}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}
          </>
        )}
      </ScrollView>

      <LevelDetailModal
        visible={levelDetailOpen}
        onClose={() => setLevelDetailOpen(false)}
        levelInfo={levelInfo}
      />

      <Modal visible={calendarVisible} transparent animationType="fade">
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setCalendarVisible(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.calSheet}>
            <CalendarView
              studyDates={streak?.studyDates ?? []}
              studyTimeMap={studyTimeMap}
              month={calendarMonth}
              userId={user?.uid ?? null}
              onPrev={() => setCalendarMonth(d => { const n = new Date(d); n.setMonth(n.getMonth() - 1); return n; })}
              onNext={() => setCalendarMonth(d => { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; })}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {streak && (
        <StreakShareModal
          visible={shareVisible}
          onClose={() => setShareVisible(false)}
          streak={streak}
          email={user?.email ?? undefined}
        />
      )}
    </SafeAreaView>
  );
}

type StatTint = 'blue' | 'green' | 'orange';

function StatCard({
  icon, num, label, tint, badge, onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  num: number;
  label: string;
  tint: StatTint;
  badge?: string;
  onPress: () => void;
}) {
  // 색조별 톤: 보더 + 옅은 배경 + 아이콘/숫자 강조색
  // 보더는 카테고리 식별성 위해 한 단계 더 vivid (채도/명도 살짝 up). 배경/아이콘은 기존 톤 유지.
  const palette =
    tint === 'green'
      ? { border: '#4FB54F', bg: colors.accentGreenSoft, fg: colors.accentGreen, num: colors.accentGreenDeep }
      : tint === 'orange'
      ? { border: '#DA6E1E', bg: colors.accentOrangeSoft, fg: colors.accentOrange, num: colors.accentOrangeDeep }
      : { border: '#3A7CF6', bg: colors.accentSoft, fg: colors.accent, num: colors.accentDeep };
  return (
    <TouchableOpacity
      style={[styles.statCard, { borderColor: palette.border, backgroundColor: palette.bg }]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <Ionicons name={icon} size={28} color={palette.fg} />
      <Text style={[styles.statNum, { color: palette.num }]}>{Number.isFinite(num) ? num : 0}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {badge && (
        <View style={[styles.statBadge, { backgroundColor: palette.border }]}>
          <Text style={styles.statBadgeText}>{badge}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 },

  // 헤더
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 18,
    paddingTop: 8,
  },
  logo: { fontFamily: fonts.display, fontSize: 32, color: colors.accent, lineHeight: 36 },
  dateMeta: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.ink3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 6,
  },
  greeting: { fontFamily: fonts.display, fontSize: 24, color: colors.ink, lineHeight: 30, marginTop: 2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  headerIcon: {
    width: 40, height: 40, borderRadius: 20,
    borderWidth: 1.5, borderColor: colors.stroke,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'transparent',
  },

  // 스트릭 칩
  streakStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    // accent 계열을 살짝 데사처(채도 낮춤), 너무 시퍼렇지 않도록 톤 다운
    borderColor: '#5C82C7',
    backgroundColor: '#232A38',
    borderRadius: radius.lg,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  streakEmoji: { fontSize: 16 },
  streakDays: { fontFamily: fonts.display, fontSize: 18, color: '#9DB6DC' },
  streakLabel: { fontFamily: fonts.body, fontSize: 12, color: colors.ink2, marginLeft: 2 },
  streakMessage: { flex: 1, fontFamily: fonts.body, fontSize: 11, color: colors.ink3, textAlign: 'right' },

  // 레벨 카드
  levelCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1.5,
    borderColor: colors.stroke,
    backgroundColor: colors.paper2,
    borderRadius: radius.lg,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  levelIconBox: {
    width: 44, height: 44, borderRadius: 14,
    borderWidth: 1.5, borderColor: colors.stroke,
    backgroundColor: colors.paper,
    alignItems: 'center', justifyContent: 'center',
  },
  levelTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
  levelText: { fontFamily: fonts.display, fontSize: 22, color: colors.accentYellow },
  levelXp: { fontFamily: fonts.mono, fontSize: 11, color: colors.ink3 },
  levelBarBg: { height: 8, backgroundColor: colors.ink4, borderRadius: 4, overflow: 'hidden' },
  levelBarFill: { height: '100%', backgroundColor: colors.accentYellow, borderRadius: 4 },

  // 3 스탯
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  statCard: {
    flex: 1,
    borderWidth: 2.1,
    borderColor: colors.stroke,
    backgroundColor: 'transparent',
    borderRadius: radius.lg,
    paddingVertical: 16,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 6,
    position: 'relative',
    minHeight: 110,
  },
  statNum: { fontFamily: fonts.display, fontSize: 28, color: colors.ink, lineHeight: 30 },
  statLabel: { fontFamily: fonts.body, fontSize: 13, color: colors.ink2 },
  statBadge: {
    position: 'absolute', top: 6, right: 6,
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: radius.pill,
  },
  statBadgeText: { fontFamily: fonts.mono, fontSize: 10, color: colors.paper, fontWeight: '700' },

  // 섹션
  section: { marginBottom: 16 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  sectionTitle: { fontFamily: fonts.body, fontSize: 18, color: colors.ink },
  sectionMore: { fontFamily: fonts.body, fontSize: 13, color: colors.accent },

  // 최근 프로젝트
  recentRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderWidth: 1.5,
    borderColor: colors.stroke,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  recentLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  recentPlayBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  recentTitle: { fontFamily: fonts.body, fontSize: 14, color: colors.ink },
  recentMeta: { fontFamily: fonts.mono, fontSize: 10, color: colors.ink3, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  recentDetail: {
    width: 52,
    backgroundColor: colors.paper2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderLeftWidth: 1,
    borderLeftColor: colors.strokeSoft,
    borderStyle: 'dashed',
  },
  recentDetailGlyph: { fontFamily: fonts.display, fontSize: 20, color: colors.ink2 },
  recentDetailText: { fontFamily: fonts.mono, fontSize: 9, color: colors.ink3 },

  // 추천 그리드
  recGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  recCell: { width: '47%' },
  recCellImage: {
    width: '100%',
    height: 120,
    borderRadius: radius.md,
    marginBottom: 6,
    backgroundColor: colors.paper2,
  },
  recCellMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recCellTitle: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.ink, lineHeight: 16 },
  recTypeChip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  recTypeChipText: { fontFamily: fonts.body, fontSize: 10, color: colors.paper, fontWeight: '700' },

  // 캘린더 시트 (모달 overlay)
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(21,23,28,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  calSheet: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.stroke,
    borderRadius: radius.lg,
    padding: 20,
  },
});
