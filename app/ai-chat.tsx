import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { askAIStream, ChatMessage } from '@/lib/gemini';

export default function AIChatScreen() {
  const { context, contextTitle, backPath } = useLocalSearchParams<{
    context?: string;
    contextTitle?: string;
    backPath?: string;
  }>();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  // streaming 첫 토큰 도착 전엔 typing indicator 표시. 토큰 흐르기 시작하면 false.
  const [awaitingFirstToken, setAwaitingFirstToken] = useState(false);
  const listRef = useRef<FlatList>(null);
  // 진행 중인 stream을 abort하기 위한 controller: 새 질문/언마운트 시 끊음.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // 컨텍스트가 있으면 안내 메시지 표시
  const introText = contextTitle
    ? `"${contextTitle}" 내용에 대해 궁금한 점을 물어보세요!`
    : '학습 중 궁금한 점을 자유롭게 질문해보세요!';

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput('');

    // 진행 중 stream 있으면 끊고 새로 시작
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // 사용자 메시지만 먼저 추가. assistant 메시지는 첫 토큰 도착 시점에 push (빈 버블 안 보이게).
    const history = messages;
    setMessages((prev) => [...prev, { role: 'user', text: q }]);
    setLoading(true);
    setAwaitingFirstToken(true);

    try {
      // 쇼츠에서 진입한 경우(context 존재)에는 매 질문마다 system 프롬프트에 쇼츠 내용을 포함.
      const contextPayload = context
        ? (contextTitle ? `[제목] ${contextTitle}\n\n${context}` : context)
        : undefined;
      await askAIStream(q, history, contextPayload, (delta) => {
        setAwaitingFirstToken(false);
        setMessages((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'model') {
            next[next.length - 1] = { ...last, text: last.text + delta };
          } else {
            next.push({ role: 'model', text: delta });
          }
          return next;
        });
      }, controller.signal);
    } catch (e: any) {
      // 사용자가 새 질문으로 abort한 경우엔 조용히 종료
      if (controller.signal.aborted) return;
      setMessages((prev) => [
        ...prev,
        { role: 'model', text: `오류: ${e?.message ?? '답변 생성 실패'}` },
      ]);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
      setAwaitingFirstToken(false);
    }
  }, [input, loading, messages, context, contextTitle]);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages]);

  const renderItem = ({ item }: { item: ChatMessage }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}>
        {!isUser && (
          <View style={styles.aiIcon}>
            <Ionicons name="sparkles" size={14} color="#4F8EF7" />
          </View>
        )}
        <View style={[styles.bubbleInner, isUser ? styles.bubbleInnerUser : styles.bubbleInnerAI]}>
          {isUser ? (
            <Text style={[styles.bubbleText, styles.bubbleTextUser]}>{item.text}</Text>
          ) : (
            // assistant 메시지는 마크다운 렌더링 (헤더·리스트·강조·표·코드블록).
            // 스트리밍 중 partial 마크다운(닫히지 않은 ** 등)도 라이브러리가 안전하게 처리.
            <Markdown style={markdownStyles}>{item.text || ' '}</Markdown>
          )}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            // 모달 presentation이면 dismiss, 일반 push면 back, 둘 다 안 되면 (새로고침 직후 등) 홈으로 replace.
            // 새로고침 / 딥링크로 진입 시 canDismiss/canGoBack 둘 다 false → replace로 갇히지 않게 보장.
            try {
              const r: any = router;
              if (typeof r.canDismiss === 'function' && r.canDismiss()) {
                r.dismiss();
                return;
              }
            } catch {}
            if (router.canGoBack()) {
              router.back();
              return;
            }
            // 새로고침/딥링크 진입: 들어올 때 받은 backPath로 폴백, 그것도 없으면 홈으로
            if (backPath) {
              router.replace(backPath as any);
              return;
            }
            router.replace('/(tabs)');
          }}
          style={styles.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>AI 질의응답</Text>
          {contextTitle ? (
            <Text style={styles.headerSub} numberOfLines={1}>{contextTitle}</Text>
          ) : null}
        </View>
        <TouchableOpacity
          style={styles.clearBtn}
          onPress={() => setMessages([])}
          disabled={messages.length === 0}
        >
          <Ionicons name="refresh-outline" size={20} color={messages.length === 0 ? '#333' : '#888'} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(_, i) => String(i)}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={styles.introBubble}>
              <Ionicons name="sparkles" size={16} color="#4F8EF7" />
              <Text style={styles.introText}>{introText}</Text>
            </View>
          }
          ListFooterComponent={
            // 첫 토큰 도착 전까지만 typing indicator 표시. 도착 후엔 빈 assistant 버블에 텍스트가 흐름.
            awaitingFirstToken ? (
              <View style={styles.typingRow}>
                <View style={styles.aiIcon}>
                  <Ionicons name="sparkles" size={14} color="#4F8EF7" />
                </View>
                <View style={styles.typingBubble}>
                  <ActivityIndicator size="small" color="#4F8EF7" />
                  <Text style={styles.typingText}>답변 생성 중...</Text>
                </View>
              </View>
            ) : null
          }
        />

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="질문을 입력하세요..."
            placeholderTextColor="#555"
            multiline
            maxLength={500}
            onSubmitEditing={send}
            returnKeyType="send"
            onKeyPress={(e: any) => {
              // 웹: Enter로 전송, Shift+Enter는 줄바꿈
              if (Platform.OS !== 'web') return;
              if (e.nativeEvent?.key !== 'Enter' || e.nativeEvent?.shiftKey) return;
              // 한국어 IME 조합 중 Enter는 글자 commit 용도. 이 시점에 send하면
              // 마지막 조합 글자가 onChange로 늦게 들어와 input에 남는 버그가 생김 → 무시.
              // 다음 Enter(조합 끝난 후)에 정상 전송.
              const isComposing = e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229;
              if (isComposing) return;
              e.preventDefault?.();
              send();
            }}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!input.trim() || loading) && styles.sendBtnDisabled]}
            onPress={send}
            disabled={!input.trim() || loading}
          >
            <Ionicons name="send" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// 마크다운 다크 테마. react-native-markdown-display는 노드 타입별 style key 사용.
const markdownStyles = StyleSheet.create({
  body: { color: '#ddd', fontSize: 14, lineHeight: 21 },
  heading1: { color: '#fff', fontSize: 18, fontWeight: '800', marginTop: 8, marginBottom: 6 },
  heading2: { color: '#fff', fontSize: 16, fontWeight: '700', marginTop: 6, marginBottom: 4 },
  heading3: { color: '#fff', fontSize: 15, fontWeight: '700', marginTop: 4, marginBottom: 4 },
  strong: { color: '#fff', fontWeight: '800' },
  em: { color: '#ddd', fontStyle: 'italic' },
  bullet_list: { marginVertical: 2 },
  ordered_list: { marginVertical: 2 },
  list_item: { color: '#ddd', marginVertical: 1 },
  paragraph: { color: '#ddd', marginTop: 2, marginBottom: 6 },
  code_inline: {
    color: '#FBBF24', backgroundColor: '#0D0D0D',
    paddingHorizontal: 4, borderRadius: 4, fontFamily: 'Menlo',
  },
  code_block: {
    color: '#eee', backgroundColor: '#0D0D0D',
    padding: 10, borderRadius: 8, fontFamily: 'Menlo', fontSize: 12,
    borderWidth: 1, borderColor: '#2A2A2A', marginVertical: 4,
  },
  fence: {
    color: '#eee', backgroundColor: '#0D0D0D',
    padding: 10, borderRadius: 8, fontFamily: 'Menlo', fontSize: 12,
    borderWidth: 1, borderColor: '#2A2A2A', marginVertical: 4,
  },
  blockquote: {
    color: '#aaa', backgroundColor: '#0D0D0D',
    borderLeftWidth: 3, borderLeftColor: '#4F8EF7',
    paddingHorizontal: 10, paddingVertical: 6, marginVertical: 4,
  },
  hr: { backgroundColor: '#2A2A2A', height: 1, marginVertical: 8 },
  table: { borderWidth: 1, borderColor: '#2A2A2A', borderRadius: 6, marginVertical: 4 },
  thead: { backgroundColor: '#1F1F1F' },
  th: { color: '#fff', padding: 6, fontWeight: '700' },
  td: { color: '#ddd', padding: 6, borderTopWidth: 1, borderTopColor: '#2A2A2A' },
  link: { color: '#4F8EF7', textDecorationLine: 'underline' },
});

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
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  headerSub: { color: '#4F8EF7', fontSize: 12, marginTop: 2 },
  clearBtn: { padding: 4 },

  listContent: { padding: 16, paddingBottom: 8, gap: 12 },

  introBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1D2A44',
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#4F8EF730',
  },
  introText: { color: '#aaa', fontSize: 13, flex: 1, lineHeight: 20 },

  bubble: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  bubbleUser: { justifyContent: 'flex-end' },
  bubbleAI: { justifyContent: 'flex-start' },
  aiIcon: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#1D2A44', justifyContent: 'center', alignItems: 'center',
    marginBottom: 2,
  },
  bubbleInner: { maxWidth: '78%', borderRadius: 16, padding: 12 },
  bubbleInnerUser: { backgroundColor: '#4F8EF7', borderBottomRightRadius: 4 },
  bubbleInnerAI: { backgroundColor: '#1A1A1A', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#2A2A2A' },
  bubbleText: { fontSize: 14, lineHeight: 21 },
  bubbleTextUser: { color: '#fff' },
  bubbleTextAI: { color: '#ddd' },

  typingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  typingBubble: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1A1A1A', borderRadius: 16, padding: 12,
    borderWidth: 1, borderColor: '#2A2A2A',
  },
  typingText: { color: '#666', fontSize: 13 },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#1A1A1A',
  },
  input: {
    flex: 1,
    backgroundColor: '#1A1A1A',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    maxHeight: 120,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#4F8EF7', justifyContent: 'center', alignItems: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#1D2A44' },
});
