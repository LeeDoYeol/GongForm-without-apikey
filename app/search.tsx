import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import {
  buildSearchIndex,
  matchesPrebuilt,
  decomposeKorean,
  SearchIndex,
} from '@/lib/koreanSearch';
import { colors, fonts, radius, screen } from '@/lib/theme';

type SearchKind = 'folder' | 'project' | 'shortform' | 'wrong' | 'note';
interface SearchHit {
  kind: SearchKind;
  id: string;            // 문서 id (kind에 따라 의미 다름)
  shortformId: string;   // 플레이어 진입에 쓰는 shortform id (folder/project는 빈 문자열)
  projectId: string | null;
  title: string;
  script: string;
  snippet: string;       // 매칭된 부분 발췌
}

const KIND_LABEL: Record<SearchKind, { label: string; color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  folder:    { label: '폴더',   color: '#7c3aed',         icon: 'folder-outline' },
  project:   { label: '프로젝트', color: '#ca8a04',         icon: 'layers-outline' },
  shortform: { label: '숏폼',   color: colors.accent,     icon: 'play-circle-outline' },
  wrong:     { label: '오답',   color: '#ea580c',         icon: 'close-circle-outline' },
  note:      { label: '노트',   color: colors.good,       icon: 'bookmark-outline' },
};

function makeSnippet(text: string, q: string, ctx = 30): string {
  if (!text || !q) return text?.slice(0, 80) ?? '';
  // 직접 부분일치 우선: 자모 분해 매칭으로 잡힌 경우 위치 계산이 어려우므로 앞부분으로 폴백
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 80) + (text.length > 80 ? '…' : '');
  const start = Math.max(0, idx - ctx);
  const end = Math.min(text.length, idx + q.length + ctx);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// 한 doc에서 검색용 인덱스를 미리 만들어둠: 매 키 입력마다 자모 분해 반복을 피하기 위함
interface IndexedDoc {
  id: string;
  raw: any;                  // 원본 doc
  title: string;             // 화면 표시용
  script: string;            // 화면 표시용
  titleIdx: SearchIndex;     // 사전 분해된 인덱스
  scriptIdx: SearchIndex;
}

function indexShortform(d: any): IndexedDoc {
  const title = d.content?.title ?? '';
  const script = d.content?.script ?? '';
  return { id: d.id, raw: d, title, script, titleIdx: buildSearchIndex(title), scriptIdx: buildSearchIndex(script) };
}
function indexFlatDoc(d: any): IndexedDoc {
  const title = d.title ?? '';
  const script = d.script ?? '';
  return { id: d.id, raw: d, title, script, titleIdx: buildSearchIndex(title), scriptIdx: buildSearchIndex(script) };
}

export default function SearchScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [allShortforms, setAllShortforms] = useState<IndexedDoc[]>([]);
  const [allWrongs, setAllWrongs] = useState<IndexedDoc[]>([]);
  const [allNotes, setAllNotes] = useState<IndexedDoc[]>([]);
  const [allProjects, setAllProjects] = useState<IndexedDoc[]>([]);
  const [allFolders, setAllFolders] = useState<IndexedDoc[]>([]);

  // 200ms 디바운스: 빠른 타이핑 중간 계산 스킵
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    Promise.all([
      getDocs(query(collection(db, 'shortforms'), where('userId', '==', user.uid))),
      getDocs(query(collection(db, 'wrongAnswers'), where('userId', '==', user.uid))),
      getDocs(query(collection(db, 'studyNotes'), where('userId', '==', user.uid))),
      getDocs(query(collection(db, 'projects'), where('userId', '==', user.uid))),
      getDocs(query(collection(db, 'folders'), where('userId', '==', user.uid))),
    ])
      .then(([sSnap, wSnap, nSnap, pSnap, fSnap]) => {
        // doc 로드 시점에 한 번만 자모 분해 → 키 입력마다 substring 비교만 하면 됨
        setAllShortforms(sSnap.docs.map((d) => indexShortform({ id: d.id, ...d.data() })));
        setAllWrongs(wSnap.docs.map((d) => indexFlatDoc({ id: d.id, ...d.data() })));
        setAllNotes(nSnap.docs.map((d) => indexFlatDoc({ id: d.id, ...d.data() })));
        // 폴더·프로젝트는 title만 검색, script 인덱스는 빈 인덱스
        setAllProjects(pSnap.docs.map((d) => indexFlatDoc({ id: d.id, title: d.data().title, ...d.data() })));
        setAllFolders(fSnap.docs.map((d) => indexFlatDoc({ id: d.id, title: d.data().title, ...d.data() })));
      })
      .finally(() => setLoading(false));
  }, [user]);

  const results: SearchHit[] = useMemo(() => {
    const queryStr = debouncedQ.trim();
    if (queryStr.length < 1) return [];
    // 쿼리도 한 번만 정규화·분해
    const queryLower = queryStr.toLowerCase().replace(/\s+/g, '');
    const queryDecomposed = decomposeKorean(queryLower);
    const titleHit = (d: IndexedDoc) => matchesPrebuilt(d.titleIdx, queryLower, queryDecomposed);
    const docHit = (d: IndexedDoc) => titleHit(d) || matchesPrebuilt(d.scriptIdx, queryLower, queryDecomposed);

    const hits: SearchHit[] = [];
    // 폴더: 제목만 검색
    for (const f of allFolders) {
      if (!titleHit(f)) continue;
      hits.push({
        kind: 'folder',
        id: f.id,
        shortformId: '',
        projectId: null,
        title: f.title,
        script: '',
        snippet: '폴더',
      });
    }
    // 프로젝트: 제목만 검색
    for (const p of allProjects) {
      if (!titleHit(p)) continue;
      hits.push({
        kind: 'project',
        id: p.id,
        shortformId: '',
        projectId: p.id,
        title: p.title,
        script: '',
        snippet: '프로젝트',
      });
    }
    for (const sf of allShortforms) {
      if (!docHit(sf)) continue;
      hits.push({
        kind: 'shortform',
        id: sf.id,
        shortformId: sf.id,
        projectId: sf.raw.projectId ?? null,
        title: sf.title,
        script: sf.script,
        snippet: makeSnippet(titleHit(sf) ? sf.title : sf.script, queryStr),
      });
    }
    for (const w of allWrongs) {
      if (!docHit(w)) continue;
      hits.push({
        kind: 'wrong',
        id: w.id,
        shortformId: w.raw.shortformId,
        projectId: w.raw.projectId ?? null,
        title: w.title,
        script: w.script,
        snippet: makeSnippet(titleHit(w) ? w.title : w.script, queryStr),
      });
    }
    for (const n of allNotes) {
      if (!docHit(n)) continue;
      hits.push({
        kind: 'note',
        id: n.id,
        shortformId: n.raw.shortformId,
        projectId: n.raw.projectId ?? null,
        title: n.title,
        script: n.script,
        snippet: makeSnippet(titleHit(n) ? n.title : n.script, queryStr),
      });
    }
    return hits;
  }, [debouncedQ, allShortforms, allWrongs, allNotes, allProjects, allFolders]);

  const openHit = useCallback((hit: SearchHit) => {
    if (hit.kind === 'folder') {
      router.push({ pathname: '/folder/[id]', params: { id: hit.id } });
      return;
    }
    if (hit.kind === 'project') {
      router.push({ pathname: '/project/[id]', params: { id: hit.id } });
      return;
    }
    router.push({
      pathname: '/player/[id]',
      params: {
        id: hit.projectId || 'search',
        shortformId: hit.shortformId,
        ids: hit.shortformId, // 단일 항목만 로드 (검색 결과는 individual jump)
      },
    });
  }, [router]);

  const renderItem = ({ item }: { item: SearchHit }) => {
    const k = KIND_LABEL[item.kind];
    return (
      <TouchableOpacity style={styles.card} onPress={() => openHit(item)} activeOpacity={0.85}>
        <View style={[styles.kindTag, { backgroundColor: k.color + '22', borderColor: k.color + '60' }]}>
          <Ionicons name={k.icon} size={12} color={k.color} />
          <Text style={[styles.kindTagText, { color: k.color }]}>{k.label}</Text>
        </View>
        <Text style={styles.cardTitle} numberOfLines={2}>{item.title || '(제목 없음)'}</Text>
        <Text style={styles.cardSnippet} numberOfLines={2}>{item.snippet}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
          style={styles.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="arrow-back" size={22} color={colors.ink} />
        </TouchableOpacity>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={colors.ink3} />
          <TextInput
            style={styles.input}
            value={q}
            onChangeText={setQ}
            placeholder="폴더·프로젝트·숏폼·오답·노트 검색"
            placeholderTextColor={colors.ink4}
            autoFocus
            returnKeyType="search"
          />
          {q.length > 0 && (
            <TouchableOpacity onPress={() => setQ('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.ink4} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      ) : q.trim().length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="search" size={48} color={colors.ink4} />
          <Text style={styles.emptyTitle}>검색어를 입력하세요</Text>
          <Text style={styles.emptySub}>폴더·프로젝트·숏폼·오답·정리 노트를 모두 통합 검색합니다</Text>
        </View>
      ) : results.length === 0 && q.trim() === debouncedQ.trim() ? (
        <View style={styles.empty}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.ink4} />
          <Text style={styles.emptyTitle}>결과 없음</Text>
          <Text style={styles.emptySub}>다른 키워드로 검색해 보세요</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => `${item.kind}_${item.id}`}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <Text style={styles.resultCount}>{results.length}개 결과</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.strokeSoft,
  },
  backBtn: { padding: 4 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.paper2,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.strokeSoft,
  },
  input: { flex: 1, fontFamily: fonts.body, color: colors.ink, fontSize: 15, padding: 0 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 16, marginTop: 12 },
  emptySub: { fontFamily: fonts.body, color: colors.ink2, fontSize: 13, marginTop: 6, textAlign: 'center' },

  resultCount: { fontFamily: fonts.mono, color: colors.ink3, fontSize: 12, marginBottom: 8 },

  card: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.stroke,
    padding: 14,
    gap: 8,
  },
  kindTag: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  kindTagText: { fontFamily: fonts.body, fontSize: 11, fontWeight: '700' },
  cardTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 15 },
  cardSnippet: { fontFamily: fonts.body, color: colors.ink2, fontSize: 13, lineHeight: 18 },
});
