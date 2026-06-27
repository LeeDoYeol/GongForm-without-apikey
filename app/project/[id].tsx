import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  ScrollView,
  BackHandler,
  Alert,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useNavigation, useFocusEffect } from 'expo-router';
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  getDoc,
  getDocs,
  deleteDoc,
  updateDoc,
} from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { deleteWrongAnswersByShortformIds } from '@/lib/wrongAnswers';
import { deleteStudyNotesByShortformIds, saveStudyNote, getStudyNotes } from '@/lib/studyNotes';
import { createProjectShare } from '@/lib/shareProject';
import * as Clipboard from 'expo-clipboard';
import { matchesKoreanQuery } from '@/lib/koreanSearch';
import { colors, fonts, radius, text as tk, screen } from '@/lib/theme';
import { Btn } from '@/components/wf';

interface ShortForm {
  id: string;
  type: 'concept' | 'example' | 'quiz';
  content: { title: string; script: string };
  order: number;
  projectId: string;
  importance?: number;
}

const IMPORTANCE_FILTERS = [
  { value: 1, label: '전체' },
  { value: 5, label: '5+' },
  { value: 7, label: '7+' },
  { value: 9, label: '9+' },
] as const;

// 타입 색: 같은 hue 유지하면서 채도만 한 단계 down (카테고리 식별성은 유지, 시각 강도 감소)
const TYPE_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  concept: { label: '개념', color: '#6398E0', icon: 'bulb-outline' },
  example: { label: '예시', color: '#39AF65', icon: 'code-slash-outline' },
  quiz:    { label: '퀴즈', color: '#D5973D', icon: 'help-circle-outline' },
};

interface FolderOption { id: string; title: string }

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const { width: winWidth } = useWindowDimensions();
  const isWide = winWidth >= 600;
  const { user } = useAuth();

  const handleBack = useCallback(() => {
    const nav = navigation as any;
    const state = typeof nav.getState === 'function' ? nav.getState() : null;
    const stackDepth = state?.routes?.length ?? 0;
    if (stackDepth > 1 && typeof nav.popToTop === 'function') {
      nav.popToTop();
      return;
    }
    router.replace('/(tabs)/folders');
  }, [navigation, router]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleBack();
      return true;
    });
    return () => sub.remove();
  }, [handleBack]);

  const [projectTitle, setProjectTitle] = useState('');
  const [folderTitle, setFolderTitle] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [shortforms, setShortforms] = useState<ShortForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [minImportance, setMinImportance] = useState<number>(1);
  const [typeFilter, setTypeFilter] = useState({ concept: true, example: true, quiz: true });
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [allFolders, setAllFolders] = useState<FolderOption[]>([]);
  const [moving, setMoving] = useState(false);
  const [excludeFromShuffle, setExcludeFromShuffle] = useState(false);
  const [updatingExclude, setUpdatingExclude] = useState(false);
  const [savedNoteIds, setSavedNoteIds] = useState<Set<string>>(new Set());
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [generatingShare, setGeneratingShare] = useState(false);

  const openShare = useCallback(async () => {
    if (!user) return;
    setShareOpen(true);
    if (shareCode) return;
    setGeneratingShare(true);
    try {
      const code = await createProjectShare(user.uid, id, user.email);
      setShareCode(code);
    } catch (e: any) {
      Alert.alert('오류', e?.message ?? '공유 코드 생성 실패');
      setShareOpen(false);
    } finally {
      setGeneratingShare(false);
    }
  }, [user, id, shareCode]);

  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2000);
    return () => clearTimeout(t);
  }, [notice]);

  const copyShareCode = useCallback(async () => {
    if (!shareCode) return;
    const code = shareCode;
    await Clipboard.setStringAsync(code);
    setShareOpen(false);
    setNotice({ title: '복사되었습니다', body: `공유 코드 ${code}가 클립보드에 복사됐어요` });
  }, [shareCode]);

  useFocusEffect(
    useCallback(() => {
      if (!user) return;
      let alive = true;
      getStudyNotes(user.uid)
        .then((notes) => {
          if (!alive) return;
          setSavedNoteIds(new Set(notes.map((n) => n.shortformId)));
        })
        .catch(() => {});
      return () => {
        alive = false;
        setTypeFilter({ concept: true, example: true, quiz: true });
      };
    }, [user])
  );

  const toggleSaveNote = useCallback(async (sf: ShortForm) => {
    if (!user) return;
    const alreadySaved = savedNoteIds.has(sf.id);
    setSavedNoteIds((prev) => {
      const next = new Set(prev);
      if (alreadySaved) next.delete(sf.id); else next.add(sf.id);
      return next;
    });
    try {
      if (alreadySaved) {
        await deleteStudyNotesByShortformIds([sf.id]);
      } else {
        await saveStudyNote(
          user.uid,
          sf.id,
          id,
          sf.content.title,
          sf.content.script,
          currentFolderId,
          sf.type,
        );
      }
    } catch {
      setSavedNoteIds((prev) => {
        const next = new Set(prev);
        if (alreadySaved) next.add(sf.id); else next.delete(sf.id);
        return next;
      });
    }
  }, [user, savedNoteIds, id, currentFolderId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const projDoc = await getDoc(doc(db, 'projects', id));
      if (cancelled) return;
      if (projDoc.exists()) {
        const data = projDoc.data();
        setProjectTitle(data.title);
        setCurrentFolderId(data.folderId ?? null);
        setExcludeFromShuffle(data.excludeFromShuffle === true);
        if (data.folderId) {
          const fDoc = await getDoc(doc(db, 'folders', data.folderId));
          if (!cancelled && fDoc.exists()) setFolderTitle(fDoc.data().title);
        }
      }
    })();

    const unsub = onSnapshot(
      query(collection(db, 'shortforms'), where('projectId', '==', id)),
      (snap) => {
        setShortforms(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() } as ShortForm))
            .sort((a, b) => a.order - b.order)
        );
        setLoading(false);
      }
    );

    return () => { cancelled = true; unsub(); };
  }, [id]);

  const openMoveModal = useCallback(async () => {
    if (!user) return;
    setMoveOpen(true);
    try {
      const snap = await getDocs(query(collection(db, 'folders'), where('userId', '==', user.uid)));
      const list = snap.docs
        .map((d) => ({ id: d.id, title: (d.data() as any).title ?? '' } as FolderOption))
        .sort((a, b) => a.title.localeCompare(b.title));
      setAllFolders(list);
    } catch {
      setAllFolders([]);
    }
  }, [user]);

  const toggleExcludeFromShuffle = useCallback(async () => {
    if (updatingExclude) return;
    setUpdatingExclude(true);
    const next = !excludeFromShuffle;
    try {
      await updateDoc(doc(db, 'projects', id), { excludeFromShuffle: next });
      setExcludeFromShuffle(next);
    } catch (e: any) {
      setNotice({ title: '변경 실패', body: e?.message ?? '셔플 설정을 바꾸지 못했어요. 잠시 후 다시 시도해주세요.' });
    } finally {
      setUpdatingExclude(false);
    }
  }, [id, excludeFromShuffle, updatingExclude]);

  const moveToFolder = useCallback(async (newFolderId: string | null) => {
    if (moving) return;
    if (newFolderId === currentFolderId) { setMoveOpen(false); return; }
    setMoving(true);
    try {
      await updateDoc(doc(db, 'projects', id), { folderId: newFolderId });
      setCurrentFolderId(newFolderId);
      if (newFolderId) {
        const fDoc = await getDoc(doc(db, 'folders', newFolderId));
        setFolderTitle(fDoc.exists() ? (fDoc.data() as any).title ?? null : null);
      } else {
        setFolderTitle(null);
      }
      setMoveOpen(false);
    } catch {}
    finally { setMoving(false); }
  }, [id, currentFolderId, moving]);

  const totalCount = shortforms.length;
  const filteredShortforms = useMemo(() => {
    const q = searchQ.trim();
    return shortforms.filter((sf) => {
      if (!typeFilter[sf.type]) return false;
      const imp = sf.importance ?? 5;
      if (imp < minImportance) return false;
      if (q) {
        const title = sf.content?.title ?? '';
        const script = sf.content?.script ?? '';
        if (!matchesKoreanQuery(title, q) && !matchesKoreanQuery(script, q)) return false;
      }
      return true;
    });
  }, [shortforms, searchQ, minImportance, typeFilter]);

  const renderItem = ({ item: sf }: { item: ShortForm }) => {
    const cfg = TYPE_CONFIG[sf.type];
    const originalIndex = shortforms.findIndex((s) => s.id === sf.id);
    const imp = sf.importance ?? 5;
    const impColor = imp >= 9 ? colors.bad : imp >= 7 ? '#f59e0b' : imp >= 5 ? '#ca8a04' : colors.ink3;
    const isNoteSaved = savedNoteIds.has(sf.id);
    return (
      <View style={s.card}>
        <View style={s.cardHeader}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
            <View style={[s.typeBadge, { backgroundColor: cfg.color + '15', borderColor: cfg.color }]}>
              <Ionicons name={cfg.icon} size={11} color={cfg.color} />
              <Text style={[s.typeText, { color: cfg.color }]}>{cfg.label}</Text>
            </View>
            <View style={[s.impBadge, { backgroundColor: impColor + '20', borderColor: impColor }]}>
              <Ionicons name="star" size={9} color={impColor} />
              <Text style={[s.impBadgeText, { color: impColor }]}>{imp}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => toggleSaveNote(sf)} style={{ padding: 8 }} hitSlop={6}>
            <Ionicons
              name={isNoteSaved ? 'bookmark' : 'bookmark-outline'}
              size={16}
              color={isNoteSaved ? colors.accent : colors.ink3}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setDeleteTarget(sf.id)} style={{ padding: 8 }}>
            <Ionicons name="trash-outline" size={15} color={colors.ink3} />
          </TouchableOpacity>
        </View>
        <Text
          style={s.cardTitle}
          numberOfLines={2}
          onPress={() => router.push({ pathname: '/player/[id]', params: { id, startIndex: originalIndex } })}
        >{sf.content.title}</Text>
        <Text
          style={s.cardScript}
          numberOfLines={1}
          ellipsizeMode="tail"
          onPress={() => router.push({ pathname: '/player/[id]', params: { id, startIndex: originalIndex } })}
        >{sf.content.script}</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={screen.light}>
      {/* 헤더 */}
      <View style={s.header}>
        <TouchableOpacity onPress={handleBack} style={s.backBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={22} color={colors.ink} />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle} numberOfLines={1}>{projectTitle || '프로젝트'}</Text>
          <TouchableOpacity onPress={openMoveModal} hitSlop={6}>
            <Text style={s.headerSub} numberOfLines={1}>
              📁 {folderTitle ?? '폴더 선택'} <Text style={s.headerSubAction}>이동</Text>
            </Text>
          </TouchableOpacity>
        </View>
        {isWide ? (
          <>
            <TouchableOpacity style={s.shareBtn} onPress={openShare} hitSlop={8}>
              <Ionicons name="share-social-outline" size={18} color={colors.good} />
            </TouchableOpacity>
            <TouchableOpacity style={s.deleteAllBtn} onPress={() => setDeleteAllOpen(true)} hitSlop={8}>
              <Ionicons name="trash-outline" size={14} color={colors.bad} />
              <Text style={s.deleteAllBtnText}>전체 삭제</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.uploadBtn}
              onPress={() => router.push({
                pathname: '/upload/[projectId]',
                params: { projectId: id, projectTitle },
              })}
            >
              <Ionicons name="cloud-upload-outline" size={14} color={colors.accentDeep} />
              <Text style={s.uploadBtnText}>자료 추가</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={s.headerIconBtn}
            onPress={() => setHeaderMenuOpen(true)}
            hitSlop={8}
          >
            <Ionicons name="ellipsis-vertical" size={20} color={colors.ink} />
          </TouchableOpacity>
        )}
      </View>

      {/* 모바일 헤더 점 세개 메뉴 */}
      <Modal visible={headerMenuOpen} transparent animationType="fade">
        <TouchableOpacity style={s.menuOverlay} activeOpacity={1} onPress={() => setHeaderMenuOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={s.headerMenuSheet}>
            <TouchableOpacity
              style={s.headerMenuItem}
              onPress={() => {
                setHeaderMenuOpen(false);
                router.push({ pathname: '/upload/[projectId]', params: { projectId: id, projectTitle } });
              }}
            >
              <Ionicons name="cloud-upload-outline" size={18} color={colors.accent} />
              <Text style={s.headerMenuLabel}>자료 추가</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.headerMenuItem}
              onPress={() => { setHeaderMenuOpen(false); openShare(); }}
            >
              <Ionicons name="share-social-outline" size={18} color={colors.good} />
              <Text style={s.headerMenuLabel}>공유 코드 생성</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.headerMenuItem}
              onPress={() => { setHeaderMenuOpen(false); setDeleteAllOpen(true); }}
            >
              <Ionicons name="trash-outline" size={18} color={colors.bad} />
              <Text style={[s.headerMenuLabel, { color: colors.bad }]}>전체 삭제</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      ) : totalCount === 0 ? (
        <View style={s.empty}>
          <Ionicons name="videocam-outline" size={56} color={colors.ink4} />
          <Text style={s.emptyText}>학습 자료를 올려보세요</Text>
          <Text style={s.emptySubText}>
            {'PDF, 이미지, 텍스트를 업로드하면\nAI가 개념·예시·퀴즈 숏폼을 자동으로 만들어드려요'}
          </Text>
          <TouchableOpacity
            style={s.emptyCreateBtn}
            onPress={() => router.push({
              pathname: '/upload/[projectId]',
              params: { projectId: id, projectTitle },
            })}
          >
            <Ionicons name="cloud-upload-outline" size={18} color={colors.accentDeep} />
            <Text style={s.emptyCreateBtnText}>자료 추가하기</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* 프로젝트 이름: 가운데 정렬 큰 제목 */}
          <Text style={s.playSectionTitle} numberOfLines={2}>
            {projectTitle || '프로젝트'}
          </Text>

          {/* 재생 액션: 둘 다 secondary, 일반 재생은 살짝 밝게 / 셔플은 살짝 가라앉게 */}
          <View style={s.playRow}>
            <Btn
              lg
              onPress={() => router.push({ pathname: '/player/[id]', params: { id, startIndex: 0 } })}
              style={[{ flex: 1 }, s.playBtnLight]}
            >
              ▶ 일반 재생
            </Btn>
            <Btn
              lg
              onPress={() => router.push({ pathname: '/player/[id]', params: { id, startIndex: 0, shuffle: '1' } })}
              style={[{ flex: 1 }, s.playBtnDark]}
              textStyle={{ color: colors.accentDeep }}
            >
              🔀 셔플
            </Btn>
          </View>

          {/* 검색 */}
          <View style={s.searchRow}>
            <View style={s.searchBox}>
              <Ionicons name="search" size={15} color={colors.ink3} />
              <TextInput
                style={s.searchInput}
                value={searchQ}
                onChangeText={setSearchQ}
                placeholder="제목·내용 검색"
                placeholderTextColor={colors.ink4}
                returnKeyType="search"
              />
              {searchQ.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQ('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color={colors.ink4} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* 중요도·타입 필터 */}
          <View style={[s.impFilterWrap, isWide && s.impFilterWrapWide]}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.impFilterRow}
            >
              <Text style={s.impFilterLabel}>중요도</Text>
              {IMPORTANCE_FILTERS.map((f) => {
                const active = minImportance === f.value;
                return (
                  <TouchableOpacity
                    key={f.value}
                    style={[s.impChip, active && s.impChipActive]}
                    onPress={() => setMinImportance(f.value)}
                  >
                    <Ionicons
                      name={f.value === 1 ? 'apps-outline' : 'star'}
                      size={11}
                      color={active ? colors.paper : colors.ink3}
                    />
                    <Text style={[s.impChipText, active && s.impChipTextActive]}>{f.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {isWide && (
              <View style={s.typeFilterInline}>
                <Text style={s.impFilterLabel}>타입</Text>
                {([
                  { key: 'concept' as const, label: '개념 정리', icon: 'bulb' as const, color: '#6398E0' },
                  { key: 'example' as const, label: '예시 문제', icon: 'code-slash' as const, color: '#39AF65' },
                  { key: 'quiz' as const,    label: 'OX 퀴즈',   icon: 'help-circle' as const, color: '#D5973D' },
                ]).map((t) => {
                  const active = typeFilter[t.key];
                  return (
                    <TouchableOpacity
                      key={t.key}
                      style={[
                        s.impChip,
                        active && { backgroundColor: t.color, borderColor: t.color },
                      ]}
                      onPress={() => setTypeFilter((prev) => ({ ...prev, [t.key]: !prev[t.key] }))}
                    >
                      <Ionicons name={t.icon} size={11} color={active ? colors.paper : colors.ink3} />
                      <Text style={[s.impChipText, active && s.impChipTextActive]}>{t.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>

          {/* 모바일: 타입 필터 별도 줄 */}
          {!isWide && (
            <View style={s.impFilterWrap}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.impFilterRow}>
                <Text style={s.impFilterLabel}>타입</Text>
                {([
                  { key: 'concept' as const, label: '개념 정리', icon: 'bulb' as const, color: '#6398E0' },
                  { key: 'example' as const, label: '예시 문제', icon: 'code-slash' as const, color: '#39AF65' },
                  { key: 'quiz' as const,    label: 'OX 퀴즈',   icon: 'help-circle' as const, color: '#D5973D' },
                ]).map((t) => {
                  const active = typeFilter[t.key];
                  return (
                    <TouchableOpacity
                      key={t.key}
                      style={[
                        s.impChip,
                        active && { backgroundColor: t.color, borderColor: t.color },
                      ]}
                      onPress={() => setTypeFilter((prev) => ({ ...prev, [t.key]: !prev[t.key] }))}
                    >
                      <Ionicons name={t.icon} size={11} color={active ? colors.paper : colors.ink3} />
                      <Text style={[s.impChipText, active && s.impChipTextActive]}>{t.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          )}

          <View style={s.statsRow}>
            <Text style={s.statsText}>
              {searchQ.trim().length > 0 ? `${filteredShortforms.length} / ${totalCount}개` : `숏폼 ${totalCount}개`}
            </Text>
          </View>

          {/* 전체 셔플 제외 토글 */}
          {(() => {
            const included = !excludeFromShuffle;
            return (
              <TouchableOpacity
                style={[s.excludeRow, included && s.excludeRowActive]}
                onPress={toggleExcludeFromShuffle}
                disabled={updatingExclude}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={included ? 'shuffle' : 'eye-off'}
                  size={14}
                  color={included ? colors.accentGreenDeep : colors.ink3}
                />
                <Text style={[s.excludeRowText, included && { color: colors.accentGreenDeep }]}>
                  {included ? '전체 셔플에 포함' : '전체 셔플에서 제외됨'}
                </Text>
                <View style={[s.excludeToggle, included && s.excludeToggleActive]}>
                  <View style={[s.excludeKnob, included && s.excludeKnobActive]} />
                </View>
              </TouchableOpacity>
            );
          })()}

          {filteredShortforms.length === 0 ? (
            <View style={s.searchEmpty}>
              <Ionicons name="search" size={40} color={colors.ink4} />
              <Text style={s.searchEmptyText}>일치하는 쇼츠가 없습니다</Text>
            </View>
          ) : (
            <FlatList
              data={filteredShortforms}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              contentContainerStyle={s.list}
              keyboardShouldPersistTaps="handled"
            />
          )}
        </>
      )}

      {/* 전체 삭제 모달 */}
      <Modal visible={deleteAllOpen} transparent animationType="fade">
        <TouchableOpacity
          style={s.overlay}
          activeOpacity={1}
          onPress={() => !deletingAll && setDeleteAllOpen(false)}
        >
          <View style={s.menuSheet}>
            <Text style={s.menuTitle}>전체 삭제</Text>
            <Text style={[s.menuTitle, { color: colors.ink2, borderBottomWidth: 0 }]}>
              {`이 프로젝트의 ${totalCount}개 쇼츠를\n모두 삭제하시겠습니까?`}
            </Text>
            <TouchableOpacity
              style={s.menuItem}
              disabled={deletingAll}
              onPress={async () => {
                if (deletingAll) return;
                setDeletingAll(true);
                try {
                  const ids = shortforms.map((s) => s.id);
                  await Promise.all(ids.map((sfId) => deleteDoc(doc(db, 'shortforms', sfId))));
                  await Promise.all([
                    deleteWrongAnswersByShortformIds(ids),
                    deleteStudyNotesByShortformIds(ids),
                  ]);
                } finally {
                  setDeletingAll(false);
                  setDeleteAllOpen(false);
                }
              }}
            >
              {deletingAll ? (
                <ActivityIndicator color={colors.bad} size="small" />
              ) : (
                <Ionicons name="trash-outline" size={18} color={colors.bad} />
              )}
              <Text style={[s.menuItemText, { color: colors.bad }]}>
                {deletingAll ? '삭제 중...' : '전체 삭제'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.menuItem, s.menuCancel]}
              disabled={deletingAll}
              onPress={() => setDeleteAllOpen(false)}
            >
              <Text style={s.menuCancelText}>취소</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 개별 삭제 모달 */}
      <Modal visible={!!deleteTarget} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setDeleteTarget(null)}>
          <View style={s.menuSheet}>
            <Text style={s.menuTitle}>쇼츠 삭제</Text>
            <Text style={[s.menuTitle, { color: colors.ink2, borderBottomWidth: 0 }]}>정말로 삭제하겠습니까?</Text>
            <TouchableOpacity
              style={s.menuItem}
              onPress={async () => {
                const sfId = deleteTarget!;
                setDeleteTarget(null);
                await deleteDoc(doc(db, 'shortforms', sfId));
                await Promise.all([
                  deleteWrongAnswersByShortformIds([sfId]),
                  deleteStudyNotesByShortformIds([sfId]),
                ]);
              }}
            >
              <Ionicons name="trash-outline" size={18} color={colors.bad} />
              <Text style={[s.menuItemText, { color: colors.bad }]}>삭제</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.menuItem, s.menuCancel]} onPress={() => setDeleteTarget(null)}>
              <Text style={s.menuCancelText}>취소</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 폴더 이동 모달 */}
      <Modal visible={moveOpen} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => !moving && setMoveOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={s.moveSheet}>
            <Text style={s.moveTitle}>폴더로 이동</Text>
            <Text style={s.moveHint}>이 프로젝트를 옮길 폴더를 선택하세요</Text>
            <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ paddingVertical: 4 }}>
              <TouchableOpacity
                style={[s.moveItem, currentFolderId === null && s.moveItemActive]}
                disabled={moving}
                onPress={() => moveToFolder(null)}
              >
                <Ionicons name="remove-circle-outline" size={18} color={currentFolderId === null ? colors.accent : colors.ink3} />
                <Text style={[s.moveItemText, currentFolderId === null && { color: colors.accent }]}>폴더 없음</Text>
                {currentFolderId === null && <Ionicons name="checkmark" size={16} color={colors.accent} />}
              </TouchableOpacity>
              {allFolders.map((f) => {
                const active = currentFolderId === f.id;
                return (
                  <TouchableOpacity
                    key={f.id}
                    style={[s.moveItem, active && s.moveItemActive]}
                    disabled={moving}
                    onPress={() => moveToFolder(f.id)}
                  >
                    <Ionicons name="folder" size={18} color={active ? colors.accent : colors.ink3} />
                    <Text style={[s.moveItemText, active && { color: colors.accent }]} numberOfLines={1}>
                      {f.title}
                    </Text>
                    {active && <Ionicons name="checkmark" size={16} color={colors.accent} />}
                  </TouchableOpacity>
                );
              })}
              {allFolders.length === 0 && (
                <Text style={s.moveEmpty}>아직 만들어진 폴더가 없습니다</Text>
              )}
            </ScrollView>
            <TouchableOpacity
              style={[s.menuItem, s.menuCancel, { marginTop: 8 }]}
              onPress={() => !moving && setMoveOpen(false)}
            >
              <Text style={s.menuCancelText}>{moving ? '이동 중...' : '취소'}</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* 공유 코드 모달 */}
      <Modal visible={shareOpen} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShareOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={s.shareSheet}>
            <View style={s.shareIconWrap}>
              <Ionicons name="share-social-outline" size={26} color={colors.good} />
            </View>
            <Text style={s.shareTitle}>공유 코드</Text>
            <Text style={s.shareHint}>
              이 코드를 받은 사람은 "{projectTitle}"의 모든 쇼츠를 자기 계정에 복제할 수 있어요.
            </Text>

            {generatingShare || !shareCode ? (
              <View style={s.shareCodeBox}>
                <ActivityIndicator color={colors.good} />
              </View>
            ) : (
              <TouchableOpacity style={s.shareCodeBox} onPress={copyShareCode} activeOpacity={0.7}>
                <Text style={s.shareCodeText} selectable>{shareCode}</Text>
                <Text style={s.shareCodeHint}>탭하여 복사</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[s.menuItem, s.menuCancel, { marginTop: 4 }]}
              onPress={() => setShareOpen(false)}
            >
              <Text style={s.menuCancelText}>닫기</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* 알림 모달 */}
      <Modal visible={!!notice} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setNotice(null)}>
          <TouchableOpacity activeOpacity={1} style={s.noticeSheet}>
            <View style={s.noticeIconWrap}>
              <Ionicons name="checkmark-circle-outline" size={30} color={colors.good} />
            </View>
            <Text style={s.noticeTitle}>{notice?.title ?? ''}</Text>
            <Text style={s.noticeBody}>{notice?.body ?? ''}</Text>
            <TouchableOpacity style={s.noticeOkBtn} onPress={() => setNotice(null)}>
              <Text style={s.noticeOkText}>확인</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  // 헤더
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
  headerCenter: { flex: 1 },
  headerTitle: { fontFamily: fonts.body, fontSize: 17, color: colors.ink },
  headerSub: { fontFamily: fonts.body, fontSize: 12, color: colors.ink3, marginTop: 2 },
  headerSubAction: { fontFamily: fonts.body, color: colors.accent, fontWeight: '700' },
  uploadBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    height: 36,
    backgroundColor: colors.accentSoft,
    borderWidth: 1.5, borderColor: colors.accent,
    borderRadius: radius.md, paddingHorizontal: 12,
  },
  uploadBtnText: { fontFamily: fonts.body, color: colors.accentDeep, fontSize: 13, fontWeight: '700' },
  headerIconBtn: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1.5, borderColor: colors.stroke,
    alignItems: 'center', justifyContent: 'center',
  },
  shareBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.goodSoft,
    borderWidth: 1.5, borderColor: colors.good,
    justifyContent: 'center', alignItems: 'center',
  },
  deleteAllBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    height: 36,
    backgroundColor: colors.badSoft,
    borderRadius: 20,
    paddingHorizontal: 12,
    borderWidth: 1.5, borderColor: colors.bad,
  },
  deleteAllBtnText: { fontFamily: fonts.body, color: colors.bad, fontSize: 12, fontWeight: '700' },

  // 모바일 헤더 점 세개 메뉴
  menuOverlay: {
    flex: 1, backgroundColor: 'rgba(21,23,28,0.55)',
    justifyContent: 'flex-start', alignItems: 'flex-end',
    paddingTop: 56, paddingRight: 12,
  },
  headerMenuSheet: {
    backgroundColor: colors.paper, borderRadius: radius.md,
    paddingVertical: 6, minWidth: 200,
    borderWidth: 1.5, borderColor: colors.stroke,
  },
  headerMenuItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
  },
  headerMenuLabel: { fontFamily: fonts.body, color: colors.ink, fontSize: 14 },

  // 재생 액션
  playSectionTitle: {
    fontFamily: fonts.display,
    fontSize: 26,
    color: colors.ink,
    textAlign: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
    lineHeight: 32,
  },
  playRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 16, paddingBottom: 4,
  },
  // 일반 재생: paper2(#1A1A1A)보다 한 단계 밝게, 채도는 없음 (흰색 살짝 섞은 느낌)
  playBtnLight: { backgroundColor: '#272727', borderColor: '#333333' },
  // 셔플: 다크 톤 위에 옅은 코발트 (accent solid는 너무 튀어서 soft 배경 + accent 보더/텍스트로)
  playBtnDark: { backgroundColor: colors.accentSoft, borderColor: colors.accent },

  // 검색
  searchRow: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.paper2, paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.strokeSoft,
  },
  searchInput: { flex: 1, fontFamily: fonts.body, color: colors.ink, fontSize: 14, padding: 0 },
  searchEmpty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 10 },
  searchEmptyText: { fontFamily: fonts.body, color: colors.ink3, fontSize: 14 },

  // 필터
  impFilterWrap: { borderTopWidth: 1, borderTopColor: colors.strokeSoft },
  impFilterWrapWide: { flexDirection: 'row', alignItems: 'center' },
  typeFilterInline: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingRight: 16, paddingLeft: 8, marginLeft: 'auto',
  },
  impFilterRow: {
    flexDirection: 'row', gap: 6,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10,
    alignItems: 'center',
  },
  impChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: colors.paper,
    borderWidth: 1.5, borderColor: colors.strokeSoft,
    flexShrink: 0,
  },
  impChipActive: { backgroundColor: '#ca8a04', borderColor: '#ca8a04' },
  impChipText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 12, fontWeight: '700' },
  impChipTextActive: { color: colors.paper },
  impFilterLabel: { fontFamily: fonts.mono, color: colors.ink3, fontSize: 11, marginRight: 4 },

  impBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 3,
    borderRadius: 7, borderWidth: 1.5,
  },
  impBadgeText: { fontFamily: fonts.body, fontSize: 11, fontWeight: '800' },

  statsRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.strokeSoft,
  },
  statsText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 13 },

  // 전체 셔플 토글
  excludeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.strokeSoft,
  },
  excludeRowActive: { backgroundColor: colors.accentGreenSoft },
  excludeRowText: { flex: 1, fontFamily: fonts.body, color: colors.ink2, fontSize: 12 },
  excludeToggle: {
    width: 32, height: 18, borderRadius: 9,
    backgroundColor: colors.ink4, padding: 2, justifyContent: 'center',
  },
  excludeToggleActive: { backgroundColor: colors.accentGreen },
  excludeKnob: {
    width: 14, height: 14, borderRadius: 7, backgroundColor: colors.paper,
  },
  excludeKnobActive: { backgroundColor: colors.paper, transform: [{ translateX: 14 }] },

  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 40 },

  // 카드
  card: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    padding: 12, marginTop: 6,
    borderWidth: 1.5, borderColor: colors.stroke,
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: 8,
  },
  typeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderRadius: 8, borderWidth: 1.5,
    paddingHorizontal: 9, paddingVertical: 3,
  },
  typeText: { fontFamily: fonts.body, fontSize: 12, fontWeight: '700' },
  cardTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 14, marginBottom: 5, lineHeight: 19 },
  cardScript: { fontFamily: fonts.body, color: colors.ink3, fontSize: 12, lineHeight: 17 },

  // 빈 상태
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, paddingHorizontal: 32 },
  emptyText: { fontFamily: fonts.body, color: colors.ink, fontSize: 16 },
  emptySubText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  emptyCreateBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.accentSoft,
    borderWidth: 1.5, borderColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 12, paddingHorizontal: 20,
    marginTop: 8, gap: 8,
  },
  emptyCreateBtnText: { fontFamily: fonts.body, color: colors.accentDeep, fontWeight: '700', fontSize: 15 },

  // 모달 공통
  overlay: { flex: 1, backgroundColor: 'rgba(21,23,28,0.55)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  menuSheet: {
    backgroundColor: colors.paper, borderRadius: radius.lg,
    width: '100%', maxWidth: 380,
    borderWidth: 1.5, borderColor: colors.stroke, overflow: 'hidden',
  },
  menuTitle: {
    fontFamily: fonts.body, color: colors.ink, fontSize: 14,
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: colors.strokeSoft,
  },
  menuItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: colors.strokeSoft,
  },
  menuItemText: { fontFamily: fonts.body, fontSize: 15 },
  menuCancel: { borderBottomWidth: 0, backgroundColor: colors.paper2, justifyContent: 'center' },
  menuCancelText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 14 },

  // 폴더 이동
  moveSheet: {
    backgroundColor: colors.paper, borderRadius: radius.lg,
    padding: 16, width: '100%', maxWidth: 420,
    borderWidth: 1.5, borderColor: colors.stroke,
  },
  moveTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 16, marginBottom: 4 },
  moveHint: { fontFamily: fonts.body, color: colors.ink2, fontSize: 12, marginBottom: 12 },
  moveItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10,
  },
  moveItemActive: { backgroundColor: colors.accentSoft },
  moveItemText: { flex: 1, fontFamily: fonts.body, color: colors.ink, fontSize: 14 },
  moveEmpty: { fontFamily: fonts.body, color: colors.ink3, fontSize: 13, textAlign: 'center', paddingVertical: 20 },

  // 공유 모달
  shareSheet: {
    backgroundColor: colors.paper, borderRadius: radius.lg, padding: 22,
    width: '100%', maxWidth: 380,
    borderWidth: 1.5, borderColor: colors.stroke, alignItems: 'center',
  },
  shareIconWrap: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.goodSoft, borderWidth: 1.5, borderColor: colors.good,
    justifyContent: 'center', alignItems: 'center', marginBottom: 10,
  },
  shareTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 18, marginBottom: 4 },
  shareHint: { fontFamily: fonts.body, color: colors.ink2, fontSize: 12, textAlign: 'center', marginBottom: 14, lineHeight: 18 },
  shareCodeBox: {
    width: '100%', minHeight: 80,
    backgroundColor: colors.paper2, borderRadius: 12,
    borderWidth: 1.5, borderColor: colors.good,
    paddingVertical: 16, paddingHorizontal: 14,
    alignItems: 'center', justifyContent: 'center',
    gap: 6, marginBottom: 8,
  },
  shareCodeText: {
    fontFamily: fonts.mono, color: colors.good,
    fontSize: 24, fontWeight: '900', letterSpacing: 4,
  },
  shareCodeHint: { fontFamily: fonts.body, color: colors.ink3, fontSize: 11 },

  // 알림 모달
  noticeSheet: {
    backgroundColor: colors.paper, borderRadius: radius.lg, padding: 24,
    width: '100%', maxWidth: 360,
    borderWidth: 1.5, borderColor: colors.stroke,
    alignItems: 'center',
  },
  noticeIconWrap: {
    width: 60, height: 60, borderRadius: 30,
    borderWidth: 1.5, borderColor: colors.good,
    backgroundColor: colors.goodSoft,
    alignItems: 'center', justifyContent: 'center', marginBottom: 14,
  },
  noticeTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 17, marginBottom: 6, textAlign: 'center' },
  noticeBody: { fontFamily: fonts.body, color: colors.ink2, fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 16 },
  noticeOkBtn: {
    width: '100%', paddingVertical: 12,
    borderRadius: 10, backgroundColor: colors.good,
    alignItems: 'center',
  },
  noticeOkText: { fontFamily: fonts.body, color: colors.paper, fontSize: 14, fontWeight: '700' },
});
