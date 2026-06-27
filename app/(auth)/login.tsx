import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { Link } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { colors, fonts, radius, text as t, screen } from '@/lib/theme';
import { Box, Btn, Hr } from '@/components/wf';

export default function LoginScreen() {
  const { login, resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Firebase는 기본적으로 로그인을 영속화, 토글은 UX 표시용. 끄기는 별도 인프라 필요.
  const [autoLogin, setAutoLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  // 비밀번호 찾기
  const [resetOpen, setResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState<{ kind: 'ok' | 'err'; body: string } | null>(null);

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert('오류', '이메일과 비밀번호를 입력해주세요.');
      return;
    }
    setLoading(true);
    try {
      await login(email.trim(), password);
    } catch (e: any) {
      Alert.alert('로그인 실패', e.message || '이메일 또는 비밀번호를 확인해주세요.');
    } finally {
      setLoading(false);
    }
  };

  const openReset = () => {
    setResetEmail(email.trim());
    setResetMsg(null);
    setResetOpen(true);
  };

  const doReset = async () => {
    const e = resetEmail.trim();
    if (!e) { setResetMsg({ kind: 'err', body: '이메일을 입력해주세요.' }); return; }
    setResetBusy(true);
    setResetMsg(null);
    try {
      await resetPassword(e);
      setResetMsg({ kind: 'ok', body: `비밀번호 재설정 메일을 ${e}로 보냈어요. 메일함을 확인해주세요.` });
    } catch (err: any) {
      setResetMsg({ kind: 'err', body: err?.message ?? '메일 전송에 실패했어요.' });
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <SafeAreaView style={screen.light}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.inner}>
          {/* 로고 + 부제 */}
          <View style={styles.hero}>
            <Text style={styles.logo}>공폼</Text>
            <Text style={styles.heroSub}>다시 만나서 반가워요</Text>
          </View>

          {/* 이메일 */}
          <Text style={[t.meta, styles.label]}>이메일</Text>
          <Box style={styles.field}>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={colors.ink4}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Box>

          {/* 비밀번호 + 보기 토글 */}
          <Text style={[t.meta, styles.label]}>비밀번호</Text>
          <Box style={[styles.field, styles.fieldRow]}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="••••••••"
              placeholderTextColor={colors.ink4}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity onPress={() => setShowPassword((s) => !s)} hitSlop={8}>
              <Ionicons
                name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color={colors.ink3}
              />
            </TouchableOpacity>
          </Box>

          {/* 자동 로그인 + 비밀번호 찾기 */}
          <View style={styles.row}>
            <TouchableOpacity style={styles.checkRow} onPress={() => setAutoLogin((s) => !s)}>
              <View style={[styles.checkbox, autoLogin && styles.checkboxOn]}>
                {autoLogin && <Ionicons name="checkmark" size={12} color={colors.paper} />}
              </View>
              <Text style={styles.checkLabel}>자동 로그인</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={openReset}>
              <Text style={styles.linkAccent}>비밀번호 찾기</Text>
            </TouchableOpacity>
          </View>

          {/* 로그인 버튼 */}
          <Btn primary lg full onPress={handleLogin} loading={loading} style={{ marginTop: 22 }}>
            로그인
          </Btn>

          {/* "또는" 구분선: 소셜 로그인 placeholder */}
          <View style={styles.dividerRow}>
            <Hr style={{ flex: 1 }} thin />
            <Text style={[t.meta, t.muted]}>또는</Text>
            <Hr style={{ flex: 1 }} thin />
          </View>
          <Text style={styles.soonText}>Google · Apple 로그인은 곧 지원돼요</Text>

          {/* 가입 링크 */}
          <View style={styles.signupRow}>
            <Text style={styles.signupText}>처음이세요? </Text>
            <Link href="/(auth)/register" asChild>
              <TouchableOpacity>
                <Text style={styles.linkAccent}>가입하기 →</Text>
              </TouchableOpacity>
            </Link>
          </View>

          {/* 약관 안내 footer */}
          <Text style={styles.footer}>
            계속하면 공폼의 이용약관과{'\n'}개인정보처리방침에 동의하게 됩니다
          </Text>
        </View>
      </KeyboardAvoidingView>

      {/* 비밀번호 재설정 모달 */}
      <Modal visible={resetOpen} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>비밀번호 찾기</Text>
            <Text style={styles.sheetHint}>가입한 이메일을 입력하면 재설정 링크를 보내드려요.</Text>
            <Box style={styles.field}>
              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor={colors.ink4}
                value={resetEmail}
                onChangeText={setResetEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Box>
            {resetMsg && (
              <Text style={[styles.resetMsg, { color: resetMsg.kind === 'ok' ? colors.good : colors.bad }]}>
                {resetMsg.body}
              </Text>
            )}
            <View style={styles.sheetBtns}>
              <Btn onPress={() => setResetOpen(false)} style={{ flex: 1 }}>
                {resetMsg?.kind === 'ok' ? '닫기' : '취소'}
              </Btn>
              {resetMsg?.kind !== 'ok' && (
                <Btn primary onPress={doReset} loading={resetBusy} style={{ flex: 1 }}>
                  보내기
                </Btn>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  inner: { flex: 1, paddingHorizontal: 22, justifyContent: 'center' },

  hero: { alignItems: 'center', marginBottom: 28 },
  logo: {
    fontFamily: fonts.display,
    fontSize: 64,
    lineHeight: 62,
    color: colors.accent,
  },
  heroSub: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.ink3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 6,
  },

  label: { marginBottom: 6, marginLeft: 4 },
  field: { paddingHorizontal: 14, paddingVertical: 4, marginBottom: 12 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.ink,
    paddingVertical: 10,
  },

  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkbox: {
    width: 18, height: 18, borderRadius: 4,
    borderWidth: 1.5, borderColor: colors.stroke,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkLabel: { fontFamily: fonts.body, fontSize: 13, color: colors.ink },
  linkAccent: { fontFamily: fonts.body, fontSize: 13, color: colors.accent },

  dividerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginTop: 22, marginBottom: 6,
  },
  soonText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.ink3,
    textAlign: 'center',
    marginBottom: 18,
  },

  signupRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  signupText: { fontFamily: fonts.body, fontSize: 14, color: colors.ink3 },

  footer: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.ink3,
    textAlign: 'center',
    lineHeight: 16,
    marginTop: 24,
  },

  // 비밀번호 찾기 모달
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(21,23,28,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  sheet: {
    width: '100%', maxWidth: 380,
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.stroke,
    padding: 22,
  },
  sheetTitle: { fontFamily: fonts.body, fontSize: 20, color: colors.ink, marginBottom: 6 },
  sheetHint: { fontFamily: fonts.body, fontSize: 13, color: colors.ink2, marginBottom: 14, lineHeight: 18 },
  sheetBtns: { flexDirection: 'row', gap: 8, marginTop: 6 },
  resetMsg: { fontFamily: fonts.body, fontSize: 13, marginBottom: 10, lineHeight: 18 },
});
