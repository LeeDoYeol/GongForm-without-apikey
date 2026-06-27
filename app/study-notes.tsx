import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { collection, addDoc, getDocs, deleteDoc, doc, query, where, serverTimestamp, documentId } from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import {
  getStudyNotes,
  deleteStudyNote,
  deleteStudyNotesByShortformIds,
  markStudyNoteAsGenerated,
  StudyNote,
} from '@/lib/studyNotes';
import { generateFromConcepts } from '@/lib/gemini';
import { matchesKoreanQuery } from '@/lib/koreanSearch';
import { colors } from '@/lib/theme';

interface GeneratedItem {
  id: string;
  type: 'quiz' | 'example';
  title: string;
  script: string;
}

export default function StudyNotesScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [notes, setNotes] = useState<StudyNote[]>([]);
  const [generatedItems, setGeneratedItems] = useState<GeneratedItem[]>([]);
  const [folderTitleMap, setFolderTitleMap] = useState<Record<string, string>>({});
  const [projectTitleMap, setProjectTitleMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [deleteModal, setDeleteModal] = useState<
    | { kind: 'note'; item: StudyNote }
    | { kind: 'generated'; item: GeneratedItem }
    | null
  >(null);
  const [searchQ, setSearchQ] = useState('');

  const filteredNotes = useMemo(() => {
    const q = searchQ.trim();
    if (!q) return notes;
    return notes.filter((n) => matchesKoreanQuery(n.title ?? '', q) || matchesKoreanQuery(n.script ?? '', q));
  }, [notes, searchQ]);
  const filteredGenerated = useMemo(() => {
    const q = searchQ.trim();
    if (!q) return generatedItems;
    return generatedItems.filter((g) => matchesKoreanQuery(g.title ?? '', q) || matchesKoreanQuery(g.script ?? '', q));
  }, [generatedItems, searchQ]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [noteData, genSnap, folderSnap, projectSnap] = await Promise.all([
      getStudyNotes(user.uid),
      getDocs(query(
        collection(db, 'shortforms'),
        where('userId', '==', user.uid),
        where('isGeneratedFromNote', '==', true)
      )),
      getDocs(query(collection(db, 'folders'), where('userId', '==', user.uid))),
      getDocs(query(collection(db, 'projects'), where('userId', '==', user.uid))),
    ]);

    const fMap: Record<string, string> = {};
    folderSnap.docs.forEach((d) => { fMap[d.id] = (d.data() as any).title ?? ''; });
    setFolderTitleMap(fMap);
    const pMap: Record<string, string> = {};
    projectSnap.docs.forEach((d) => { pMap[d.id] = (d.data() as any).title ?? ''; });
    setProjectTitleMap(pMap);

    const noteShortformIds = new Set(noteData.map((n) => n.shortformId));
    const generated: GeneratedItem[] = genSnap.docs
      .filter((d) => !noteShortformIds.has(d.id))
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          type: data.type as 'quiz' | 'example',
          title: data.content?.title ?? '',
          script: data.content?.script ?? '',
        };
      });

    // 구 데이터 보강: type 필드 없는 노트는 원본 shortform에서 type 가져와 채워넣음
    const missingTypeIds = noteData.filter((n) => !n.type).map((n) => n.shortformId);
    let typeMap = new Map<string, 'concept' | 'quiz' | 'example'>();
    if (missingTypeIds.length > 0) {
      const batches: string[][] = [];
      for (let i = 0; i < missingTypeIds.length; i += 30) batches.push(missingTypeIds.slice(i, i + 30));
      await Promise.all(
        batches.map(async (batch) => {
          const sfSnap = await getDocs(query(collection(db, 'shortforms'), where(documentId(), 'in', batch)));
          sfSnap.docs.forEach((d) => {
            const t = d.data().type;
            if (t === 'concept' || t === 'quiz' || t === 'example') typeMap.set(d.id, t);
          });
        })
      );
    }
    const enrichedNotes = noteData.map((n) =>
      n.type ? n : { ...n, type: typeMap.get(n.shortformId) ?? 'concept' as const }
    );

    setNotes(enrichedNotes);
    setGeneratedItems(generated);
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const handleGenerate = async () => {
    if (!user) return;
    const pending = notes
      .filter((n) => !n.hasSimilarGenerated)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));

    if (pending.length === 0) {
      setDeleteModal(null);
      return;
    }

    setGenerating(true);
    try {
      const groups = new Map<string, { projectId: string; folderId: string | null; items: StudyNote[] }>();
      for (const note of pending) {
        if (!note.projectId) continue;
        const key = note.projectId;
        if (!groups.has(key)) {
          groups.set(key, { projectId: note.projectId, folderId: note.folderId ?? null, items: [] });
        }
        groups.get(key)!.items.push(note);
      }

      let totalSaved = 0;
      const generatedIds: string[] = [];

      for (const group of groups.values()) {
        const scripts = group.items.map((n) => n.script);
        const generated = await generateFromConcepts(scripts);
        if (generated.length === 0) continue;

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
            isGeneratedFromNote: true,
            createdAt: serverTimestamp(),
          });
        }
        totalSaved += generated.length;
        group.items.forEach((n) => generatedIds.push(n.id));
      }

      if (totalSaved > 0) {
        await markStudyNoteAsGenerated(generatedIds);
        await load();
      }
    } catch (e: any) {
      console.warn('문제 생성 오류:', e?.message);
    } finally {
      setGenerating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteModal) return;
    if (deleteModal.kind === 'note') {
      const { item } = deleteModal;
      setDeleteModal(null);
      await deleteStudyNote(item.id);
      await deleteDoc(doc(db, 'shortforms', item.shortformId));
      setNotes((prev) => prev.filter((n) => n.id !== item.id));
    } else {
      const { item } = deleteModal;
      setDeleteModal(null);
      await deleteDoc(doc(db, 'shortforms', item.id));
      await deleteStudyNotesByShortformIds([item.id]);
      setGeneratedItems((prev) => prev.filter((i) => i.id !== item.id));
    }
  };

  // 노트에서만 제거 (원본 쇼츠는 그대로 둠)
  const handleRemoveFromNotes = async (item: StudyNote) => {
    setNotes((prev) => prev.filter((n) => n.id !== item.id));
    await deleteStudyNote(item.id);
  };

  const TYPE_CONFIG = {
    quiz: { label: 'OX 퀴즈', color: '#F97316', icon: 'help-circle-outline' as const },
    example: { label: '예시 문제', color: '#22C55E', icon: 'code-slash-outline' as const },
    concept: { label: '개념 정리', color: '#4F8EF7', icon: 'bulb-outline' as const },
  };

  const openNoteInPlayer = (item: StudyNote) => {
    // 노트 리스트의 표시 순서대로 ids를 넘겨서 플레이어가 그 순서대로 재생하도록 함
    const ids = notes.map((n) => n.shortformId).join(',');
    router.push({
      pathname: '/player/[id]',
      params: { id: item.projectId, shortformId: item.shortformId, ids },
    });
  };

  const renderNote = ({ item }: { item: StudyNote }) => {
    const cfg = TYPE_CONFIG[item.type ?? 'concept'];
    const folderTitle = item.folderId ? folderTitleMap[item.folderId] : '';
    const projectTitle = item.projectId ? projectTitleMap[item.projectId] : '';
    const pathLabel = [folderTitle, projectTitle].filter(Boolean).join(' › ');
    return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={() => openNoteInPlayer(item)}
      style={[styles.card, item.hasSimilarGenerated && styles.cardGenerated]}
    >
      <View style={styles.cardTop}>
        <View style={styles.badgeRow}>
          <View style={[styles.badge, { backgroundColor: cfg.color + '20', borderColor: cfg.color + '40' }]}>
            <Ionicons name={cfg.icon} size={12} color={cfg.color} />
            <Text style={[styles.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
          {item.hasSimilarGenerated && (
            <View style={styles.generatedTag}>
              <Ionicons name="checkmark" size={10} color="#22C55E" />
              <Text style={styles.generatedTagText}>문제 생성됨</Text>
            </View>
          )}
        </View>
        <View style={styles.cardActions}>
          <TouchableOpacity
            onPress={() => handleRemoveFromNotes(item)}
            style={styles.cardActionBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="bookmark" size={18} color={colors.note} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setDeleteModal({ kind: 'note', item })}
            style={styles.cardActionBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
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
      <Text style={styles.cardDate}>{item.savedAt.slice(0, 10)}</Text>
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
          <Text style={styles.headerTitle}>나의 정리 노트</Text>
          <Text style={styles.headerSub}>저장한 개념 정리 모음</Text>
        </View>
        <View style={{ width: 44 }} />
      </View>

      {loading ? (
        <ActivityIndicator color={colors.note} style={{ marginTop: 40 }} />
      ) : notes.length === 0 && generatedItems.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="bookmark" size={64} color="#333" />
          <Text style={styles.emptyTitle}>저장된 노트가 없습니다</Text>
          <Text style={styles.emptySub}>숏폼 재생 중 개념 카드에서 북마크 버튼을 눌러 저장하세요</Text>
        </View>
      ) : (
        <>
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
                  ? `검색 결과 ${filteredNotes.length}개 / 전체 ${notes.length}개`
                  : `저장된 개념 ${notes.length}개`}
              </Text>
              {notes.some((n) => !n.hasSimilarGenerated) && (
                <Text style={styles.statsPending}>
                  미생성 {notes.filter((n) => !n.hasSimilarGenerated).length}개
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
                  <Text style={styles.generateBtnText}>문제 생성</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {filteredNotes.length === 0 && filteredGenerated.length === 0 ? (
            <View style={styles.searchEmpty}>
              <Ionicons name="search" size={40} color="#333" />
              <Text style={styles.searchEmptyText}>일치하는 결과가 없습니다</Text>
            </View>
          ) : (
          <FlatList
            data={filteredNotes}
            keyExtractor={(item) => item.id}
            renderItem={renderNote}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={
              filteredGenerated.length > 0 ? (
                <View>
                  <View style={styles.sectionHeader}>
                    <Ionicons name="sparkles" size={13} color="#A78BFA" />
                    <Text style={styles.sectionHeaderText}>생성된 문제 ({filteredGenerated.length}개)</Text>
                  </View>
                  {filteredGenerated.map((item) => {
                    const cfg = TYPE_CONFIG[item.type] ?? TYPE_CONFIG.quiz;
                    return (
                      <View key={item.id} style={[styles.card, styles.cardGenItem]}>
                        <View style={styles.cardTop}>
                          <View style={styles.badgeRow}>
                            <View style={[styles.badge, { backgroundColor: cfg.color + '20', borderColor: cfg.color + '40' }]}>
                              <Ionicons name={cfg.icon} size={12} color={cfg.color} />
                              <Text style={[styles.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
                            </View>
                          </View>
                          <TouchableOpacity onPress={() => setDeleteModal({ kind: 'generated', item })} style={{ padding: 4 }}>
                            <Ionicons name="trash-outline" size={18} color="#444" />
                          </TouchableOpacity>
                        </View>
                        <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
                        <Text style={styles.cardScript} numberOfLines={2}>{item.script}</Text>
                      </View>
                    );
                  })}
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
            <Text style={styles.menuTitle}>항목 삭제</Text>
            <Text style={styles.menuSubtitle}>노트와 프로젝트에서 모두 삭제됩니다</Text>
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
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1A1A1A',
  },
  backBtn: { width: 44, justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  headerSub: { color: '#555', fontSize: 12, marginTop: 2 },

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
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1A1A1A',
  },
  statsText: { color: '#666', fontSize: 13 },
  statsPending: { color: colors.note, fontSize: 11, marginTop: 2 },
  generateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.note, borderRadius: 20,
    paddingVertical: 8, paddingHorizontal: 14,
    minWidth: 80, justifyContent: 'center',
  },
  generateBtnDisabled: { opacity: 0.6 },
  generateBtnText: { color: colors.paper, fontSize: 13, fontWeight: '700' },

  list: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 40 },
  card: {
    backgroundColor: '#1A1A1A', borderRadius: 14, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: '#2A2A2A',
  },
  cardGenerated: { opacity: 0.55 },
  cardGenItem: { borderColor: '#A78BFA30' },
  cardTop: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8,
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardActionBtn: { padding: 4 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#4F8EF720', borderRadius: 8, borderWidth: 1, borderColor: '#4F8EF740',
    paddingHorizontal: 9, paddingVertical: 4,
  },
  badgeText: { color: '#4F8EF7', fontSize: 12, fontWeight: '700' },
  generatedTag: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#22C55E15', borderRadius: 8, borderWidth: 1, borderColor: '#22C55E30',
    paddingHorizontal: 7, paddingVertical: 4,
  },
  generatedTagText: { color: '#22C55E', fontSize: 11, fontWeight: '600' },
  cardTitle: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 5, lineHeight: 20 },
  cardScript: { color: '#555', fontSize: 12, lineHeight: 17, marginBottom: 8 },
  cardDate: { color: '#444', fontSize: 11 },
  pathRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 },
  pathText: { flex: 1, color: '#666', fontSize: 11 },

  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 12, marginTop: 8,
    borderTopWidth: 1, borderTopColor: '#1E1E1E',
  },
  sectionHeaderText: { color: '#A78BFA', fontSize: 13, fontWeight: '700' },

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
