import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  TextInput,
  Alert,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView, GestureDetector, Gesture } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  collection, query, where, onSnapshot, addDoc, deleteDoc, doc, getDocs, updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { deleteWrongAnswersByShortformIds } from '@/lib/wrongAnswers';
import { deleteStudyNotesByShortformIds } from '@/lib/studyNotes';
import { matchesKoreanQuery } from '@/lib/koreanSearch';
import { getShareInfo, redeemShare, createProjectShare, createFolderShare, ShareInfo } from '@/lib/shareProject';
import { consumePendingRedeemCode } from '@/lib/pendingRedeem';
import * as Clipboard from 'expo-clipboard';
import { colors, fonts, radius, screen } from '@/lib/theme';

interface Folder {
  id: string;
  title: string;
  createdAt: any;
}
interface Project {
  id: string;
  title: string;
  folderId: string | null;
  createdAt: any;
  order?: number;
  excludeFromShuffle?: boolean;
}

const NO_FOLDER_KEY = '__no_folder__';

export default function ProjectsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [shortformCounts, setShortformCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useFocusEffect(useCallback(() => { setExpanded({}); }, []));
  const [searchQ, setSearchQ] = useState('');
  const [contextMenu, setContextMenu] = useState<{ project: Project } | null>(null);

  // 드래그 상태
  const [dragProject, setDragProject] = useState<Project | null>(null);
  const [hoverFolderId, setHoverFolderId] = useState<string | null>(null);
  const folderViewsRef = useRef<Record<string, View | null>>({});
  const folderBoundsRef = useRef<Record<string, { top: number; bottom: number }>>({});
  const dragY = useRef(new Animated.Value(0)).current;

  // 모달
  const [projectModal, setProjectModal] = useState(false);
  const [folderModal, setFolderModal] = useState(false);
  const [folderPickerVisible, setFolderPickerVisible] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [newProjectFolderId, setNewProjectFolderId] = useState<string | null>(null);
  const [newFolderTitle, setNewFolderTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [renameTarget, setRenameTarget] = useState<
    { kind: 'project'; id: string; title: string } | { kind: 'folder'; id: string; title: string } | null
  >(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);

  // 폴더 컨텍스트 메뉴
  const [folderMenu, setFolderMenu] = useState<{ folder: Folder; projectCount: number } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void;
  } | null>(null);

  // 공유 발급
  const [shareModal, setShareModal] = useState<{ kind: 'project' | 'folder'; title: string } | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [generatingShare, setGeneratingShare] = useState(false);

  const openShare = useCallback(async (proj: Project) => {
    if (!user) return;
    setShareModal({ kind: 'project', title: proj.title });
    setShareCode(null);
    setGeneratingShare(true);
    try {
      const code = await createProjectShare(user.uid, proj.id, user.email);
      setShareCode(code);
    } catch (e: any) {
      Alert.alert('오류', e?.message ?? '공유 코드 생성 실패');
      setShareModal(null);
    } finally {
      setGeneratingShare(false);
    }
  }, [user]);

  const openFolderShare = useCallback(async (folder: Folder) => {
    if (!user) return;
    setShareModal({ kind: 'folder', title: folder.title });
    setShareCode(null);
    setGeneratingShare(true);
    try {
      const code = await createFolderShare(user.uid, folder.id, user.email);
      setShareCode(code);
    } catch (e: any) {
      Alert.alert('오류', e?.message ?? '공유 코드 생성 실패');
      setShareModal(null);
    } finally {
      setGeneratingShare(false);
    }
  }, [user]);

  const copyShareCode = useCallback(async () => {
    if (!shareCode) return;
    const code = shareCode;
    await Clipboard.setStringAsync(code);
    setShareModal(null);
    setNotice({ kind: 'success', title: '복사되었습니다', body: `공유 코드 ${code}가 클립보드에 복사됐어요` });
  }, [shareCode]);

  // 공유 코드 받기
  const [redeemModal, setRedeemModal] = useState(false);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemInfo, setRedeemInfo] = useState<ShareInfo | null>(null);
  const [redeemChecking, setRedeemChecking] = useState(false);
  const [redeemErr, setRedeemErr] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  const closeRedeem = useCallback(() => {
    setRedeemModal(false);
    setRedeemCode('');
    setRedeemInfo(null);
    setRedeemErr(null);
    setRedeemChecking(false);
  }, []);

  // gongform://share/CODE 링크로 진입했거나 다른 화면이 코드를 stash해뒀으면 redeem 모달 자동 오픈.
  // 포커스마다 한 번씩 소비: consumePendingRedeemCode가 read+remove이므로 중복 트리거 방지됨.
  useFocusEffect(
    useCallback(() => {
      if (!user) return;
      consumePendingRedeemCode().then((code) => {
        if (code) {
          setRedeemCode(code);
          setRedeemModal(true);
        }
      });
    }, [user]),
  );

  useEffect(() => {
    const norm = redeemCode.trim().toUpperCase();
    if (norm.length !== 8) {
      setRedeemInfo(null);
      setRedeemErr(null);
      return;
    }
    let alive = true;
    setRedeemChecking(true);
    setRedeemErr(null);
    getShareInfo(norm)
      .then((info) => {
        if (!alive) return;
        if (info) { setRedeemInfo(info); setRedeemErr(null); }
        else { setRedeemInfo(null); setRedeemErr('유효하지 않은 코드입니다'); }
      })
      .catch(() => { if (alive) setRedeemErr('조회 실패'); })
      .finally(() => { if (alive) setRedeemChecking(false); });
    return () => { alive = false; };
  }, [redeemCode]);

  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; title: string; body: string } | null>(null);
  useEffect(() => {
    if (notice?.kind !== 'success') return;
    const t = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(t);
  }, [notice]);

  const doRedeem = useCallback(async () => {
    if (!user || !redeemInfo || redeeming) return;
    setRedeeming(true);
    try {
      const result = await redeemShare(redeemInfo.code, user.uid);
      closeRedeem();
      const body = result.kind === 'folder'
        ? `폴더 "${result.folderTitle}"가 추가됐어요\n프로젝트 ${result.projectCount}개 · 쇼츠 ${result.totalShortformCount}개`
        : `"${result.projectTitle}"가 내 프로젝트에 추가됐어요\n쇼츠 ${result.shortformCount}개`;
      setNotice({ kind: 'success', title: '받기 완료', body });
    } catch (e: any) {
      closeRedeem();
      setNotice({ kind: 'error', title: '받기 실패', body: e?.message ?? '알 수 없는 오류' });
    } finally {
      setRedeeming(false);
    }
  }, [user, redeemInfo, redeeming, closeRedeem]);

  useEffect(() => {
    if (!user) return;
    const unsubFolders = onSnapshot(
      query(collection(db, 'folders'), where('userId', '==', user.uid)),
      (snap) => {
        setFolders(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() } as Folder))
            .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0))
        );
      }
    );
    const unsubProjects = onSnapshot(
      query(collection(db, 'projects'), where('userId', '==', user.uid)),
      (snap) => {
        setProjects(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() } as Project))
            .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0))
        );
        setLoading(false);
      }
    );
    const unsubShortforms = onSnapshot(
      query(collection(db, 'shortforms'), where('userId', '==', user.uid)),
      (snap) => {
        const counts: Record<string, number> = {};
        snap.docs.forEach((d) => {
          const pid = (d.data() as any).projectId;
          if (pid) counts[pid] = (counts[pid] ?? 0) + 1;
        });
        setShortformCounts(counts);
      }
    );
    return () => { unsubFolders(); unsubProjects(); unsubShortforms(); };
  }, [user]);

  const folderTitleMap = useMemo(() => {
    const m = new Map<string, string>();
    folders.forEach((f) => m.set(f.id, f.title));
    return m;
  }, [folders]);

  const matchesSearch = useCallback(
    (p: Project) => {
      const q = searchQ.trim();
      if (!q) return true;
      const folderName = p.folderId ? folderTitleMap.get(p.folderId) ?? '' : '';
      return matchesKoreanQuery(p.title, q) || matchesKoreanQuery(folderName, q);
    },
    [searchQ, folderTitleMap]
  );

  const projectsByFolder = useMemo(() => {
    const m: Record<string, Project[]> = { [NO_FOLDER_KEY]: [] };
    folders.forEach((f) => { m[f.id] = []; });
    projects.filter(matchesSearch).forEach((p) => {
      const key = p.folderId && m[p.folderId] ? p.folderId : NO_FOLDER_KEY;
      m[key].push(p);
    });
    return m;
  }, [folders, projects, matchesSearch]);

  // 폴더 바운드 측정 / 드래그 로직 - 기존 동일
  const measureFolder = useCallback((folderKey: string, ref: View | null) => {
    folderViewsRef.current[folderKey] = ref;
  }, []);

  const remeasureAll = useCallback(() => {
    Object.entries(folderViewsRef.current).forEach(([key, ref]) => {
      if (!ref) return;
      ref.measureInWindow((_x, y, _w, h) => {
        folderBoundsRef.current[key] = { top: y, bottom: y + h };
      });
    });
  }, []);

  const hitTestFolder = useCallback((pageY: number): string | null => {
    for (const [key, b] of Object.entries(folderBoundsRef.current)) {
      if (pageY >= b.top && pageY <= b.bottom) {
        return key === NO_FOLDER_KEY ? null : key;
      }
    }
    return undefined as any;
  }, []);

  const onDragStart = useCallback((project: Project, pageY: number) => {
    remeasureAll();
    setDragProject(project);
    dragY.setValue(pageY);
  }, [dragY, remeasureAll]);

  const onDragUpdate = useCallback((pageY: number) => {
    dragY.setValue(pageY);
    const hit = hitTestFolder(pageY);
    if (hit === undefined) setHoverFolderId(null);
    else setHoverFolderId(hit ?? NO_FOLDER_KEY);
  }, [hitTestFolder, dragY]);

  const onDragEnd = useCallback(async (pageY: number, project: Project) => {
    const hit = hitTestFolder(pageY);
    setDragProject(null);
    setHoverFolderId(null);
    if (hit === undefined) return;
    const targetFolderId: string | null = hit;
    if ((project.folderId ?? null) === targetFolderId) return;
    try {
      await updateDoc(doc(db, 'projects', project.id), { folderId: targetFolderId });
    } catch {
      Alert.alert('오류', '폴더 이동에 실패했습니다.');
    }
  }, [hitTestFolder]);

  // CRUD - 기존 동일
  const createProject = async () => {
    const trimmed = newProjectTitle.trim();
    if (!trimmed) { Alert.alert('오류', '프로젝트 이름을 입력해주세요.'); return; }
    if (projects.some((p) => p.title.trim().toLowerCase() === trimmed.toLowerCase())) {
      setNotice({ kind: 'error', title: '이름 중복', body: '같은 이름의 프로젝트가 이미 있어요.' });
      return;
    }
    setCreating(true);
    try {
      await addDoc(collection(db, 'projects'), {
        userId: user!.uid,
        title: trimmed,
        folderId: newProjectFolderId,
        order: 0,
        createdAt: serverTimestamp(),
      });
      setNewProjectTitle('');
      setNewProjectFolderId(null);
      setProjectModal(false);
    } catch {
      Alert.alert('오류', '프로젝트 생성에 실패했습니다.');
    } finally {
      setCreating(false);
    }
  };

  const createFolder = async () => {
    const trimmed = newFolderTitle.trim();
    if (!trimmed) { Alert.alert('오류', '폴더 이름을 입력해주세요.'); return; }
    if (folders.some((f) => f.title.trim().toLowerCase() === trimmed.toLowerCase())) {
      setNotice({ kind: 'error', title: '이름 중복', body: '같은 이름의 폴더가 이미 있어요.' });
      return;
    }
    setCreating(true);
    try {
      await addDoc(collection(db, 'folders'), {
        userId: user!.uid,
        title: trimmed,
        createdAt: serverTimestamp(),
      });
      setNewFolderTitle('');
      setFolderModal(false);
    } catch {
      Alert.alert('오류', '폴더 생성에 실패했습니다.');
    } finally {
      setCreating(false);
    }
  };

  const deleteProject = (project: Project) => {
    const performDelete = async () => {
      try {
        const sfsSnap = await getDocs(query(collection(db, 'shortforms'), where('projectId', '==', project.id)));
        const sfIds = sfsSnap.docs.map((d) => d.id);
        await deleteDoc(doc(db, 'projects', project.id));
        await Promise.all(sfsSnap.docs.map((d) => deleteDoc(d.ref)));
        await Promise.all([
          deleteWrongAnswersByShortformIds(sfIds).catch(() => {}),
          deleteStudyNotesByShortformIds(sfIds).catch(() => {}),
        ]);
      } catch (e: any) {
        Alert.alert('삭제 실패', e?.message ?? '알 수 없는 오류');
      }
    };
    setConfirmModal({
      title: '프로젝트 삭제',
      message: `"${project.title}" 프로젝트와 모든 숏폼을 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`,
      confirmLabel: '삭제',
      danger: true,
      onConfirm: performDelete,
    });
  };

  const deleteFolder = (folder: Folder) => {
    const projectsInFolder = projects.filter((p) => p.folderId === folder.id);
    const message = projectsInFolder.length > 0
      ? `"${folder.title}" 폴더를 삭제할까요?\n폴더 내 프로젝트(${projectsInFolder.length}개)는 삭제되지 않고 그룹만 풀립니다.`
      : `"${folder.title}" 폴더를 삭제할까요?`;
    const performDelete = async () => {
      try {
        await Promise.all(
          projectsInFolder.map((p) => updateDoc(doc(db, 'projects', p.id), { folderId: null }))
        );
        await deleteDoc(doc(db, 'folders', folder.id));
      } catch (e: any) {
        Alert.alert('삭제 실패', e?.message ?? '알 수 없는 오류');
      }
    };
    setConfirmModal({
      title: '폴더 삭제', message, confirmLabel: '삭제', danger: true, onConfirm: performDelete,
    });
  };

  const openRename = (project: Project) => {
    setRenameTarget({ kind: 'project', id: project.id, title: project.title });
    setRenameTitle(project.title);
  };
  const openRenameFolder = (folder: Folder) => {
    setRenameTarget({ kind: 'folder', id: folder.id, title: folder.title });
    setRenameTitle(folder.title);
  };

  const renameProject = async () => {
    if (!renameTitle.trim() || !renameTarget) return;
    const trimmed = renameTitle.trim();
    const lower = trimmed.toLowerCase();
    const peers = renameTarget.kind === 'folder' ? folders : projects;
    if (peers.some((x) => x.id !== renameTarget.id && x.title.trim().toLowerCase() === lower)) {
      setNotice({ kind: 'error', title: '이름 중복', body: `같은 이름의 ${renameTarget.kind === 'folder' ? '폴더' : '프로젝트'}가 이미 있어요.` });
      return;
    }
    setRenaming(true);
    try {
      const col = renameTarget.kind === 'folder' ? 'folders' : 'projects';
      await updateDoc(doc(db, col, renameTarget.id), { title: trimmed });
      setRenameTarget(null);
      setRenameTitle('');
    } catch {
      Alert.alert('오류', '이름 변경에 실패했습니다.');
    } finally {
      setRenaming(false);
    }
  };

  const toggleFolderShuffle = useCallback(async (folder: Folder, nextExcluded: boolean) => {
    const list = projects.filter((p) => p.folderId === folder.id);
    try {
      await Promise.all(
        list.map((p) => updateDoc(doc(db, 'projects', p.id), { excludeFromShuffle: nextExcluded }))
      );
    } catch (e: any) {
      Alert.alert('오류', e?.message ?? '셔플 설정 변경 실패');
    }
  }, [projects]);

  const toggleFolder = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <SafeAreaView style={screen.light}>
      {/* 헤더 */}
      <View style={s.header}>
        <Text style={s.headerTitle}>내 자료</Text>
        <View style={s.headerActions}>
          <TouchableOpacity
            style={s.headerIconBtn}
            onPress={() => setRedeemModal(true)}
            hitSlop={8}
          >
            <Ionicons name="download-outline" size={18} color={colors.ink} />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.headerIconBtn}
            onPress={() => setProjectModal(true)}
            hitSlop={8}
          >
            <Ionicons name="add" size={20} color={colors.ink} />
          </TouchableOpacity>
        </View>
      </View>

      {/* 검색 pill */}
      <View style={s.searchRow}>
        <View style={s.searchPill}>
          <Ionicons name="search" size={15} color={colors.ink3} />
          <TextInput
            style={s.searchInput}
            value={searchQ}
            onChangeText={setSearchQ}
            placeholder="프로젝트 · 폴더 검색"
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

      {/* 친구 코드 배너 */}
      <TouchableOpacity
        style={s.codeBanner}
        onPress={() => setRedeemModal(true)}
        activeOpacity={0.7}
      >
        <Ionicons name="link-outline" size={16} color={colors.good} />
        <Text style={s.codeBannerText}>친구 코드로 프로젝트 받기</Text>
        <Text style={s.codeBannerArrow}>코드 입력 →</Text>
      </TouchableOpacity>

      {/* 액션 버튼: 상단 배치 */}
      <View style={s.topActions}>
        <TouchableOpacity style={[s.actionBtn, s.actionBtnPrimary]} onPress={() => setProjectModal(true)}>
          <Ionicons name="add" size={18} color={colors.paper} />
          <Text style={[s.actionBtnText, s.actionBtnTextPrimary]}>새 프로젝트</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.actionBtn} onPress={() => setFolderModal(true)}>
          <Ionicons name="folder-outline" size={18} color={colors.ink} />
          <Text style={s.actionBtnText}>새 폴더</Text>
        </TouchableOpacity>
      </View>

      {/* 팁 박스 (라이트 톤) */}
      {dragProject ? (
        <Text style={s.dragHint}>폴더 위로 끌어다 놓으세요</Text>
      ) : (
        <View style={s.tipBox}>
          <Ionicons name="information-circle-outline" size={14} color={colors.accent} />
          <Text style={s.tipText}>
            <Text style={s.tipBold}>꾹 누른 채로</Text> 프로젝트를 끌어 폴더에 넣을 수 있어요
          </Text>
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView
          contentContainerStyle={s.list}
          scrollEnabled={!dragProject}
        >
          {/* "그룹 없음": 디자인은 위에 둠 */}
          {projectsByFolder[NO_FOLDER_KEY].length > 0 && (
            <View style={{ marginBottom: 16 }}>
              <View style={s.sectionHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Text style={s.sectionLabel}>그룹 없음</Text>
                  <Text style={s.sectionMeta}>· {projectsByFolder[NO_FOLDER_KEY].length}</Text>
                </View>
              </View>
              <View
                ref={(r) => measureFolder(NO_FOLDER_KEY, r)}
                style={[
                  s.dashedWrap,
                  hoverFolderId === NO_FOLDER_KEY && s.dashedWrapHover,
                ]}
              >
                {projectsByFolder[NO_FOLDER_KEY].map((p, idx) => (
                  <View key={p.id}>
                    {idx > 0 && <View style={s.rowDivider} />}
                    <DraggableProject
                      project={p}
                      folderTitle={null}
                      count={shortformCounts[p.id] ?? 0}
                      isDragging={dragProject?.id === p.id}
                      onTap={() => router.push({ pathname: '/project/[id]', params: { id: p.id } })}
                      onMenu={() => setContextMenu({ project: p })}
                      onDragStart={onDragStart}
                      onDragUpdate={onDragUpdate}
                      onDragEnd={onDragEnd}
                    />
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* 폴더 섹션 */}
          {folders.length > 0 && (
            <View>
              <View style={s.sectionHeader}>
                <Text style={s.sectionLabel}>폴더 {folders.length}</Text>
              </View>
              {folders.map((folder) => {
                const list = projectsByFolder[folder.id] ?? [];
                const q = searchQ.trim();
                if (q.length > 0 && list.length === 0 && !matchesKoreanQuery(folder.title, q)) {
                  return null;
                }
                const isExpanded = !!expanded[folder.id] || (q.length > 0 && list.length > 0);
                const isHover = hoverFolderId === folder.id;
                return (
                  <View key={folder.id} style={{ marginBottom: 10 }}>
                    <View
                      ref={(r) => measureFolder(folder.id, r)}
                      style={[s.folderCard, isHover && s.folderCardHover]}
                    >
                      <TouchableOpacity
                        style={s.folderBar}
                        onPress={() => toggleFolder(folder.id)}
                        activeOpacity={0.7}
                      >
                        <Ionicons
                          name={isExpanded ? 'folder-open' : 'folder'}
                          size={22}
                          color="#3B82F6"
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={s.folderTitle} numberOfLines={1}>{folder.title}</Text>
                          <Text style={s.folderMeta}>{list.length}개 프로젝트</Text>
                        </View>
                        <TouchableOpacity
                          onPress={(e) => { (e as any).stopPropagation?.(); setFolderMenu({ folder, projectCount: list.length }); }}
                          hitSlop={8}
                          style={{ padding: 4 }}
                        >
                          <Ionicons name="ellipsis-vertical" size={18} color={colors.ink3} />
                        </TouchableOpacity>
                        <Ionicons
                          name={isExpanded ? 'chevron-up' : 'chevron-down'}
                          size={18}
                          color={colors.ink3}
                        />
                      </TouchableOpacity>

                      {isExpanded && (
                        <View style={s.folderBody}>
                          {list.length === 0 ? (
                            <Text style={s.folderEmpty}>비어있음 — 프로젝트를 끌어다 놓으세요</Text>
                          ) : (
                            list.map((p, idx) => (
                              <View key={p.id}>
                                {idx > 0 && <View style={s.rowDivider} />}
                                <DraggableProject
                                  project={p}
                                  folderTitle={p.folderId ? (folderTitleMap.get(p.folderId) ?? null) : null}
                                  count={shortformCounts[p.id] ?? 0}
                                  isDragging={dragProject?.id === p.id}
                                  onTap={() => router.push({ pathname: '/project/[id]', params: { id: p.id } })}
                                  onMenu={() => setContextMenu({ project: p })}
                                  onDragStart={onDragStart}
                                  onDragUpdate={onDragUpdate}
                                  onDragEnd={onDragEnd}
                                />
                              </View>
                            ))
                          )}
                        </View>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {folders.length === 0 && projectsByFolder[NO_FOLDER_KEY].length === 0 && (
            <View style={s.empty}>
              <Ionicons name={searchQ.trim() ? 'search' : 'layers-outline'} size={56} color={colors.ink4} />
              <Text style={s.emptyText}>
                {searchQ.trim() ? '검색 결과가 없습니다' : '첫 프로젝트를 만들어보세요'}
              </Text>
              <Text style={s.emptySubText}>
                {searchQ.trim()
                  ? '다른 키워드로 검색해 보세요'
                  : 'PDF · 이미지 · 텍스트 · 노트 자료를 업로드하면\nAI가 자동으로 개념 · 예시 · OX 퀴즈를 생성해요'}
              </Text>
              {!searchQ.trim() && (
                <TouchableOpacity style={s.emptyCta} onPress={() => setProjectModal(true)}>
                  <Ionicons name="add" size={18} color={colors.paper} />
                  <Text style={s.emptyCtaText}>새 프로젝트 만들기</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </ScrollView>
      )}

      {/* 드래그 ghost */}
      {dragProject && (
        <Animated.View
          pointerEvents="none"
          style={[
            s.dragGhost,
            { transform: [{ translateY: Animated.subtract(dragY, new Animated.Value(30)) }] },
          ]}
        >
          <View style={s.dragGhostInner}>
            <Ionicons name="layers" size={20} color={colors.accent} />
            <Text style={s.dragGhostText} numberOfLines={1}>{dragProject.title}</Text>
          </View>
        </Animated.View>
      )}

      {/* 모달들 */}

      <Modal visible={projectModal} transparent animationType="fade">
        <View style={s.overlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>새 프로젝트</Text>
            <View style={s.flowHintRow}>
              <Text style={s.flowStep}>📄 자료 업로드</Text>
              <Ionicons name="arrow-forward" size={11} color={colors.ink3} />
              <Text style={s.flowStep}>🤖 AI 분석</Text>
              <Ionicons name="arrow-forward" size={11} color={colors.ink3} />
              <Text style={s.flowStep}>▶ 숏폼 학습</Text>
            </View>
            <TextInput
              style={s.modalInput}
              placeholder="프로젝트 이름 (예: 2단원 세포의 구조)"
              placeholderTextColor={colors.ink4}
              value={newProjectTitle}
              onChangeText={setNewProjectTitle}
              autoFocus
            />
            <Text style={s.modalLabel}>폴더 (선택)</Text>
            <TouchableOpacity style={s.folderPicker} onPress={() => setFolderPickerVisible(true)}>
              <Ionicons
                name={newProjectFolderId ? 'folder' : 'folder-outline'}
                size={16}
                color={newProjectFolderId ? colors.accent : colors.ink3}
              />
              <Text style={[s.folderPickerText, newProjectFolderId && { color: colors.ink }]}>
                {newProjectFolderId ? folderTitleMap.get(newProjectFolderId) ?? '폴더' : '폴더 없음'}
              </Text>
              <Ionicons name="chevron-down" size={14} color={colors.ink3} />
            </TouchableOpacity>
            <View style={s.modalBtns}>
              <TouchableOpacity
                style={s.cancelBtn}
                onPress={() => { setProjectModal(false); setNewProjectTitle(''); setNewProjectFolderId(null); }}
              >
                <Text style={s.cancelText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.createBtn} onPress={createProject} disabled={creating}>
                {creating ? (
                  <ActivityIndicator color={colors.paper} size="small" />
                ) : (
                  <>
                    <Ionicons name="add" size={16} color={colors.paper} />
                    <Text style={s.createText}>만들기</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={folderPickerVisible} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setFolderPickerVisible(false)}>
          <TouchableOpacity activeOpacity={1} style={s.menuSheet}>
            <Text style={s.menuTitle}>폴더 선택</Text>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => { setNewProjectFolderId(null); setFolderPickerVisible(false); }}
            >
              <Ionicons name="ellipsis-horizontal" size={18} color={colors.ink3} />
              <Text style={s.menuItemText}>폴더 없음</Text>
              {newProjectFolderId === null && (
                <Ionicons name="checkmark" size={16} color={colors.accent} style={{ marginLeft: 'auto' }} />
              )}
            </TouchableOpacity>
            {folders.map((f) => (
              <TouchableOpacity
                key={f.id}
                style={s.menuItem}
                onPress={() => { setNewProjectFolderId(f.id); setFolderPickerVisible(false); }}
              >
                <Ionicons name="folder" size={18} color={colors.accent} />
                <Text style={s.menuItemText}>{f.title}</Text>
                {newProjectFolderId === f.id && (
                  <Ionicons name="checkmark" size={16} color={colors.accent} style={{ marginLeft: 'auto' }} />
                )}
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[s.menuItem, s.menuCancel]} onPress={() => setFolderPickerVisible(false)}>
              <Text style={s.menuCancelText}>닫기</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={folderModal} transparent animationType="fade">
        <View style={s.overlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>새 폴더</Text>
            <Text style={s.modalHint}>프로젝트들을 그룹으로 묶을 수 있습니다 (선택 사항)</Text>
            <TextInput
              style={s.modalInput}
              placeholder="폴더 이름 (예: 생물 1학기)"
              placeholderTextColor={colors.ink4}
              value={newFolderTitle}
              onChangeText={setNewFolderTitle}
              autoFocus
            />
            <View style={s.modalBtns}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => { setFolderModal(false); setNewFolderTitle(''); }}>
                <Text style={s.cancelText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.createBtn} onPress={createFolder} disabled={creating}>
                {creating ? (
                  <ActivityIndicator color={colors.paper} size="small" />
                ) : (
                  <>
                    <Ionicons name="add" size={16} color={colors.paper} />
                    <Text style={s.createText}>만들기</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!contextMenu} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setContextMenu(null)}>
          <TouchableOpacity activeOpacity={1} style={s.menuSheet}>
            <Text style={s.menuTitle} numberOfLines={1}>{contextMenu?.project.title}</Text>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => {
                const p = contextMenu!.project;
                setContextMenu(null);
                router.push({ pathname: '/upload/[projectId]', params: { projectId: p.id, projectTitle: p.title } });
              }}
            >
              <Ionicons name="cloud-upload-outline" size={18} color={colors.accent} />
              <Text style={[s.menuItemText, { color: colors.accent }]}>자료 추가</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => {
                const p = contextMenu!.project;
                setContextMenu(null);
                openRename(p);
              }}
            >
              <Ionicons name="pencil-outline" size={18} color={colors.ink2} />
              <Text style={s.menuItemText}>이름 변경</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => {
                const p = contextMenu!.project;
                setContextMenu(null);
                openShare(p);
              }}
            >
              <Ionicons name="share-social-outline" size={18} color={colors.good} />
              <Text style={[s.menuItemText, { color: colors.good }]}>공유</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.menuItem}
              onPress={async () => {
                const p = contextMenu!.project;
                const next = !p.excludeFromShuffle;
                setContextMenu(null);
                try {
                  await updateDoc(doc(db, 'projects', p.id), { excludeFromShuffle: next });
                } catch {}
              }}
            >
              <Ionicons
                name={contextMenu?.project.excludeFromShuffle ? 'eye-off' : 'eye-outline'}
                size={18}
                color={contextMenu?.project.excludeFromShuffle ? '#f59e0b' : colors.ink2}
              />
              <Text style={[
                s.menuItemText,
                contextMenu?.project.excludeFromShuffle && { color: '#b45309' },
              ]}>
                {contextMenu?.project.excludeFromShuffle ? '전체 셔플 다시 포함' : '전체 셔플에서 제외'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => {
                const p = contextMenu!.project;
                setContextMenu(null);
                deleteProject(p);
              }}
            >
              <Ionicons name="trash-outline" size={18} color={colors.bad} />
              <Text style={[s.menuItemText, { color: colors.bad }]}>삭제</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.menuItem, s.menuCancel]} onPress={() => setContextMenu(null)}>
              <Text style={s.menuCancelText}>취소</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={!!renameTarget} transparent animationType="fade">
        <View style={s.overlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>이름 변경</Text>
            <TextInput
              style={s.modalInput}
              placeholder="새 이름"
              placeholderTextColor={colors.ink4}
              value={renameTitle}
              onChangeText={setRenameTitle}
              autoFocus
              selectTextOnFocus
            />
            <View style={s.modalBtns}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => { setRenameTarget(null); setRenameTitle(''); }}>
                <Text style={s.cancelText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.createBtn}
                onPress={renameProject}
                disabled={renaming || !renameTitle.trim()}
              >
                {renaming ? (
                  <ActivityIndicator color={colors.paper} size="small" />
                ) : (
                  <>
                    <Ionicons name="checkmark" size={16} color={colors.paper} />
                    <Text style={s.createText}>변경</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 공유 발급 모달: 코드 탭하여 복사 (project/[id].tsx와 동일 UI) */}
      <Modal visible={!!shareModal} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShareModal(null)}>
          <TouchableOpacity activeOpacity={1} style={s.shareSheet}>
            <View style={s.shareIconBox}>
              <Ionicons name="share-social-outline" size={26} color={colors.good} />
            </View>
            <Text style={s.shareTitle}>공유 코드</Text>
            <Text style={s.shareHint}>
              {shareModal?.kind === 'folder'
                ? `이 코드를 받은 사람은 폴더 "${shareModal?.title}"의 모든 프로젝트를 자기 계정에 복제할 수 있어요.`
                : `이 코드를 받은 사람은 "${shareModal?.title}"의 모든 쇼츠를 자기 계정에 복제할 수 있어요.`}
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
              onPress={() => setShareModal(null)}
            >
              <Text style={s.menuCancelText}>닫기</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* 공유 코드 받기 모달 (현재 UI 구조 유지, 라이트 톤) */}
      <Modal visible={redeemModal} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => !redeeming && closeRedeem()}>
          <TouchableOpacity activeOpacity={1} style={s.modal}>
            <View style={s.redeemHeader}>
              <View style={s.redeemIconBox}>
                <Ionicons name="download-outline" size={20} color={colors.good} />
              </View>
              <Text style={s.modalTitle}>공유 코드로 받기</Text>
            </View>
            <Text style={s.modalHint}>친구가 공유한 8자리 코드를 입력하세요</Text>

            <TextInput
              style={s.redeemInput}
              placeholder="ABCD1234"
              placeholderTextColor={colors.ink4}
              value={redeemCode}
              onChangeText={(t) => setRedeemCode(t.toUpperCase())}
              autoCapitalize="characters"
              maxLength={8}
              autoCorrect={false}
            />

            {redeemChecking ? (
              <View style={s.redeemStatus}>
                <ActivityIndicator color={colors.good} size="small" />
                <Text style={s.redeemStatusText}>코드 확인 중...</Text>
              </View>
            ) : redeemErr ? (
              <View style={s.redeemStatus}>
                <Ionicons name="alert-circle" size={16} color={colors.bad} />
                <Text style={[s.redeemStatusText, { color: colors.bad }]}>{redeemErr}</Text>
              </View>
            ) : redeemInfo ? (
              <View style={s.redeemPreview}>
                <Text style={s.redeemPreviewTitle} numberOfLines={2}>
                  {redeemInfo.type === 'folder' ? '📁' : '📚'} {redeemInfo.type === 'folder' ? redeemInfo.folderTitle : redeemInfo.projectTitle}
                </Text>
                <Text style={s.redeemPreviewMeta}>
                  {redeemInfo.type === 'folder'
                    ? `프로젝트 ${redeemInfo.projectCount}개 · 쇼츠 ${redeemInfo.totalShortformCount}개`
                    : `쇼츠 ${redeemInfo.shortformCount}개`}
                  {redeemInfo.ownerEmail ? ` · ${redeemInfo.ownerEmail}` : ''}
                </Text>
              </View>
            ) : null}

            <View style={s.modalBtns}>
              <TouchableOpacity style={s.cancelBtn} disabled={redeeming} onPress={closeRedeem}>
                <Text style={s.cancelText}>{redeeming ? '받는 중...' : '취소'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.createBtn, { backgroundColor: colors.good }, (!redeemInfo || redeeming) && { opacity: 0.4 }]}
                disabled={!redeemInfo || redeeming}
                onPress={doRedeem}
              >
                {redeeming ? (
                  <ActivityIndicator color={colors.paper} size="small" />
                ) : (
                  <>
                    <Ionicons name="download" size={16} color={colors.paper} />
                    <Text style={s.createText}>받기</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* 폴더 컨텍스트 메뉴 */}
      <Modal visible={!!folderMenu} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setFolderMenu(null)}>
          <TouchableOpacity activeOpacity={1} style={s.menuSheet}>
            <Text style={s.menuTitle} numberOfLines={1}>{folderMenu?.folder.title}</Text>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => { const f = folderMenu!.folder; setFolderMenu(null); openRenameFolder(f); }}
            >
              <Ionicons name="pencil-outline" size={18} color={colors.ink2} />
              <Text style={s.menuItemText}>이름 변경</Text>
            </TouchableOpacity>
            {(() => {
              const list = folderMenu ? projects.filter((p) => p.folderId === folderMenu.folder.id) : [];
              const allExcluded = list.length > 0 && list.every((p) => p.excludeFromShuffle === true);
              return (
                <TouchableOpacity
                  style={s.menuItem}
                  disabled={list.length === 0}
                  onPress={() => {
                    const f = folderMenu!.folder;
                    setFolderMenu(null);
                    toggleFolderShuffle(f, !allExcluded);
                  }}
                >
                  <Ionicons
                    name={allExcluded ? 'eye-off' : 'eye-outline'}
                    size={18}
                    color={list.length === 0 ? colors.ink4 : (allExcluded ? '#f59e0b' : colors.ink2)}
                  />
                  <Text style={[
                    s.menuItemText,
                    list.length === 0 ? { color: colors.ink4 } : (allExcluded ? { color: '#b45309' } : {}),
                  ]}>
                    {list.length === 0 ? '전체 셔플 설정 (빈 폴더)' : (allExcluded ? '전체 셔플 다시 포함' : '전체 셔플에서 제외')}
                  </Text>
                </TouchableOpacity>
              );
            })()}
            <TouchableOpacity
              style={s.menuItem}
              disabled={(folderMenu?.projectCount ?? 0) === 0}
              onPress={() => {
                const f = folderMenu!.folder;
                setFolderMenu(null);
                openFolderShare(f);
              }}
            >
              <Ionicons name="share-social-outline" size={18} color={(folderMenu?.projectCount ?? 0) === 0 ? colors.ink4 : colors.good} />
              <Text style={[s.menuItemText, (folderMenu?.projectCount ?? 0) === 0 ? { color: colors.ink4 } : { color: colors.good }]}>
                공유{(folderMenu?.projectCount ?? 0) === 0 ? ' (빈 폴더)' : ''}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => { const f = folderMenu!.folder; setFolderMenu(null); deleteFolder(f); }}
            >
              <Ionicons name="trash-outline" size={18} color={colors.bad} />
              <Text style={[s.menuItemText, { color: colors.bad }]}>삭제</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.menuItem, s.menuCancel]} onPress={() => setFolderMenu(null)}>
              <Text style={s.menuCancelText}>취소</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* 확인 모달 */}
      <Modal visible={!!confirmModal} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setConfirmModal(null)}>
          <TouchableOpacity activeOpacity={1} style={s.noticeSheet}>
            <View
              style={[
                s.noticeIconBox,
                confirmModal?.danger
                  ? { backgroundColor: colors.badSoft, borderColor: colors.bad }
                  : { backgroundColor: colors.accentSoft, borderColor: colors.accent },
              ]}
            >
              <Ionicons
                name={confirmModal?.danger ? 'warning-outline' : 'help-circle-outline'}
                size={28}
                color={confirmModal?.danger ? colors.bad : colors.accent}
              />
            </View>
            <Text style={s.noticeTitle}>{confirmModal?.title ?? ''}</Text>
            <Text style={s.noticeBody}>{confirmModal?.message ?? ''}</Text>
            <View style={{ flexDirection: 'row', gap: 10, width: '100%' }}>
              <TouchableOpacity style={[s.cancelBtn, { flex: 1 }]} onPress={() => setConfirmModal(null)}>
                <Text style={s.cancelText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  s.createBtn, { flex: 1 },
                  confirmModal?.danger ? { backgroundColor: colors.bad } : null,
                ]}
                onPress={() => {
                  const cb = confirmModal?.onConfirm;
                  setConfirmModal(null);
                  cb?.();
                }}
              >
                <Text style={s.createText}>{confirmModal?.confirmLabel ?? '확인'}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* 알림 모달 */}
      <Modal visible={!!notice} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setNotice(null)}>
          <TouchableOpacity activeOpacity={1} style={s.noticeSheet}>
            <View
              style={[
                s.noticeIconBox,
                notice?.kind === 'success'
                  ? { backgroundColor: colors.goodSoft, borderColor: colors.good }
                  : { backgroundColor: colors.badSoft, borderColor: colors.bad },
              ]}
            >
              <Ionicons
                name={notice?.kind === 'success' ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                size={28}
                color={notice?.kind === 'success' ? colors.good : colors.bad}
              />
            </View>
            <Text style={s.noticeTitle}>{notice?.title ?? ''}</Text>
            <Text style={s.noticeBody}>{notice?.body ?? ''}</Text>
            <TouchableOpacity
              style={[
                s.createBtn, { width: '100%' },
                notice?.kind === 'error' && { backgroundColor: colors.bad },
              ]}
              onPress={() => setNotice(null)}
            >
              <Text style={s.createText}>확인</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

// 드래그 가능한 프로젝트 행
function DraggableProject({
  project, folderTitle, count, isDragging, onTap, onMenu, onDragStart, onDragUpdate, onDragEnd,
}: {
  project: Project;
  folderTitle: string | null;
  count: number;
  isDragging: boolean;
  onTap: () => void;
  onMenu: () => void;
  onDragStart: (p: Project, pageY: number) => void;
  onDragUpdate: (pageY: number) => void;
  onDragEnd: (pageY: number, p: Project) => void;
}) {
  const tap = Gesture.Tap()
    .maxDuration(250)
    .onEnd((_e, success) => { if (success) runOnJS(onTap)(); });

  const pan = Gesture.Pan()
    .activateAfterLongPress(150)
    .onStart((e) => { runOnJS(onDragStart)(project, e.absoluteY); })
    .onUpdate((e) => { runOnJS(onDragUpdate)(e.absoluteY); })
    .onEnd((e) => { runOnJS(onDragEnd)(e.absoluteY, project); });

  const composed = Gesture.Race(pan, tap);

  return (
    <View style={[s.projectRow, isDragging && { opacity: 0.4 }]}>
      <GestureDetector gesture={composed}>
        <View style={s.projectBody}>
          <View style={s.projectIcon}>
            <Ionicons name="layers-outline" size={18} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.projectTitle} numberOfLines={1}>{project.title}</Text>
            <View style={s.projectMetaRow}>
              {folderTitle && (
                <View style={s.folderTag}>
                  <Ionicons name="folder" size={10} color={colors.ink3} />
                  <Text style={s.folderTagText}>{folderTitle}</Text>
                </View>
              )}
              <Text style={s.projectMeta}>
                {count > 0 ? `숏폼 ${count}개` : '자료를 추가해보세요'}
              </Text>
            </View>
          </View>
        </View>
      </GestureDetector>
      <TouchableOpacity onPress={onMenu} hitSlop={8} style={{ padding: 12 }}>
        <Ionicons name="ellipsis-vertical" size={18} color={colors.ink3} />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  // 헤더
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
  },
  headerTitle: { fontFamily: fonts.body, fontSize: 22, color: colors.ink },
  headerActions: { flexDirection: 'row', gap: 8 },
  headerIconBtn: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1.5, borderColor: colors.stroke,
    alignItems: 'center', justifyContent: 'center',
  },

  // 검색
  searchRow: { paddingHorizontal: 20, paddingBottom: 10 },
  searchPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 9,
    backgroundColor: colors.paper2,
    borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.strokeSoft,
  },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 14, color: colors.ink, paddingVertical: 0 },

  // 친구 코드 배너: secondary 톤 (paper2 + stroke). 녹색은 정리 노트 전용으로 남김
  codeBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 20, marginBottom: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.stroke,
    backgroundColor: colors.paper2,
  },
  codeBannerText: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.ink },
  codeBannerArrow: { fontFamily: fonts.mono, fontSize: 11, color: colors.ink3, letterSpacing: 0.5, textTransform: 'uppercase' },

  // 팁
  dragHint: {
    fontFamily: fonts.body, color: colors.accent, fontSize: 12,
    textAlign: 'center', paddingVertical: 6,
  },
  tipBox: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accentSoft,
    borderWidth: 1, borderColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 8,
    marginHorizontal: 20, marginBottom: 6,
  },
  tipText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 12, flex: 1 },
  tipBold: { color: colors.ink, fontWeight: '700' },

  // 리스트
  list: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 100 },

  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 6, paddingHorizontal: 4,
  },
  sectionLabel: { fontFamily: fonts.body, fontSize: 13, color: colors.ink },
  sectionMeta: { fontFamily: fonts.mono, fontSize: 11, color: colors.ink3 },

  // dashed wrap
  dashedWrap: {
    borderWidth: 1.5, borderColor: colors.strokeDashed, borderStyle: 'dashed',
    borderRadius: radius.md, padding: 6, backgroundColor: 'transparent',
  },
  dashedWrapHover: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  rowDivider: { height: 1, backgroundColor: colors.strokeSoft, marginHorizontal: 8 },

  // 폴더 카드
  folderCard: {
    borderWidth: 1.5, borderColor: colors.stroke,
    borderRadius: radius.md,
    backgroundColor: colors.paper,
    overflow: 'hidden',
  },
  folderCardHover: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  folderBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 12,
  },
  folderTitle: { fontFamily: fonts.body, fontSize: 15, color: colors.ink },
  folderMeta: { fontFamily: fonts.mono, fontSize: 11, color: colors.ink3, marginTop: 2 },
  folderBody: {
    paddingHorizontal: 6, paddingBottom: 6,
    borderTopWidth: 1, borderTopColor: colors.strokeSoft, borderStyle: 'dashed',
  },
  folderEmpty: {
    fontFamily: fonts.body, color: colors.ink3, fontSize: 12, fontStyle: 'italic',
    paddingVertical: 10, textAlign: 'center',
  },

  // 프로젝트 행
  projectRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'transparent',
    paddingHorizontal: 4, paddingVertical: 2,
  },
  projectBody: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 6,
  },
  projectIcon: {
    width: 36, height: 36, borderRadius: 10,
    borderWidth: 1.5, borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  projectTitle: { fontFamily: fonts.body, fontSize: 14, color: colors.ink },
  projectMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  folderTag: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.paper2,
  },
  folderTagText: { fontFamily: fonts.mono, fontSize: 10, color: colors.ink3 },
  projectMeta: { fontFamily: fonts.mono, fontSize: 10, color: colors.ink3, letterSpacing: 0.3, textTransform: 'uppercase' },

  // 드래그 ghost
  dragGhost: { position: 'absolute', left: 30, right: 30, top: 0, zIndex: 999 },
  dragGhostInner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    padding: 12,
    borderWidth: 1.5, borderColor: colors.accent,
  },
  dragGhostText: { fontFamily: fonts.body, color: colors.ink, fontSize: 14, flex: 1 },

  // 상단 액션
  topActions: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 20, paddingBottom: 8,
  },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.stroke,
    paddingVertical: 12,
    backgroundColor: colors.paper,
  },
  actionBtnPrimary: {
    backgroundColor: colors.accent, borderColor: colors.accent,
  },
  actionBtnText: { fontFamily: fonts.body, fontSize: 14, color: colors.ink },
  actionBtnTextPrimary: { color: colors.paper, fontWeight: '700' },

  // 빈 상태
  empty: { alignItems: 'center', marginTop: 50, gap: 8, paddingHorizontal: 32 },
  emptyText: { fontFamily: fonts.body, color: colors.ink, fontSize: 16 },
  emptySubText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  emptyCta: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 12, paddingHorizontal: 18, paddingVertical: 11,
    backgroundColor: colors.accent, borderRadius: radius.md,
  },
  emptyCtaText: { fontFamily: fonts.body, color: colors.paper, fontSize: 14, fontWeight: '700' },

  // 모달 공통
  overlay: { flex: 1, backgroundColor: 'rgba(21,23,28,0.55)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  modal: {
    backgroundColor: colors.paper, borderRadius: radius.lg, padding: 22, width: '100%', maxWidth: 380,
    borderWidth: 1.5, borderColor: colors.stroke,
  },
  modalTitle: { fontFamily: fonts.body, fontSize: 18, color: colors.ink, marginBottom: 6 },
  modalHint: { fontFamily: fonts.body, fontSize: 12, color: colors.ink2, marginBottom: 14, lineHeight: 18 },
  modalLabel: { fontFamily: fonts.body, fontSize: 12, color: colors.ink2, marginBottom: 6, marginTop: 4 },
  modalInput: {
    backgroundColor: colors.paper2, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontFamily: fonts.body, color: colors.ink, fontSize: 15,
    borderWidth: 1.5, borderColor: colors.strokeSoft, marginBottom: 12,
  },
  flowHintRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 14 },
  flowStep: { fontFamily: fonts.body, color: colors.ink2, fontSize: 12 },
  folderPicker: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.paper2, borderRadius: 10, padding: 12,
    borderWidth: 1.5, borderColor: colors.strokeSoft, marginBottom: 16,
  },
  folderPickerText: { fontFamily: fonts.body, color: colors.ink3, fontSize: 14, flex: 1 },
  modalBtns: { flexDirection: 'row', gap: 10 },
  cancelBtn: {
    flex: 1, padding: 12, borderRadius: 10,
    backgroundColor: colors.paper2, borderWidth: 1.5, borderColor: colors.stroke,
    alignItems: 'center',
  },
  cancelText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 14 },
  createBtn: {
    flex: 1, padding: 12, borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  createText: { fontFamily: fonts.body, color: colors.paper, fontSize: 14, fontWeight: '700' },

  // 메뉴 시트 (라이트 톤)
  menuSheet: {
    backgroundColor: colors.paper, borderRadius: radius.lg, width: '100%', maxWidth: 380,
    borderWidth: 1.5, borderColor: colors.stroke, overflow: 'hidden',
  },
  menuTitle: {
    fontFamily: fonts.body, color: colors.ink2, fontSize: 13,
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: colors.strokeSoft,
  },
  menuItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: colors.strokeSoft,
  },
  menuItemText: { fontFamily: fonts.body, fontSize: 14, color: colors.ink },
  menuCancel: { borderBottomWidth: 0, justifyContent: 'center', backgroundColor: colors.paper2 },
  menuCancelText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 14 },

  // 공유 시트
  shareSheet: {
    backgroundColor: colors.paper, borderRadius: radius.lg, padding: 22, width: '100%', maxWidth: 380,
    borderWidth: 1.5, borderColor: colors.stroke, alignItems: 'center',
  },
  shareIconBox: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.goodSoft, borderWidth: 1.5, borderColor: colors.good,
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
  },
  shareTitle: { fontFamily: fonts.body, fontSize: 18, color: colors.ink, marginBottom: 4 },
  shareHint: { fontFamily: fonts.body, fontSize: 12, color: colors.ink2, textAlign: 'center', marginBottom: 14 },

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

  // 받기
  redeemHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  redeemIconBox: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.goodSoft, borderWidth: 1.5, borderColor: colors.good,
    alignItems: 'center', justifyContent: 'center',
  },
  redeemInput: {
    backgroundColor: colors.paper2, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 14,
    fontFamily: fonts.mono, color: colors.good, fontSize: 22,
    textAlign: 'center', letterSpacing: 4,
    borderWidth: 1.5, borderColor: colors.good,
    marginBottom: 10,
  },
  redeemStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, marginBottom: 8 },
  redeemStatusText: { fontFamily: fonts.body, color: colors.ink2, fontSize: 13 },
  redeemPreview: {
    backgroundColor: colors.paper2, borderRadius: 10,
    padding: 12, marginBottom: 12,
    borderWidth: 1.5, borderColor: colors.good,
  },
  redeemPreviewTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 14, marginBottom: 4 },
  redeemPreviewMeta: { fontFamily: fonts.body, color: colors.ink2, fontSize: 12 },

  // notice sheet
  noticeSheet: {
    backgroundColor: colors.paper, borderRadius: radius.lg, padding: 22, width: '100%', maxWidth: 380,
    borderWidth: 1.5, borderColor: colors.stroke, alignItems: 'center',
  },
  noticeIconBox: {
    width: 60, height: 60, borderRadius: 30,
    borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginBottom: 14,
  },
  noticeTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 17, marginBottom: 6, textAlign: 'center' },
  noticeBody: { fontFamily: fonts.body, color: colors.ink2, fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 16 },
});
