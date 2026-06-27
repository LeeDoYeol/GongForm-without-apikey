import { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { colors } from '@/lib/theme';

export default function CollectionScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [noteCount, setNoteCount] = useState(0);
  const [wrongCount, setWrongCount] = useState(0);

  useFocusEffect(
    useCallback(() => {
      if (!user) return;
      Promise.all([
        getDocs(query(collection(db, 'studyNotes'), where('userId', '==', user.uid))),
        getDocs(query(collection(db, 'wrongAnswers'), where('userId', '==', user.uid))),
      ]).then(([notes, wrongs]) => {
        setNoteCount(notes.size);
        setWrongCount(wrongs.size);
      });
    }, [user])
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>컬렉션</Text>
        <Text style={styles.headerSub}>저장한 학습 자료</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {noteCount === 0 && wrongCount === 0 && (
          <View style={styles.emptyHero}>
            <Ionicons name="bookmark-outline" size={36} color="#4F8EF7" />
            <Text style={styles.emptyHeroTitle}>아직 저장된 자료가 없어요</Text>
            <Text style={styles.emptyHeroSub}>
              쇼츠를 보다가 북마크하면 정리 노트로,{'\n'}OX 퀴즈를 틀리면 오답노트로 자동 저장돼요
            </Text>
            <TouchableOpacity
              style={styles.emptyHeroBtn}
              onPress={() => router.push('/(tabs)/folders')}
            >
              <Ionicons name="play" size={14} color="#fff" />
              <Text style={styles.emptyHeroBtnText}>프로젝트로 이동</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* AI 질의응답 */}
        <TouchableOpacity
          style={styles.aiCard}
          onPress={() => router.push('/ai-chat')}
        >
          <View style={styles.aiIconBox}>
            <Ionicons name="sparkles" size={28} color="#4F8EF7" />
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.aiCardTitle}>AI 질의응답</Text>
            <Text style={styles.cardSub}>모르는 내용을 바로 질문해보세요</Text>
          </View>
          <View style={styles.aiArrow}>
            <Ionicons name="chevron-forward" size={18} color="#4F8EF7" />
          </View>
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>저장한 노트</Text>

        {/* 정리 노트 */}
        <TouchableOpacity
          style={styles.card}
          onPress={() => router.push('/study-notes')}
        >
          <View style={[styles.iconBox, { backgroundColor: colors.noteSoft }]}>
            <Ionicons name="bookmark" size={26} color={colors.note} />
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.cardTitle}>나의 정리 노트</Text>
            <Text style={styles.cardSub}>저장한 개념 · 유사 문제 생성</Text>
          </View>
          <View style={styles.countBadge}>
            <Text style={[styles.countText, { color: colors.note }]}>{noteCount}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#333" />
        </TouchableOpacity>

        {/* 오답노트 */}
        <TouchableOpacity
          style={styles.card}
          onPress={() => router.push('/wrong-answers')}
        >
          <View style={[styles.iconBox, { backgroundColor: '#F9731618' }]}>
            <Ionicons name="journal" size={26} color="#F97316" />
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.cardTitle}>오답노트</Text>
            <Text style={styles.cardSub}>틀린 OX 퀴즈 · 유사 문제 생성</Text>
          </View>
          <View style={styles.countBadge}>
            <Text style={[styles.countText, { color: '#F97316' }]}>{wrongCount}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#333" />
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>학습 도구</Text>

        {/* 셔플 재생 */}
        <TouchableOpacity
          style={styles.card}
          onPress={() =>
            router.push({
              pathname: '/player/[id]',
              params: { id: '__all__', startIndex: 0, shuffle: '1' },
            })
          }
        >
          <View style={[styles.iconBox, { backgroundColor: '#22C55E18' }]}>
            <Ionicons name="shuffle" size={26} color="#22C55E" />
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.cardTitle}>맞춤 셔플 학습</Text>
            <Text style={styles.cardSub}>폴더·프로젝트와 중요도를 골라 시작</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#333" />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D0D' },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#fff' },
  headerSub: { fontSize: 13, color: '#666', marginTop: 4 },

  scroll: { paddingHorizontal: 16, paddingBottom: 40 },

  sectionTitle: {
    fontSize: 13, fontWeight: '700', color: '#666',
    marginBottom: 8, marginTop: 20, paddingLeft: 2,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },

  aiCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A2944',
    borderRadius: 16,
    padding: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#4F8EF740',
    gap: 14,
  },
  aiIconBox: {
    width: 52, height: 52, borderRadius: 16,
    backgroundColor: '#4F8EF718', justifyContent: 'center', alignItems: 'center',
  },
  aiCardTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  aiArrow: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#4F8EF720', justifyContent: 'center', alignItems: 'center',
  },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    gap: 12,
  },
  iconBox: {
    width: 48, height: 48, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
  },
  cardInfo: { flex: 1 },
  cardTitle: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 3 },
  cardSub: { color: '#666', fontSize: 12 },
  countBadge: {
    paddingHorizontal: 10, paddingVertical: 4,
    backgroundColor: '#111', borderRadius: 10,
    borderWidth: 1, borderColor: '#2A2A2A',
    minWidth: 36, alignItems: 'center',
  },
  countText: { fontSize: 15, fontWeight: '800' },

  emptyHero: {
    backgroundColor: '#1A1A1A',
    borderRadius: 18,
    padding: 22,
    alignItems: 'center',
    marginBottom: 12,
    borderWidth: 1, borderColor: '#2A2A2A',
    gap: 10,
  },
  emptyHeroTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  emptyHeroSub: { color: '#888', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  emptyHeroBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 6,
    paddingHorizontal: 16, paddingVertical: 9,
    backgroundColor: '#4F8EF7', borderRadius: 10,
  },
  emptyHeroBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
