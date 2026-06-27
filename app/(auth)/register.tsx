import { useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ScrollView,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { colors, fonts, text as t, screen } from '@/lib/theme';
import { Box, Btn } from '@/components/wf';
import { markNeedsFirstSetup } from '@/lib/onboardingFlag';

// 비밀번호 강도: 0..4 (4단 게이지). 길이·문자종류 기반.
function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(4, score);
}

// 간단 이메일 정규식: 디자인의 ✓ 마크 표시용
function isEmailValid(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export default function RegisterScreen() {
  const { register } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  // 약관 동의
  const [agreeAge, setAgreeAge] = useState(false);    // 필수
  const [agreeTos, setAgreeTos] = useState(false);    // 필수
  const [termsOpen, setTermsOpen] = useState(false);

  const strength = useMemo(() => passwordStrength(password), [password]);
  const emailValid = useMemo(() => isEmailValid(email), [email]);
  const canSubmit = agreeAge && agreeTos && !loading;

  const handleRegister = async () => {
    if (!email || !password || !confirm) {
      Alert.alert('오류', '모든 필드를 입력해주세요.');
      return;
    }
    if (password !== confirm) {
      Alert.alert('오류', '비밀번호가 일치하지 않습니다.');
      return;
    }
    if (password.length < 8) {
      Alert.alert('오류', '비밀번호는 8자 이상이어야 합니다.');
      return;
    }
    if (!agreeAge || !agreeTos) {
      Alert.alert('오류', '필수 약관에 동의해주세요.');
      return;
    }
    setLoading(true);
    try {
      // 가입 직후 첫 설정(B) 표시를 위해 플래그를 먼저 set, onAuthStateChanged가 발화하면
      // RootNavigator가 이 플래그를 보고 /onboarding/setup으로 라우팅한다.
      await markNeedsFirstSetup();
      await register(email.trim(), password, displayName.trim() || undefined);
    } catch (e: any) {
      Alert.alert('회원가입 실패', e.message || '다시 시도해주세요.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={screen.light}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {/* 헤더 */}
          <View style={styles.header}>
            <TouchableOpacity
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/(auth)/login'))}
              hitSlop={8}
            >
              <Ionicons name="arrow-back" size={22} color={colors.ink} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>이메일로 가입</Text>
            <View style={{ width: 22 }} />
          </View>

          <Text style={styles.h1}>계정 만들기</Text>
          <Text style={styles.h1Sub}>30초면 끝나요</Text>

          {/* 이름/닉네임 */}
          <Text style={[t.meta, styles.label]}>이름 / 닉네임</Text>
          <Box style={styles.field}>
            <TextInput
              style={styles.input}
              placeholder="예: 공부민지"
              placeholderTextColor={colors.ink4}
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="none"
            />
          </Box>

          {/* 이메일 + ✓ 마크 */}
          <Text style={[t.meta, styles.label]}>이메일</Text>
          <Box style={[styles.field, styles.fieldRow]}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="you@example.com"
              placeholderTextColor={colors.ink4}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {emailValid && (
              <Ionicons name="checkmark-circle" size={18} color={colors.good} />
            )}
          </Box>

          {/* 비밀번호 + 강도 게이지 */}
          <Text style={[t.meta, styles.label]}>비밀번호 · 8자 이상</Text>
          <Box style={styles.field}>
            <TextInput
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={colors.ink4}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Box>
          <View style={styles.gauge}>
            {[0, 1, 2, 3].map((i) => (
              <View
                key={i}
                style={[
                  styles.gaugeSeg,
                  i < strength && { backgroundColor: strength <= 1 ? colors.bad : strength <= 2 ? '#f59e0b' : colors.good },
                ]}
              />
            ))}
          </View>

          {/* 비밀번호 확인 */}
          <Text style={[t.meta, styles.label]}>비밀번호 확인</Text>
          <Box style={styles.field}>
            <TextInput
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={colors.ink4}
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Box>

          {/* 약관 체크박스 */}
          <View style={styles.consents}>
            <ConsentRow
              label="만 14세 이상이에요"
              required
              checked={agreeAge}
              onToggle={() => setAgreeAge((s) => !s)}
            />
            <ConsentRow
              label="이용약관 동의"
              required
              checked={agreeTos}
              onToggle={() => setAgreeTos((s) => !s)}
              onView={() => setTermsOpen(true)}
            />
          </View>

          <Btn primary lg full onPress={handleRegister} loading={loading} disabled={!canSubmit}>
            가입 완료
          </Btn>

          {/* 로그인 링크 */}
          <View style={styles.loginRow}>
            <Text style={styles.loginText}>이미 계정이 있으신가요? </Text>
            <TouchableOpacity onPress={() => router.replace('/(auth)/login')}>
              <Text style={styles.linkAccent}>로그인 →</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* 이용약관 모달 */}
      <Modal visible={termsOpen} transparent animationType="fade" onRequestClose={() => setTermsOpen(false)}>
        <View style={styles.termsOverlay}>
          <View style={styles.termsSheet}>
            <View style={styles.termsHeader}>
              <Text style={styles.termsTitle}>이용약관</Text>
              <TouchableOpacity onPress={() => setTermsOpen(false)} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.ink2} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.termsBody} contentContainerStyle={{ paddingBottom: 16 }}>
              <Text style={styles.termsH2}>제1조 (목적)</Text>
              <Text style={styles.termsP}>본 약관은 공폼(이하 "서비스")이 제공하는 AI 학습 콘텐츠 자동 생성·재생 서비스의 이용과 관련하여 회사와 회원의 권리·의무 및 책임 사항을 규정합니다.</Text>

              <Text style={styles.termsH2}>제2조 (회원가입)</Text>
              <Text style={styles.termsP}>이용자는 만 14세 이상이어야 가입할 수 있습니다. 가입 시 입력하는 이메일과 닉네임은 정확해야 하며, 타인의 정보를 도용해서는 안 됩니다.</Text>

              <Text style={styles.termsH2}>제3조 (개인정보의 수집·이용)</Text>
              <Text style={styles.termsP}>회사는 회원가입 시 이메일과 닉네임, 학습 진도, 학습 시간, 오답 기록을 수집합니다. 수집된 정보는 서비스 제공 외 다른 목적으로 사용되지 않으며 회원 탈퇴 시 지체 없이 파기됩니다.</Text>

              <Text style={styles.termsH2}>제4조 (콘텐츠의 소유권)</Text>
              <Text style={styles.termsP}>회원이 업로드한 학습 자료의 저작권은 회원에게 있습니다. 회사는 회원의 요청에 따라 해당 자료를 AI에 입력해 숏폼을 생성하며, 생성된 결과물은 회원의 계정 내에서만 사용됩니다.</Text>

              <Text style={styles.termsH2}>제5조 (AI 결과물의 정확성)</Text>
              <Text style={styles.termsP}>AI가 생성하는 개념·예시·퀴즈는 학습 보조용이며 정답이 아닐 수 있습니다. 시험·과제 등 중요한 의사결정 전에는 반드시 원본 자료와 교차 확인하시기 바랍니다.</Text>

              <Text style={styles.termsH2}>제6조 (금지 사항)</Text>
              <Text style={styles.termsP}>저작권을 침해하는 자료의 업로드, 타인의 계정 사용, 서비스의 비정상적 이용(자동화 스크립트, 대량 트래픽 등)은 금지됩니다. 위반 시 사전 통보 없이 서비스 이용이 제한될 수 있습니다.</Text>

              <Text style={styles.termsH2}>제7조 (서비스의 변경·중단)</Text>
              <Text style={styles.termsP}>회사는 운영상·기술상 필요한 경우 서비스 내용을 변경하거나 중단할 수 있으며, 중요한 변경은 앱 내 공지 또는 이메일로 사전 안내합니다.</Text>

              <Text style={styles.termsH2}>제8조 (탈퇴 및 자료 삭제)</Text>
              <Text style={styles.termsP}>회원은 언제든지 [마이 → 계정 관리]에서 탈퇴할 수 있으며, 탈퇴 시 모든 학습 데이터(프로젝트·숏폼·오답·노트)는 영구 삭제됩니다.</Text>

              <Text style={styles.termsMeta}>마지막 업데이트: 2026-01-01 · 본 약관은 서비스 개선에 따라 변경될 수 있으며, 중요한 변경은 사전 고지합니다.</Text>
            </ScrollView>
            <View style={styles.termsFooter}>
              <TouchableOpacity style={styles.termsCta} onPress={() => setTermsOpen(false)}>
                <Text style={styles.termsCtaText}>확인</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function ConsentRow({
  label, required, checked, onToggle, onView,
}: {
  label: string;
  required?: boolean;
  checked: boolean;
  onToggle: () => void;
  onView?: () => void;
}) {
  return (
    <TouchableOpacity style={styles.consentRow} onPress={onToggle} activeOpacity={0.7}>
      <View style={[styles.checkbox, checked && styles.checkboxOn]}>
        {checked && <Ionicons name="checkmark" size={12} color={colors.paper} />}
      </View>
      <Text style={styles.consentLabel}>
        {label}{required && <Text style={{ color: colors.accent }}> *</Text>}
      </Text>
      {onView && (
        <TouchableOpacity onPress={onView} hitSlop={8}>
          <Text style={styles.consentView}>보기</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 22, paddingBottom: 30 },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    marginBottom: 14,
  },
  headerTitle: { fontFamily: fonts.body, fontSize: 16, color: colors.ink },

  h1: { fontFamily: fonts.body, fontSize: 28, color: colors.ink, lineHeight: 32, marginBottom: 4 },
  h1Sub: { fontFamily: fonts.body, fontSize: 15, color: colors.ink2, marginBottom: 24, lineHeight: 21 },

  label: { marginBottom: 6, marginLeft: 4 },
  field: { paddingHorizontal: 14, paddingVertical: 4, marginBottom: 12 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.ink,
    paddingVertical: 10,
  },

  // 강도 게이지
  gauge: { flexDirection: 'row', gap: 4, marginTop: -4, marginBottom: 18 },
  gaugeSeg: {
    flex: 1, height: 4, borderRadius: 2,
    backgroundColor: colors.ink4,
  },

  consents: { gap: 10, marginBottom: 22, marginTop: 4 },
  consentRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkbox: {
    width: 20, height: 20, borderRadius: 4,
    borderWidth: 1.5, borderColor: colors.stroke,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  consentLabel: { flex: 1, fontFamily: fonts.body, fontSize: 14, color: colors.ink },
  consentView: { fontFamily: fonts.mono, fontSize: 12, color: colors.accent, textTransform: 'uppercase' },

  loginRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: 20 },
  loginText: { fontFamily: fonts.body, fontSize: 14, color: colors.ink3 },
  linkAccent: { fontFamily: fonts.body, fontSize: 14, color: colors.accent },

  // 약관 모달
  termsOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  termsSheet: {
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.stroke,
    borderRadius: 16,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  termsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.strokeSoft,
  },
  termsTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  termsBody: { paddingHorizontal: 18, paddingTop: 12 },
  termsH2: { fontFamily: fonts.body, fontSize: 14, fontWeight: '700', color: colors.accent, marginTop: 14, marginBottom: 6 },
  termsP: { fontFamily: fonts.body, fontSize: 13, color: colors.ink, lineHeight: 20 },
  termsMeta: { fontFamily: fonts.mono, fontSize: 11, color: colors.ink3, marginTop: 22, lineHeight: 16 },
  termsFooter: { paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.strokeSoft },
  termsCta: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  termsCtaText: { fontFamily: fonts.body, fontSize: 15, color: '#fff', fontWeight: '700' },
});
