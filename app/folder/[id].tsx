import { useState, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  TextInput,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  getDoc,
  addDoc,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';

interface Project {
  id: string;
  title: string;
  folderId: string | null;
  createdAt: any;
}

export default function FolderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const [folderTitle, setFolderTitle] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [shortformCounts, setShortformCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const [modal, setModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    getDoc(doc(db, 'folders', id)).then((d) => {
      if (d.exists()) setFolderTitle(d.data().title);
    });

    const unsub = onSnapshot(
      query(collection(db, 'projects'), where('folderId', '==', id)),
      (snap) => {
        setProjects(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() } as Project))
            .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0))
        );
        setLoading(false);
      }
    );

    return () => unsub();
  }, [id]);

  useEffect(() => {
    if (!user || projects.length === 0) return;
    const unsub = onSnapshot(
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
    return () => unsub();
  }, [user, projects.length]);

  const createProject = async () => {
    setCreateError(null);
    if (!newTitle.trim()) { setCreateError('프로젝트 이름을 입력해주세요.'); return; }
    setCreating(true);
    try {
      const title = newTitle.trim();
      // 같은 이름의 프로젝트가 이미 있는지: 전체 사용자 프로젝트 기준
      const dup = await getDocs(query(
        collection(db, 'projects'),
        where('userId', '==', user!.uid),
      ));
      const lower = title.toLowerCase();
      if (dup.docs.some((d) => ((d.data() as any).title ?? '').trim().toLowerCase() === lower)) {
        setCreateError('같은 이름의 프로젝트가 이미 있어요. 다른 이름을 사용해주세요.');
        setCreating(false);
        return;
      }
      const ref = await addDoc(collection(db, 'projects'), {
        userId: user!.uid,
        title,
        folderId: id,
        order: 0,
        createdAt: serverTimestamp(),
      });
      setNewTitle('');
      setModal(false);
      router.push({
        pathname: '/upload/[projectId]',
        params: { projectId: ref.id, projectTitle: title },
      });
    } catch {
      Alert.alert('오류', '프로젝트 생성에 실패했습니다.');
    } finally {
      setCreating(false);
    }
  };

  const renderItem = ({ item }: { item: Project }) => {
    const count = shortformCounts[item.id] ?? 0;
    return (
      <TouchableOpacity
        style={styles.projectCard}
        onPress={() => router.push({ pathname: '/project/[id]', params: { id: item.id } })}
      >
        <View style={styles.projectIcon}>
          <Ionicons name="layers" size={22} color="#4F8EF7" />
        </View>
        <View style={styles.projectInfo}>
          <Text style={styles.projectTitle} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.projectMeta}>
            {count > 0 ? `숏폼 ${count}개` : '숏폼 없음'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="#333" />
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
          <Text style={styles.headerTitle} numberOfLines={1}>📁 {folderTitle}</Text>
          <Text style={styles.headerSub}>이 폴더의 프로젝트 {projects.length}개</Text>
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => setModal(true)}
        >
          <Ionicons name="add" size={16} color="#fff" />
          <Text style={styles.addBtnText}>프로젝트</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color="#4F8EF7" style={{ marginTop: 40 }} />
      ) : projects.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="layers-outline" size={56} color="#333" />
          <Text style={styles.emptyText}>프로젝트가 없습니다</Text>
          <Text style={styles.emptySubText}>이 폴더에 첫 프로젝트를 만들어보세요</Text>
          <TouchableOpacity style={styles.emptyCreateBtn} onPress={() => setModal(true)}>
            <Ionicons name="add-circle-outline" size={18} color="#fff" />
            <Text style={styles.emptyCreateBtnText}>프로젝트 만들기</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
        />
      )}

      <Modal visible={modal} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>새 프로젝트</Text>
            <Text style={styles.modalHint}>📁 {folderTitle} 폴더에 추가됩니다</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="프로젝트 이름 (예: 2단원 세포의 구조)"
              placeholderTextColor="#555"
              value={newTitle}
              onChangeText={(t) => { setNewTitle(t); if (createError) setCreateError(null); }}
              autoFocus
            />
            {createError && (
              <Text style={styles.modalErrorText}>{createError}</Text>
            )}
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => { setModal(false); setNewTitle(''); setCreateError(null); }}
              >
                <Text style={styles.cancelText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.createBtn} onPress={createProject} disabled={creating}>
                {creating ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="add" size={16} color="#fff" />
                    <Text style={styles.createText}>만들기</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
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
    gap: 10,
  },
  backBtn: { padding: 4 },
  headerCenter: { flex: 1 },
  headerTitle: { fontSize: 17, fontWeight: '700', color: '#fff' },
  headerSub: { fontSize: 12, color: '#666', marginTop: 2 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#4F8EF7',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  addBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  list: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },

  projectCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  projectIcon: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: '#1D2A44', justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  projectInfo: { flex: 1 },
  projectTitle: { fontSize: 15, fontWeight: '600', color: '#fff', marginBottom: 3 },
  projectMeta: { fontSize: 12, color: '#666' },

  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, paddingHorizontal: 32 },
  emptyText: { color: '#555', fontSize: 16, fontWeight: '600' },
  emptySubText: { color: '#444', fontSize: 13, textAlign: 'center' },
  emptyCreateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#4F8EF7',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginTop: 8,
    gap: 8,
  },
  emptyCreateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center', alignItems: 'center',
  },
  modal: {
    backgroundColor: '#1A1A1A', borderRadius: 20, padding: 24, width: '85%',
    borderWidth: 1, borderColor: '#2A2A2A',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 6 },
  modalHint: { fontSize: 12, color: '#4F8EF7', marginBottom: 14 },
  modalInput: {
    backgroundColor: '#0D0D0D', borderRadius: 10, padding: 14,
    color: '#fff', fontSize: 15, borderWidth: 1, borderColor: '#2A2A2A', marginBottom: 16,
  },
  modalErrorText: { color: '#EF4444', fontSize: 12, fontWeight: '600', marginTop: -8, marginBottom: 12 },
  modalButtons: { flexDirection: 'row', gap: 10 },
  cancelBtn: { flex: 1, padding: 14, borderRadius: 10, backgroundColor: '#2A2A2A', alignItems: 'center' },
  cancelText: { color: '#888', fontWeight: '600' },
  createBtn: {
    flex: 1, padding: 14, borderRadius: 10, backgroundColor: '#4F8EF7',
    alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  createText: { color: '#fff', fontWeight: '700' },
});
