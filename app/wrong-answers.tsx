import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp } from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { getWrongAnswers, getDueReviews, deleteWrongAnswer, markAsGenerated, WrongAnswer, deleteWrongAnswersByShortformIds } from '@/lib/wrongAnswers';
import { getStudyNotes, saveStudyNote, deleteStudyNotesByShortformIds } from '@/lib/studyNotes';
import { generateSimilarOXQuizzes } from '@/lib/gemini';
import { matchesKoreanQuery } from '@/lib/koreanSearch';
import { colors } from '@/lib/theme';

interface SimilarItem {
  id: string;
  title: string;
  script: string;
  projectId: string | null;
}

// 로컬(=한국) 자정 기준 YYYY-MM-DD.
function localDayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "오늘 틀림", "3일 전 틀림" 등, wrongAt 또는 lastWrongAt 기준
function wrongAgoLabel(iso: string): string {
  const todayKey = localDayKey();
  const thatKey = localDayKey(new Date(iso));
  if (thatKey === todayKey) return '오늘 틀림';
  const a = new Date(todayKey + 'T00:00:00').getTime();
  const b = new Date(thatKey + 'T00:00:00').getTime();
  const days = Math.max(1, Math.round((a - b) / 86400000));
  return `${days}일 전 틀림`;
}

// "오늘 복습", "3일 후 복습", "복습 예정 지남" 등, nextReviewAt 기준
function nextReviewLabel(iso: string): string {
  const todayKey = localDayKey();
  const thatKey = localDayKey(new Date(iso));
  if (thatKey === todayKey) return '오늘 복습';
  const a = new Date(todayKey + 'T00:00:00').getTime();
  const b = new Date(thatKey + 'T00:00:00').getTime();
  const days = Math.round((b - a) / 86400000);
  if (days < 0) return `${-days}일 지남`;
  return `${days}일 후 복습`;
}

export default function WrongAnswersScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<WrongAnswer[]>([]);
  const [dueReviews, setDueReviews] = useState<WrongAnswer[]>([]);
  const [similarItems, setSimilarItems] = useState<SimilarItem[]>([]);
  const [folderTitleMap, setFolderTitleMap] = useState<Record<string, string>>({});
  const [projectTitleMap, setProjectTitleMap] = useState<Record<string, string>>({});
  const [savedNoteIds, setSavedNoteIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [deleteModal, setDeleteModal] = useState<
    | { kind: 'wrong'; item: WrongAnswer }
    | { kind: 'similar'; item: SimilarItem }
    | null
  >(null);
  const [searchQ, setSearchQ] = useState('');

  const filteredItems = useMemo(() => {
    const q = searchQ.trim();
    if (!q) return items;
    return items.filter((it) => matchesKoreanQuery(it.title ?? '', q) || matchesKoreanQuery(it.script ?? '', q));
  }, [items, searchQ]);
  const filteredSimilarItems = useMemo(() => {
    const q = searchQ.trim();
    if (!q) return similarItems;
    return similarItems.filter((it) => matchesKoreanQuery(it.title ?? '', q) || matchesKoreanQuery(it.script ?? '', q));
  }, [similarItems, searchQ]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [wrongData, similarSnap, due, folderSnap, projectSnap, notes] = await Promise.all([
      getWrongAnswers(user.uid),
      getDocs(query(
        collection(db, 'shortforms'),
        where('userId', '==', user.uid),
        where('isGeneratedSimilar', '==', true)
      )),
      getDueReviews(user.uid),
      getDocs(query(collection(db, 'folders'), where('userId', '==', user.uid))),
      getDocs(query(collection(db, 'projects'), where('userId', '==', user.uid))),
      getStudyNotes(user.uid),
    ]);
    setSavedNoteIds(new Set(notes.map((n) => n.shortformId)));

    const fMap: Record<string, string> = {};
    folderSnap.docs.forEach((d) => { fMap[d.id] = (d.data() as any).title ?? ''; });
    setFolderTitleMap(fMap);
    const pMap: Record<string, string> = {};
    projectSnap.docs.forEach((d) => { pMap[d.id] = (d.data() as any).title ?? ''; });
    setProjectTitleMap(pMap);

    // 이미 wrongAnswers에 등록된 shortformId는 유사 문제 목록에서 제외 (틀린 문제 섹션으로 이동됨)
    const wrongShortformIds = new Set(wrongData.map((w) => w.shortformId));
    const similar: SimilarItem[] = similarSnap.docs
      .filter((d) => !wrongShortformIds.has(d.id))
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          title: data.content?.title ?? '',
          script: data.content?.script ?? '',
          projectId: data.projectId ?? null,
        };
      });

    setItems(wrongData);
    setSimilarItems(similar);
    setDueReviews(due);
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const handleOpen = (projectId: string | null, shortformId: string) => {
    if (!projectId) {
      Alert.alert('알림', '이 문제는 프로젝트가 없어 열 수 없습니다.');
      return;
    }
    // 오답 리스트 표시 순서대로 ids를 넘겨서 플레이어가 그 순서대로 재생하도록 함
    const ids = items.map((i) => i.shortformId).join(',');
    router.push({
      pathname: '/player/[id]',
      params: { id: projectId, shortformId, ids },
    });
  };

  const confirmDelete = async () => {
    if (!deleteModal) return;
    if (deleteModal.kind === 'wrong') {
      const { item } = deleteModal;
      setDeleteModal(null);
      await deleteWrongAnswer(item.id);
      await deleteDoc(doc(db, 'shortforms', item.shortformId));
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } else {
      const { item } = deleteModal;
      setDeleteModal(null);
      await deleteDoc(doc(db, 'shortforms', item.id));
      await deleteWrongAnswersByShortformIds([item.id]);
      setSimilarItems((prev) => prev.filter((i) => i.id !== item.id));
    }
  };

  const handleGenerate = async () => {
    if (!user) return;
    // 아직 유사 문제가 생성되지 않은 항목만, 최신순으로
    const pending = items
      .filter((i) => !i.hasSimilarGenerated)
      .sort((a, b) => b.wrongAt.localeCompare(a.wrongAt));
    if (pending.length === 0) {
      Alert.alert('알림', '새로 생성할 오답이 없습니다.\n문제를 더 풀고 오답이 생기면 다시 시도해보세요.');
      return;
    }

    setGenerating(true);
    try {
      // 프로젝트별로 그룹화
      const groups = new Map<string, { projectId: string; folderId: string | null; items: WrongAnswer[] }>();
      for (const item of pending) {
        if (!item.projectId) continue;
        const key = item.projectId;
        if (!groups.has(key)) {
          groups.set(key, { projectId: item.projectId, folderId: item.folderId ?? null, items: [] });
        }
        groups.get(key)!.items.push(item);
      }

      let totalSaved = 0;
      const generatedIds: string[] = [];

      for (const group of groups.values()) {
        const scripts = group.items.map((i) => i.script);
        const generated = await generateSimilarOXQuizzes(scripts);
        if (generated.length === 0) continue;

        // 해당 프로젝트의 현재 최대 order 값 조회
        const existingSnap = await getDocs(
          query(collection(db, 'shortforms'), where('projectId', '==', group.projectId))
        );
        const maxOrder = existingSnap.docs.reduce((max, d) => Math.max(max, (d.data().order ?? 0)), -1);

        for (let i = 0; i < generated.length; i++) {
          await addDoc(collection(db, 'shortforms'), {
            projectId: group.projectId,
            folderId: group.folderId,
            userId: user.uid,
            type: generated[i].type,
            content: { title: generated[i].title, script: generated[i].script },
            imageKeywords: generated[i].imageKeywords ?? [],
            importance: generated[i].importance ?? 5,
            order: maxOrder + 1 + i,
            isGeneratedSimilar: true,
            createdAt: serverTimestamp(),
          });
        }
        totalSaved += generated.length;
        group.items.forEach((i) => generatedIds.push(i.id));
      }

      if (totalSaved === 0) {
        Alert.alert('알림', '유사 문제를 생성하지 못했습니다.');
        return;
      }

      await markAsGenerated(generatedIds);
      await load();

      Alert.alert('완료', `${totalSaved}개의 유사 문제가 원본 프로젝트에 추가됐습니다.`);
    } catch (e: any) {
      Alert.alert('오류', e?.message ?? '유사 문제 생성에 실패했습니다.');
    } finally {
      setGenerating(false);
    }
  };

  // 정리 노트로 보내기/빼기 토글: 오답 항목을 별도 컬렉션에 복사 저장. 이미 저장돼 있으면 제거.
  const toggleSaveNote = useCallback(async (item: WrongAnswer) => {
    if (!user) return;
    const sfId = item.shortformId;
    if (savedNoteIds.has(sfId)) {
      setSavedNoteIds((prev) => { const next = new Set(prev); next.delete(sfId); return next; });
      deleteStudyNotesByShortformIds([sfId]).catch(() => {});
    } else {
      setSavedNoteIds((prev) => new Set([...prev, sfId]));
      // 오답은 거의 quiz 타입, type 'quiz' 명시
      saveStudyNote(
        user.uid,
        sfId,
        item.projectId ?? '',
        item.title ?? '',
        item.script ?? '',
        item.folderId ?? null,
        'quiz',
      ).catch(() => {});
    }
  }, [user, savedNoteIds]);

  // 실제로 오늘 복습 큐에 들어있는 항목 id 집합: 칩과 상단 배너가 같은 기준을 쓰도록.
  // nextReviewAt 달력 날짜만 보면 같은 날 미래 시각도 "오늘 복습"으로 보였지만, 실제 due 판정은
  // nextReviewAt <= now (또는 오늘 이미 복습) 이므로 둘이 어긋났다.
  const dueIds = useMemo(() => new Set(dueReviews.map((d) => d.id)), [dueReviews]);

  const renderItem = ({ item }: { item: WrongAnswer }) => {
    const folderTitle = item.folderId ? folderTitleMap[item.folderId] : '';
    const projectTitle = item.projectId ? projectTitleMap[item.projectId] : '';
    const pathLabel = [folderTitle, projectTitle].filter(Boolean).join(' › ');
    const isNoteSaved = savedNoteIds.has(item.shortformId);
    const isDueToday = dueIds.has(item.id);
    // 오늘 복습 칩: 실제 due 항목에만. 그 외엔 미래/과거 라벨만 보여줌.
    const reviewLabel: string | null = isDueToday
      ? '오늘 복습'
      : (item.nextReviewAt && localDayKey(new Date(item.nextReviewAt)) !== localDayKey()
        ? nextReviewLabel(item.nextReviewAt)
        : null);
    return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => handleOpen(item.projectId ?? null, item.shortformId)}
      style={[styles.card, item.hasSimilarGenerated && styles.cardGenerated]}
    >
      <View style={styles.cardTop}>
        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Ionicons name="help-circle-outline" size={12} color="#F97316" />
            <Text style={styles.badgeText}>OX 퀴즈</Text>
          </View>
          {item.hasSimilarGenerated && (
            <View style={styles.generatedTag}>
              <Ionicons name="checkmark" size={10} color="#22C55E" />
              <Text style={styles.generatedTagText}>유사 문제 생성됨</Text>
            </View>
          )}
        </View>
        <View style={styles.cardRightRow}>
          <View style={styles.cardDateChip}>
            <Ionicons name="close-circle" size={11} color="#EF4444" />
            <Text style={[styles.cardDateText, { color: '#EF4444' }]}>{wrongAgoLabel(item.lastWrongAt ?? item.wrongAt)}</Text>
          </View>
          {/* "오늘 복습" 칩은 실제 due 항목만(상단 배너와 일치). 그 외엔 미래/과거 라벨만 노출. */}
          {reviewLabel && (
            <View style={styles.cardDateChip}>
              <Ionicons name="time-outline" size={11} color="#22C55E" />
              <Text style={[styles.cardDateText, { color: '#22C55E' }]}>{reviewLabel}</Text>
            </View>
          )}
          <TouchableOpacity
            onPress={() => toggleSaveNote(item)}
            style={{ padding: 4 }}
            hitSlop={6}
          >
            <Ionicons
              name={isNoteSaved ? 'bookmark' : 'bookmark-outline'}
              size={18}
              color={isNoteSaved ? colors.note : '#666'}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setDeleteModal({ kind: 'wrong', item })}
            style={{ padding: 4 }}
          >
            <Ionicons name="trash-outline" size={18} color="#444" />
          </TouchableOpacity>
        </View>
      </View>
      {pathLabel.length > 0 && (
        <View style={styles.pathRow}>
          <Ionicons name="folder-outline" size={11} color="#666" />
          <Text style={styles.pathText} numberOfLines={1}>{pathLabel}</Text>
        </View>
      )}
      <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
      <Text style={styles.cardScript} numberOfLines={2}>{item.script}</Text>
    </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/folders')}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>오답노트</Text>
          <Text style={styles.headerSub}>틀린 OX 퀴즈 모음</Text>
        </View>
        <View style={{ width: 44 }} />
      </View>

      {loading ? (
        <ActivityIndicator color="#F97316" style={{ marginTop: 40 }} />
      ) : items.length === 0 && similarItems.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="checkmark-circle" size={64} color="#333" />
          <Text style={styles.emptyTitle}>오답이 없습니다!</Text>
          <Text style={styles.emptySub}>OX 퀴즈를 풀다 보면 틀린 문제가 여기에 저장돼요</Text>
        </View>
      ) : (
        <>
          {/* 오늘 복습할 오답 (간격 반복) */}
          {dueReviews.length > 0 && (
            <TouchableOpacity
              style={styles.reviewBanner}
              activeOpacity={0.85}
              onPress={() => {
                const first = dueReviews[0];
                const ids = dueReviews.map((d) => d.shortformId).join(',');
                const reviewIds = dueReviews.map((d) => d.id).join(',');
                router.push({
                  pathname: '/player/[id]',
                  params: {
                    id: first.projectId || 'review',
                    shortformId: first.shortformId,
                    ids,
                    reviewIds,
                  },
                });
              }}
            >
              <View style={styles.reviewIconBox}>
                <Ionicons name="refresh-circle" size={28} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.reviewTitle}>오늘 복습할 오답 {dueReviews.length}개</Text>
                <Text style={styles.reviewSub}>탭해서 간격 반복 학습 시작</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color="#fff" />
            </TouchableOpacity>
          )}

          <View style={styles.searchRow}>
            <View style={styles.searchBox}>
              <Ionicons name="search" size={15} color="#666" />
              <TextInput
                style={styles.searchInput}
                value={searchQ}
                onChangeText={setSearchQ}
                placeholder="제목·내용 검색"
                placeholderTextColor="#555"
                returnKeyType="search"
              />
              {searchQ.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQ('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={16} color="#555" />
                </TouchableOpacity>
              )}
            </View>
          </View>

          <View style={styles.statsRow}>
            <View>
              <Text style={styles.statsText}>
                {searchQ.trim().length > 0
                  ? `검색 결과 ${filteredItems.length}개 / 전체 ${items.length}개`
                  : `틀린 문제 ${items.length}개`}
              </Text>
              {items.some((i) => !i.hasSimilarGenerated) && (
                <Text style={styles.statsPending}>
                  미생성 {items.filter((i) => !i.hasSimilarGenerated).length}개
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={[styles.generateBtn, generating && styles.generateBtnDisabled]}
              onPress={generating ? undefined : handleGenerate}
              disabled={generating}
            >
              {generating ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="sparkles-outline" size={14} color="#fff" />
                  <Text style={styles.generateBtnText}>유사 문제 생성</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {filteredItems.length === 0 && filteredSimilarItems.length === 0 ? (
            <View style={styles.searchEmpty}>
              <Ionicons name="search" size={40} color="#333" />
              <Text style={styles.searchEmptyText}>일치하는 결과가 없습니다</Text>
            </View>
          ) : (
          <FlatList
            data={filteredItems}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={
              filteredSimilarItems.length > 0 ? (
                <View>
                  <View style={styles.sectionHeader}>
                    <Ionicons name="sparkles" size={13} color="#A78BFA" />
                    <Text style={styles.sectionHeaderText}>생성된 유사 문제 ({filteredSimilarItems.length}개)</Text>
                  </View>
                  {filteredSimilarItems.map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      activeOpacity={0.7}
                      onPress={() => handleOpen(item.projectId, item.id)}
                      style={[styles.card, styles.cardSimilar]}
                    >
                      <View style={styles.cardTop}>
                        <View style={styles.badgeRow}>
                          <View style={styles.badgeSimilar}>
                            <Ionicons name="sparkles-outline" size={12} color="#A78BFA" />
                            <Text style={styles.badgeSimilarText}>유사 문제</Text>
                          </View>
                        </View>
                        <TouchableOpacity
                          onPress={() => setDeleteModal({ kind: 'similar', item })}
                          style={{ padding: 4 }}
                        >
                          <Ionicons name="trash-outline" size={18} color="#444" />
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
                      <Text style={styles.cardScript} numberOfLines={2}>{item.script}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null
            }
          />
          )}
        </>
      )}

      <Modal visible={!!deleteModal} transparent animationType="fade">
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setDeleteModal(null)}>
          <View style={styles.menuSheet}>
            <Text style={styles.menuTitle}>문제 삭제</Text>
            <Text style={styles.menuSubtitle}>오답노트와 프로젝트에서 모두 삭제됩니다</Text>
            <TouchableOpacity style={styles.menuItem} onPress={confirmDelete}>
              <Ionicons name="trash-outline" size={18} color="#EF4444" />
              <Text style={[styles.menuItemText, { color: '#EF4444' }]}>삭제</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.menuItem, styles.menuCancel]} onPress={() => setDeleteModal(null)}>
              <Text style={styles.menuCancelText}>취소</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D0D' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  backBtn: { width: 44, justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  headerSub: { color: '#555', fontSize: 12, marginTop: 2 },

  reviewBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#F97316',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginHorizontal: 16,
    marginTop: 12,
  },
  reviewIconBox: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#00000033',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  reviewSub: { color: '#ffffffcc', fontSize: 12, marginTop: 2 },

  searchRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#222',
  },
  searchInput: { flex: 1, color: '#fff', fontSize: 14, padding: 0 },
  searchEmpty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 10 },
  searchEmptyText: { color: '#555', fontSize: 14 },

  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  statsText: { color: '#666', fontSize: 13 },
  statsPending: { color: '#F97316', fontSize: 11, marginTop: 2 },
  generateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F97316',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minWidth: 80,
    justifyContent: 'center',
  },
  generateBtnDisabled: { opacity: 0.6 },
  generateBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  list: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 40 },
  card: {
    backgroundColor: '#1A1A1A',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  cardGenerated: { opacity: 0.55 },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  cardRightRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#F9731620',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#F9731640',
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  badgeText: { color: '#F97316', fontSize: 12, fontWeight: '700' },
  generatedTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#22C55E15',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#22C55E30',
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  generatedTagText: { color: '#22C55E', fontSize: 11, fontWeight: '600' },
  cardTitle: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 5, lineHeight: 20 },
  cardScript: { color: '#555', fontSize: 12, lineHeight: 17, marginBottom: 8 },
  cardDate: { color: '#444', fontSize: 11 },
  pathRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 },
  pathText: { flex: 1, color: '#666', fontSize: 11 },
  cardDateRow: { flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  cardDateChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3,
    backgroundColor: '#0D0D0D', borderRadius: 8,
    borderWidth: 1, borderColor: '#2A2A2A',
  },
  cardDateText: { fontSize: 11, fontWeight: '700' },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#1E1E1E',
  },
  sectionHeaderText: { color: '#A78BFA', fontSize: 13, fontWeight: '700' },
  cardSimilar: { borderColor: '#A78BFA30', opacity: 1 },
  badgeSimilar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#A78BFA15',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#A78BFA40',
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  badgeSimilarText: { color: '#A78BFA', fontSize: 12, fontWeight: '700' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, paddingHorizontal: 32 },
  emptyTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  emptySub: { color: '#555', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center' },
  menuSheet: { backgroundColor: '#1A1A1A', borderRadius: 20, width: '85%', borderWidth: 1, borderColor: '#2A2A2A', overflow: 'hidden' },
  menuTitle: { color: '#666', fontSize: 13, fontWeight: '600', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#2A2A2A' },
  menuSubtitle: { color: '#555', fontSize: 12, paddingHorizontal: 20, paddingVertical: 10 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  menuItemText: { fontSize: 15, fontWeight: '600' },
  menuCancel: { borderBottomWidth: 0 },
  menuCancelText: { color: '#888', fontSize: 15, fontWeight: '600' },
});
