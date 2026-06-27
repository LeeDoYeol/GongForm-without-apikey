import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  ScrollView, Modal, Platform, ActivityIndicator, PanResponder,
  TextInput, Linking,
} from 'react-native';
import {
  ensureSettingsLoaded,
  getUserApiKeySync,
  getFastModeSync,
  getProviderSync,
  setUserApiKey,
  setFastMode,
  setProvider,
  subscribeSettings,
  validateOpenRouterKey,
  AiProvider,
} from '@/lib/aiSettings';
import { changePassword, changeEmail, deleteAccount } from '@/lib/accountManager';
import { setEdgeTtsVolume } from '@/lib/edgeTtsPlayer';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getReminderSettings,
  saveReminderSettings,
  scheduleDailyReminder,
  cancelReminder,
  requestNotificationPermission,
  formatTime,
  ReminderSettings,
} from '@/lib/notifications';
import {
  listKoreanVoices,
  loadSavedVoiceId,
  saveVoiceId,
  previewVoice,
  stopPreview,
  TtsVoiceOption,
} from '@/lib/ttsVoice';

// 플레이어와 동일한 TTS 활성 키, 마이 탭에서 미리듣기 차단에 사용
const TTS_PREF_KEY = '@gongform/player/ttsEnabled';
// 플레이어와 같은 키 사용 → 미리듣기 볼륨이 그대로 플레이어에 반영
const TTS_VOLUME_KEY = '@gongform/player/ttsVolume';

export default function MyScreen() {
  const { user, logout } = useAuth();
  const [reminder, setReminder] = useState<ReminderSettings>({ enabled: false, hour: 20, minute: 0 });
  const [timePickerVisible, setTimePickerVisible] = useState(false);
  const [pickerHour, setPickerHour] = useState(20);
  const [pickerMinute, setPickerMinute] = useState(0);

  // TTS 음성 선택
  const [voices, setVoices] = useState<TtsVoiceOption[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [voicePickerVisible, setVoicePickerVisible] = useState(false);
  const [voicesLoading, setVoicesLoading] = useState(false);

  // AI 설정 (사용자 API 키 + 빠른 모드 + provider)
  const [apiKey, setApiKeyState] = useState<string | null>(null);
  const [fastMode, setFastModeState] = useState<boolean>(false);
  const [provider, setProviderState] = useState<AiProvider>('openrouter');
  const [keyEditOpen, setKeyEditOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  useEffect(() => {
    let mounted = true;
    ensureSettingsLoaded().then(() => {
      if (!mounted) return;
      setApiKeyState(getUserApiKeySync());
      setFastModeState(getFastModeSync());
      setProviderState(getProviderSync());
    });
    const unsub = subscribeSettings(() => {
      setApiKeyState(getUserApiKeySync());
      setFastModeState(getFastModeSync());
      setProviderState(getProviderSync());
    });
    return () => { mounted = false; unsub(); };
  }, []);

  const switchProvider = useCallback((p: AiProvider) => {
    if (p === provider) return;
    setProvider(p);
  }, [provider]);

  const saveApiKey = useCallback(async () => {
    const trimmed = keyDraft.trim();
    if (!trimmed) {
      Alert.alert('오류', 'API 키를 입력해주세요.');
      return;
    }
    setSavingKey(true);
    try {
      // OpenRouter에 ping → 키가 진짜 유효한지 + 정보 확인
      const info = await validateOpenRouterKey(trimmed);
      await setUserApiKey(trimmed);
      // 키 등록과 동시에 빠른 모드 자동 활성화: 자기 키 가진 사용자는 병렬 호출 가능
      await setFastMode(true);
      setFastModeState(true);
      setKeyEditOpen(false);
      setKeyDraft('');
      // 검증 성공 안내, 잔여 정보가 있으면 함께 표시
      const remain = info.limitRemaining;
      const remainStr = remain !== null && remain !== undefined
        ? `\n남은 크레딧: $${Number(remain).toFixed(2)}${info.isFreeTier ? ' (무료 티어)' : ''}`
        : '';
      Alert.alert('키 등록 완료', `OpenRouter 키가 확인됐어요.${remainStr}`);
    } catch (e: any) {
      Alert.alert('키 확인 실패', e?.message ?? '알 수 없는 오류');
    } finally {
      setSavingKey(false);
    }
  }, [keyDraft]);

  const clearApiKey = useCallback(() => {
    Alert.alert('API 키 삭제', '등록된 키를 삭제하면 공용 키로 느린 속도로만 사용됩니다. 계속할까요?', [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: () => { setUserApiKey(null); },
      },
    ]);
  }, []);

  const toggleFast = useCallback(async () => {
    if (!apiKey) {
      Alert.alert('API 키 필요', '먼저 OpenRouter API 키를 등록하세요.');
      return;
    }
    await setFastMode(!fastMode);
  }, [apiKey, fastMode]);

  const maskedKey = apiKey
    ? `${apiKey.slice(0, 10)}…${apiKey.slice(-4)}`
    : null;

  // 계정 관리
  const [accountModal, setAccountModal] = useState<null | 'password' | 'email' | 'delete'>(null);
  const [acCurPw, setAcCurPw] = useState('');
  const [acNewPw, setAcNewPw] = useState('');
  const [acNewEmail, setAcNewEmail] = useState('');
  const [acBusy, setAcBusy] = useState(false);

  const closeAccountModal = () => {
    setAccountModal(null);
    setAcCurPw(''); setAcNewPw(''); setAcNewEmail('');
  };

  const doChangePassword = useCallback(async () => {
    if (!user || acBusy) return;
    setAcBusy(true);
    try {
      await changePassword(user, acCurPw, acNewPw);
      closeAccountModal();
      Alert.alert('완료', '비밀번호가 변경됐어요.');
    } catch (e: any) {
      Alert.alert('실패', e?.message ?? '오류가 발생했어요');
    } finally {
      setAcBusy(false);
    }
  }, [user, acCurPw, acNewPw, acBusy]);

  const doChangeEmail = useCallback(async () => {
    if (!user || acBusy) return;
    setAcBusy(true);
    try {
      await changeEmail(user, acCurPw, acNewEmail);
      closeAccountModal();
      Alert.alert('완료', '이메일이 변경됐어요.');
    } catch (e: any) {
      Alert.alert('실패', e?.message ?? '오류가 발생했어요');
    } finally {
      setAcBusy(false);
    }
  }, [user, acCurPw, acNewEmail, acBusy]);

  const doDeleteAccount = useCallback(async () => {
    if (!user || acBusy) return;
    setAcBusy(true);
    try {
      await deleteAccount(user, acCurPw);
      // 계정 삭제 후 자동 로그아웃 → AuthContext에서 login 화면으로 이동
      closeAccountModal();
    } catch (e: any) {
      Alert.alert('실패', e?.message ?? '오류가 발생했어요');
    } finally {
      setAcBusy(false);
    }
  }, [user, acCurPw, acBusy]);

  // 미리듣기 볼륨 (플레이어와 동일 키 공유), 0..1
  const [previewVol, setPreviewVol] = useState<number>(1);
  const previewVolRef = useRef(previewVol);
  useEffect(() => { previewVolRef.current = previewVol; }, [previewVol]);

  const updateVolume = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(1, next));
    setPreviewVol(clamped);
    setEdgeTtsVolume(clamped);
    AsyncStorage.setItem(TTS_VOLUME_KEY, String(clamped)).catch(() => {});
  }, []);

  useEffect(() => {
    getReminderSettings().then(setReminder);
    loadSavedVoiceId().then((id) => setSelectedVoiceId(id));
    // 저장된 음성 이름을 settingCard에 즉시 표시하려고 백그라운드 로드
    listKoreanVoices().then(setVoices).catch(() => {});
    // 저장된 볼륨 로드
    AsyncStorage.getItem(TTS_VOLUME_KEY)
      .then((v) => {
        if (v === null) return;
        const n = parseFloat(v);
        if (Number.isFinite(n)) {
          const clamped = Math.max(0, Math.min(1, n));
          setPreviewVol(clamped);
          setEdgeTtsVolume(clamped);
        }
      })
      .catch(() => {});
  }, []);

  const openVoicePicker = async () => {
    setVoicePickerVisible(true);
    if (voices.length === 0) {
      setVoicesLoading(true);
      try {
        const list = await listKoreanVoices();
        setVoices(list);
      } finally {
        setVoicesLoading(false);
      }
    }
  };

  const pickVoice = async (id: string | null) => {
    setSelectedVoiceId(id);
    await saveVoiceId(id);
    // TTS가 꺼져 있으면 미리듣기 생략
    const enabled = await AsyncStorage.getItem(TTS_PREF_KEY);
    if (enabled === '0') return;
    // "안녕하세요 OO입니다": 시스템 기본은 voice 이름 없으니 일반 문구
    const voiceName = id ? voices.find((v) => v.id === id)?.name : null;
    const sample = voiceName
      ? `안녕하세요 ${voiceName}입니다.`
      : '안녕하세요. 시스템 기본 음성입니다.';
    try {
      await previewVoice(id, sample, previewVolRef.current);
    } catch (e: any) {
      console.warn('[pickVoice] preview 실패', e);
      Alert.alert('미리듣기 실패', `${e?.message ?? '알 수 없는 오류'}`);
    }
  };

  const closeVoicePicker = () => {
    stopPreview();
    setVoicePickerVisible(false);
  };

  const selectedVoiceName =
    selectedVoiceId
      ? (voices.find((v) => v.id === selectedVoiceId)?.name ?? '저장된 음성')
      : '시스템 기본';

  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const handleLogout = () => {
    setLogoutConfirmOpen(true);
  };
  const doLogout = useCallback(async () => {
    setLogoutConfirmOpen(false);
    try { await logout(); } catch (e: any) {
      Alert.alert('로그아웃 실패', e?.message ?? '잠시 후 다시 시도해주세요.');
    }
  }, [logout]);

  const toggleReminder = async (enabled: boolean) => {
    if (enabled) {
      try {
        const granted = await requestNotificationPermission();
        if (!granted) {
          Alert.alert('알림 권한 필요', '설정에서 알림 권한을 허용해주세요.');
          return;
        }
      } catch (e: any) {
        console.error('[reminder permission]', e);
        Alert.alert(
          '알림 권한 요청 실패',
          `${e?.name ?? 'Error'}: ${e?.message ?? '알 수 없는 오류'}`
        );
        return;
      }
    }
    const updated = { ...reminder, enabled };
    setReminder(updated);
    await saveReminderSettings(updated);
    try {
      if (enabled) await scheduleDailyReminder(updated);
      else await cancelReminder();
    } catch (e: any) {
      console.error('[reminder schedule]', e);
      Alert.alert(
        '알림 예약 실패',
        `${e?.name ?? 'Error'}: ${e?.message ?? '알 수 없는 오류'}\n\n` +
          'Expo Go(SDK 53+)는 알림 미지원입니다. 개발 빌드로 실행하세요:\n' +
          'npx expo run:android  또는  eas build --profile development'
      );
      const rolled = { ...reminder, enabled: false };
      setReminder(rolled);
      await saveReminderSettings(rolled);
    }
  };

  const openTimePicker = () => {
    setPickerHour(reminder.hour);
    setPickerMinute(reminder.minute);
    setTimePickerVisible(true);
  };

  const applyTime = async () => {
    const updated = { ...reminder, hour: pickerHour, minute: pickerMinute };
    setReminder(updated);
    await saveReminderSettings(updated);
    if (updated.enabled) await scheduleDailyReminder(updated);
    setTimePickerVisible(false);
  };

  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>마이</Text>
        </View>

        {/* 프로필: displayName 우선 표시, 없으면 이메일 prefix를 닉네임으로 사용 */}
        <View style={styles.profileSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarInitial}>
              {(user?.displayName?.trim() || user?.email?.split('@')[0] || '나').charAt(0)}
            </Text>
          </View>
          <Text style={styles.displayName}>
            {user?.displayName?.trim() || user?.email?.split('@')[0] || '사용자'}
          </Text>
          <Text style={styles.email}>{user?.email}</Text>
          <Text style={styles.uid}>UID: {user?.uid?.slice(0, 8)}...</Text>
        </View>

        {/* 학습 알림 설정 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>학습 알림</Text>

          <View style={styles.settingCard}>
            <View style={styles.settingRow}>
              <View style={styles.settingLeft}>
                <View style={[styles.settingIcon, { backgroundColor: '#4F8EF718' }]}>
                  <Ionicons name="notifications-outline" size={20} color="#4F8EF7" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingLabel}>학습 리마인드</Text>
                  <Text style={styles.settingSub}>
                    {Platform.OS === 'web'
                      ? '웹에서는 지원되지 않아요. 모바일 앱에서 사용해주세요.'
                      : '매일 정해진 시간에 알림'}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={[
                  styles.toggle,
                  reminder.enabled && styles.toggleOn,
                  Platform.OS === 'web' && { opacity: 0.3 },
                ]}
                disabled={Platform.OS === 'web'}
                onPress={() => toggleReminder(!reminder.enabled)}
              >
                <View style={[styles.toggleThumb, reminder.enabled && styles.toggleThumbOn]} />
              </TouchableOpacity>
            </View>

            {reminder.enabled && (
              <TouchableOpacity style={styles.timeRow} onPress={openTimePicker}>
                <Ionicons name="time-outline" size={16} color="#888" />
                <Text style={styles.timeText}>
                  매일 {formatTime(reminder.hour, reminder.minute)}에 알림
                </Text>
                <View style={styles.timeEditBtn}>
                  <Ionicons name="create-outline" size={14} color="#4F8EF7" />
                  <Text style={styles.timeEditText}>변경</Text>
                </View>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* TTS 음성 설정 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>TTS 음성</Text>
          <TouchableOpacity style={styles.settingCard} onPress={openVoicePicker} activeOpacity={0.7}>
            <View style={styles.settingRow}>
              <View style={styles.settingLeft}>
                <View style={[styles.settingIcon, { backgroundColor: '#22C55E18' }]}>
                  <Ionicons name="mic-outline" size={20} color="#22C55E" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingLabel}>읽어주는 목소리</Text>
                  <Text style={styles.settingSub} numberOfLines={1}>{selectedVoiceName}</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={16} color="#666" />
            </View>
          </TouchableOpacity>
        </View>

        {/* AI 설정: OpenRouter 키 + 빠른 모드 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>AI 설정 (개발 단계)</Text>

          {/* 추론 업스트림 토글: 3개 provider 비교용 */}
          <View style={styles.settingCard}>
            <View style={[styles.settingRow, { alignItems: 'flex-start' }]}>
              <View style={styles.settingLeft}>
                <View style={[styles.settingIcon, { backgroundColor: '#4F8EF718' }]}>
                  <Ionicons name="git-compare-outline" size={20} color="#4F8EF7" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingLabel}>추론 업스트림</Text>
                  <Text style={styles.settingSub}>
                    {provider === 'openai'
                      ? 'OpenAI — gpt-5-mini · 안정·유료'
                      : provider === 'cerebras'
                      ? 'Cerebras — gpt-oss-120b · 빠름 (한도 빡빡)'
                      : apiKey
                      ? 'OpenRouter — gpt-oss-120b:free · 내 키 직접'
                      : 'OpenRouter — gpt-oss-120b:free · 프록시 경유'}
                  </Text>
                </View>
              </View>
            </View>
            <View style={styles.segmentRow}>
              <TouchableOpacity
                style={[styles.segmentItem, provider === 'openrouter' && styles.segmentItemActive]}
                onPress={() => switchProvider('openrouter')}
                activeOpacity={0.7}
              >
                <Text style={[styles.segmentText, provider === 'openrouter' && styles.segmentTextActive]}>OpenRouter</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentItem, provider === 'cerebras' && styles.segmentItemActive]}
                onPress={() => switchProvider('cerebras')}
                activeOpacity={0.7}
              >
                <Text style={[styles.segmentText, provider === 'cerebras' && styles.segmentTextActive]}>Cerebras</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentItem, provider === 'openai' && styles.segmentItemActive]}
                onPress={() => switchProvider('openai')}
                activeOpacity={0.7}
              >
                <Text style={[styles.segmentText, provider === 'openai' && styles.segmentTextActive]}>OpenAI</Text>
              </TouchableOpacity>
            </View>
          </View>

          <TouchableOpacity style={styles.settingCard} onPress={() => { setKeyDraft(''); setKeyEditOpen(true); }} activeOpacity={0.7}>
            <View style={styles.settingRow}>
              <View style={styles.settingLeft}>
                <View style={[styles.settingIcon, { backgroundColor: apiKey ? '#22C55E18' : '#F9731618' }]}>
                  <Ionicons name="key-outline" size={20} color={apiKey ? '#22C55E' : '#F97316'} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingLabel}>OpenRouter API 키</Text>
                  <Text style={styles.settingSub} numberOfLines={1}>
                    {maskedKey ? `등록됨 · ${maskedKey}` : '미등록 (공용 키로 느린 속도 사용)'}
                  </Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={16} color="#666" />
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.settingCard, !apiKey && { opacity: 0.5 }]}
            onPress={toggleFast}
            activeOpacity={0.7}
            disabled={!apiKey}
          >
            <View style={styles.settingRow}>
              <View style={styles.settingLeft}>
                <View style={[styles.settingIcon, { backgroundColor: '#4F8EF718' }]}>
                  <Ionicons name="flash" size={20} color="#4F8EF7" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingLabel}>빠른 속도 (병렬 처리)</Text>
                  <Text style={styles.settingSub} numberOfLines={1}>
                    {!apiKey
                      ? 'API 키 등록 후 사용 가능'
                      : fastMode
                      ? '활성 — 여러 작업을 동시에 처리'
                      : '비활성 — 한 번에 1개씩 처리'}
                  </Text>
                </View>
              </View>
              <View style={[styles.miniToggle, fastMode && styles.miniToggleOn]}>
                <View style={[styles.miniKnob, fastMode && styles.miniKnobOn]} />
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => Linking.openURL('https://openrouter.ai/keys')}
          >
            <Ionicons name="open-outline" size={14} color="#4F8EF7" />
            <Text style={styles.linkText}>OpenRouter에서 무료 API 키 발급하기 →</Text>
          </TouchableOpacity>
        </View>

        {/* 계정 관리 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>계정 관리</Text>
          <TouchableOpacity style={styles.acRow} onPress={() => setAccountModal('password')}>
            <Ionicons name="lock-closed-outline" size={18} color="#aaa" style={{ width: 24 }} />
            <Text style={styles.acLabel}>비밀번호 변경</Text>
            <Ionicons name="chevron-forward" size={16} color="#666" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.acRow} onPress={() => setAccountModal('email')}>
            <Ionicons name="mail-outline" size={18} color="#aaa" style={{ width: 24 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.acLabel}>이메일 변경</Text>
              <Text style={styles.acSub} numberOfLines={1}>{user?.email}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#666" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.acRow} onPress={() => setAccountModal('delete')}>
            <Ionicons name="trash-outline" size={18} color="#EF4444" style={{ width: 24 }} />
            <Text style={[styles.acLabel, { color: '#EF4444' }]}>회원 탈퇴</Text>
            <Ionicons name="chevron-forward" size={16} color="#EF4444" />
          </TouchableOpacity>
        </View>

        {/* 기타 설정 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>앱 정보</Text>
          <View style={styles.menuSection}>
            <MenuItem icon="information-circle-outline" label="앱 정보" sub="공폼 v1.1.0" />
            <MenuItem icon="shield-outline" label="개인정보 처리방침" />
            <MenuItem icon="document-text-outline" label="이용약관" />
          </View>
        </View>

        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={20} color="#FF4444" />
          <Text style={styles.logoutText}>로그아웃</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* 시간 선택 모달 */}
      <Modal visible={timePickerVisible} transparent animationType="slide">
        <View style={styles.pickerOverlay}>
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerTitle}>알림 시간 설정</Text>

            <View style={styles.pickerRow}>
              {/* 시 */}
              <View style={styles.pickerCol}>
                <Text style={styles.pickerColLabel}>시</Text>
                <ScrollView
                  style={styles.pickerScroll}
                  showsVerticalScrollIndicator={false}
                >
                  {HOURS.map((h) => (
                    <TouchableOpacity
                      key={h}
                      style={[styles.pickerItem, pickerHour === h && styles.pickerItemActive]}
                      onPress={() => setPickerHour(h)}
                    >
                      <Text style={[styles.pickerItemText, pickerHour === h && styles.pickerItemTextActive]}>
                        {String(h).padStart(2, '0')}시
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>

              <Text style={styles.pickerColon}>:</Text>

              {/* 분 */}
              <View style={styles.pickerCol}>
                <Text style={styles.pickerColLabel}>분</Text>
                <ScrollView
                  style={styles.pickerScroll}
                  showsVerticalScrollIndicator={false}
                >
                  {MINUTES.map((m) => (
                    <TouchableOpacity
                      key={m}
                      style={[styles.pickerItem, pickerMinute === m && styles.pickerItemActive]}
                      onPress={() => setPickerMinute(m)}
                    >
                      <Text style={[styles.pickerItemText, pickerMinute === m && styles.pickerItemTextActive]}>
                        {String(m).padStart(2, '0')}분
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>

            <Text style={styles.pickerPreview}>
              매일 {formatTime(pickerHour, pickerMinute)}에 알림이 울립니다
            </Text>

            <View style={styles.pickerButtons}>
              <TouchableOpacity
                style={styles.pickerCancelBtn}
                onPress={() => setTimePickerVisible(false)}
              >
                <Text style={styles.pickerCancelText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pickerConfirmBtn} onPress={applyTime}>
                <Ionicons name="checkmark" size={16} color="#fff" />
                <Text style={styles.pickerConfirmText}>적용</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* API 키 등록/수정 모달 */}
      <Modal visible={keyEditOpen} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.keyModal}>
            <Text style={styles.keyModalTitle}>OpenRouter API 키</Text>
            <Text style={styles.keyModalHint}>
              자신의 키를 등록하면 빠른 속도(병렬 처리)로 사용 가능합니다.{'\n'}
              <Text style={{ color: '#666' }}>키는 이 기기에만 저장됩니다.</Text>
            </Text>
            <TextInput
              style={styles.keyInput}
              value={keyDraft}
              onChangeText={setKeyDraft}
              placeholder="sk-or-..."
              placeholderTextColor="#555"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={false}
            />
            <View style={styles.keyModalBtnRow}>
              <TouchableOpacity
                style={[styles.keyCancelBtn]}
                onPress={() => { setKeyEditOpen(false); setKeyDraft(''); }}
                disabled={savingKey}
              >
                <Text style={styles.keyCancelText}>취소</Text>
              </TouchableOpacity>
              {apiKey && (
                <TouchableOpacity
                  style={[styles.keyDeleteBtn]}
                  onPress={() => { setKeyEditOpen(false); clearApiKey(); }}
                  disabled={savingKey}
                >
                  <Ionicons name="trash-outline" size={14} color="#EF4444" />
                  <Text style={styles.keyDeleteText}>삭제</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.keySaveBtn} onPress={saveApiKey} disabled={savingKey}>
                {savingKey ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="checkmark" size={14} color="#fff" />
                    <Text style={styles.keySaveText}>저장</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 로그아웃 확인 모달: Alert.alert이 웹 모달 안에선 안 보여서 인앱 모달로 처리 */}
      <Modal visible={logoutConfirmOpen} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.keyModal}>
            <Text style={styles.keyModalTitle}>로그아웃</Text>
            <Text style={styles.keyModalHint}>로그아웃 하시겠습니까?</Text>
            <View style={styles.keyModalBtnRow}>
              <TouchableOpacity
                style={styles.keyCancelBtn}
                onPress={() => setLogoutConfirmOpen(false)}
              >
                <Text style={styles.keyCancelText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.keyDeleteBtn, { backgroundColor: '#EF4444' }]}
                onPress={doLogout}
              >
                <Ionicons name="log-out-outline" size={14} color="#fff" />
                <Text style={[styles.keyDeleteText, { color: '#fff' }]}>로그아웃</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 계정 관리 모달 (비밀번호 변경 / 이메일 변경 / 회원 탈퇴) */}
      <Modal visible={!!accountModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.keyModal}>
            <Text style={styles.keyModalTitle}>
              {accountModal === 'password' ? '비밀번호 변경'
                : accountModal === 'email' ? '이메일 변경'
                : '회원 탈퇴'}
            </Text>
            <Text style={styles.keyModalHint}>
              {accountModal === 'delete'
                ? '계정과 모든 학습 데이터(폴더·프로젝트·숏폼·오답·노트)가 영구 삭제됩니다.\n복구할 수 없습니다.'
                : '보안을 위해 현재 비밀번호를 함께 입력해주세요.'}
            </Text>

            <TextInput
              style={styles.keyInput}
              value={acCurPw}
              onChangeText={setAcCurPw}
              placeholder="현재 비밀번호"
              placeholderTextColor="#555"
              secureTextEntry
              autoCapitalize="none"
            />

            {accountModal === 'password' && (
              <TextInput
                style={styles.keyInput}
                value={acNewPw}
                onChangeText={setAcNewPw}
                placeholder="새 비밀번호 (6자 이상)"
                placeholderTextColor="#555"
                secureTextEntry
                autoCapitalize="none"
              />
            )}
            {accountModal === 'email' && (
              <TextInput
                style={styles.keyInput}
                value={acNewEmail}
                onChangeText={setAcNewEmail}
                placeholder="새 이메일"
                placeholderTextColor="#555"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}

            <View style={styles.keyModalBtnRow}>
              <TouchableOpacity style={styles.keyCancelBtn} onPress={closeAccountModal} disabled={acBusy}>
                <Text style={styles.keyCancelText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={accountModal === 'delete' ? [styles.keySaveBtn, { backgroundColor: '#EF4444' }] : styles.keySaveBtn}
                onPress={
                  accountModal === 'password' ? doChangePassword
                  : accountModal === 'email' ? doChangeEmail
                  : doDeleteAccount
                }
                disabled={acBusy}
              >
                {acBusy ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons
                      name={accountModal === 'delete' ? 'trash-outline' : 'checkmark'}
                      size={14}
                      color="#fff"
                    />
                    <Text style={styles.keySaveText}>
                      {accountModal === 'delete' ? '영구 삭제' : '변경'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* TTS 음성 선택 모달 */}
      <Modal visible={voicePickerVisible} transparent animationType="slide" onRequestClose={closeVoicePicker}>
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={closeVoicePicker}>
          <TouchableOpacity activeOpacity={1} style={styles.voiceSheet} onPress={(e) => e.stopPropagation?.()}>
            <Text style={styles.pickerTitle}>TTS 음성 선택</Text>
            <Text style={styles.voiceHint}>탭하면 미리듣기 + 선택 저장</Text>

            <HorizontalVolumeFader value={previewVol} onChange={updateVolume} />

            <ScrollView style={{ maxHeight: 400 }} contentContainerStyle={{ paddingBottom: 12 }}>
              <TouchableOpacity
                style={[styles.voiceItem, selectedVoiceId === null && styles.voiceItemActive]}
                onPress={() => pickVoice(null)}
              >
                <Ionicons name="settings-outline" size={18} color={selectedVoiceId === null ? '#22C55E' : '#888'} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.voiceName, selectedVoiceId === null && { color: '#22C55E' }]}>시스템 기본</Text>
                  <Text style={styles.voiceMeta}>기기에 설정된 기본 한국어 음성</Text>
                </View>
                {selectedVoiceId === null && (
                  <Ionicons name="checkmark-circle" size={18} color="#22C55E" />
                )}
              </TouchableOpacity>

              {voicesLoading ? (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                  <ActivityIndicator color="#22C55E" />
                  <Text style={[styles.voiceMeta, { marginTop: 8 }]}>음성 목록 로드 중...</Text>
                </View>
              ) : voices.length === 0 ? (
                <Text style={[styles.voiceMeta, { padding: 16, textAlign: 'center' }]}>
                  {Platform.OS === 'web'
                    ? '브라우저에 설치된 한국어 음성이 없습니다'
                    : '기기에 한국어 음성이 없습니다. 설정 → 일반 → 손쉬운 사용 → 음성 콘텐츠에서 추가하세요.'}
                </Text>
              ) : (
                voices.map((v) => {
                  const active = selectedVoiceId === v.id;
                  return (
                    <TouchableOpacity
                      key={v.id}
                      style={[styles.voiceItem, active && styles.voiceItemActive]}
                      onPress={() => pickVoice(v.id)}
                    >
                      <Ionicons name="person-outline" size={18} color={active ? '#22C55E' : '#888'} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.voiceName, active && { color: '#22C55E' }]} numberOfLines={1}>
                          {v.name}
                        </Text>
                        <Text style={styles.voiceMeta}>
                          {v.language}{v.quality ? ` · ${v.quality}` : ''}
                        </Text>
                      </View>
                      {active && <Ionicons name="checkmark-circle" size={18} color="#22C55E" />}
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>

            <TouchableOpacity style={styles.pickerConfirmBtn} onPress={closeVoicePicker}>
              <Ionicons name="checkmark" size={16} color="#fff" />
              <Text style={styles.pickerConfirmText}>완료</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

// 가로 볼륨 슬라이더: 마이 탭 음성 선택 모달용. PanResponder로 드래그 처리.
function HorizontalVolumeFader({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const trackRef = useRef<View>(null);
  const trackLeftRef = useRef(0);
  const trackWidthRef = useRef(0);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const measureTrack = useCallback(() => {
    trackRef.current?.measureInWindow((x, _y, w) => {
      trackLeftRef.current = x;
      trackWidthRef.current = w;
    });
  }, []);
  const updateFromX = useCallback((pageX: number) => {
    const w = trackWidthRef.current || 1;
    const localX = pageX - trackLeftRef.current;
    const pct = Math.max(0, Math.min(w, localX)) / w;
    onChangeRef.current(pct);
  }, []);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => { measureTrack(); updateFromX(e.nativeEvent.pageX); },
      onPanResponderMove: (e) => { updateFromX(e.nativeEvent.pageX); },
    })
  ).current;

  const fillPct = Math.round(value * 100);
  return (
    <View style={hvfStyles.wrap}>
      <Ionicons name={value <= 0.01 ? 'volume-mute' : value < 0.5 ? 'volume-low' : 'volume-high'} size={16} color="#888" />
      <View style={hvfStyles.hitArea} {...pan.panHandlers}>
        <View ref={trackRef} onLayout={measureTrack} style={hvfStyles.track}>
          <View style={[hvfStyles.fill, { width: `${fillPct}%` }]} />
          <View style={[hvfStyles.knob, { left: `${fillPct}%` }]} />
        </View>
      </View>
      <Text style={hvfStyles.label}>{fillPct}</Text>
    </View>
  );
}

const hvfStyles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#141414',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    marginBottom: 10,
  },
  hitArea: {
    flex: 1,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  track: {
    height: 6,
    backgroundColor: '#2A2A2A',
    borderRadius: 3,
    overflow: 'visible',
  },
  fill: {
    height: '100%',
    backgroundColor: '#22C55E',
    borderRadius: 3,
  },
  knob: {
    position: 'absolute',
    top: -7,
    marginLeft: -10,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#22C55E',
  },
  label: {
    color: '#888',
    fontSize: 12,
    fontWeight: '700',
    minWidth: 28,
    textAlign: 'right',
  },
});

function MenuItem({
  icon,
  label,
  sub,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  sub?: string;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity style={styles.menuItem} onPress={onPress}>
      <Ionicons name={icon} size={20} color="#888" style={{ marginRight: 12 }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.menuLabel}>{label}</Text>
        {sub && <Text style={styles.menuSub}>{sub}</Text>}
      </View>
      <Ionicons name="chevron-forward" size={16} color="#333" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D0D' },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#fff' },

  profileSection: {
    alignItems: 'center',
    paddingVertical: 28,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  avatar: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#1D2A44', borderWidth: 1.5, borderColor: '#4F8EF7',
    justifyContent: 'center', alignItems: 'center', marginBottom: 12,
  },
  avatarInitial: { color: '#4F8EF7', fontSize: 32, fontWeight: '800' },
  displayName: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 2 },
  email: { color: '#aaa', fontSize: 13, marginBottom: 4 },
  uid: { color: '#555', fontSize: 11 },

  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: {
    fontSize: 12, fontWeight: '700', color: '#666',
    marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.8,
  },

  settingCard: {
    backgroundColor: '#1A1A1A',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
  },
  settingLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingIcon: {
    width: 40, height: 40, borderRadius: 12,
    justifyContent: 'center', alignItems: 'center',
  },
  settingLabel: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 2 },
  settingSub: { color: '#666', fontSize: 12 },

  toggle: {
    width: 50, height: 28, borderRadius: 14,
    backgroundColor: '#2A2A2A',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  toggleOn: { backgroundColor: '#4F8EF7' },
  toggleThumb: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: '#666', alignSelf: 'flex-start',
  },
  toggleThumbOn: { backgroundColor: '#fff', alignSelf: 'flex-end' },

  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  timeText: { color: '#aaa', fontSize: 13, flex: 1 },
  timeEditBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5,
    backgroundColor: '#4F8EF720', borderRadius: 8,
  },
  timeEditText: { color: '#4F8EF7', fontSize: 12, fontWeight: '600' },

  menuSection: {},
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 14,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  menuLabel: { color: '#ccc', fontSize: 15 },
  menuSub: { color: '#555', fontSize: 12, marginTop: 2 },

  // AI 설정: 빠른 모드 토글
  miniToggle: {
    width: 36, height: 20, borderRadius: 10,
    backgroundColor: '#2A2A2A',
    padding: 2, justifyContent: 'center',
  },
  miniToggleOn: { backgroundColor: '#22C55E' },
  miniKnob: {
    width: 16, height: 16, borderRadius: 8, backgroundColor: '#666',
  },
  miniKnobOn: { backgroundColor: '#fff', transform: [{ translateX: 16 }] },

  // provider segmented control (OpenRouter ↔ Cerebras)
  segmentRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 3,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 6,
  },
  segmentItemActive: {
    backgroundColor: '#4F8EF7',
  },
  segmentText: { color: '#888', fontSize: 13, fontWeight: '500' },
  segmentTextActive: { color: '#fff', fontWeight: '600' },

  linkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  linkText: { color: '#4F8EF7', fontSize: 12, fontWeight: '600' },

  // API 키 등록 모달
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20,
  },
  keyModal: {
    backgroundColor: '#1A1A1A', borderRadius: 18,
    padding: 22, width: '100%', maxWidth: 420,
    borderWidth: 1, borderColor: '#2A2A2A',
  },
  keyModalTitle: { color: '#fff', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  keyModalHint: { color: '#888', fontSize: 12, lineHeight: 18, marginBottom: 14 },
  keyInput: {
    backgroundColor: '#0D0D0D',
    borderWidth: 1, borderColor: '#2A2A2A',
    borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    color: '#fff', fontSize: 13,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    marginBottom: 14,
  },
  keyModalBtnRow: { flexDirection: 'row', gap: 8 },
  keyCancelBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 12, borderRadius: 10, backgroundColor: '#2A2A2A',
  },
  keyCancelText: { color: '#888', fontSize: 14, fontWeight: '600' },
  keyDeleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10,
    backgroundColor: '#EF444418', borderWidth: 1, borderColor: '#EF444450',
  },
  keyDeleteText: { color: '#EF4444', fontSize: 13, fontWeight: '700' },
  keySaveBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 12, borderRadius: 10, backgroundColor: '#4F8EF7',
  },
  keySaveText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  // 폰트 선택 그리드
  fontGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 10,
    marginHorizontal: 16,
  },
  fontCard: {
    width: '47%',
    backgroundColor: '#141414',
    borderRadius: 14,
    borderWidth: 1, borderColor: '#2A2A2A',
    paddingVertical: 18, paddingHorizontal: 14,
    alignItems: 'center',
    gap: 6,
    position: 'relative',
    minHeight: 96,
  },
  fontCardActive: { borderColor: '#4F8EF7', backgroundColor: '#1A2944' },
  fontPreview: { color: '#fff', fontSize: 26, lineHeight: 32, fontWeight: '800' },
  fontLabel: { color: '#888', fontSize: 11, fontWeight: '600' },
  fontCheck: { position: 'absolute', top: 8, right: 8 },

  // 계정 관리: menuItem과 동일한 폭/색상으로 통일
  acRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginBottom: 6,
    padding: 14,
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    borderWidth: 1, borderColor: '#2A2A2A',
  },
  acLabel: { flex: 1, color: '#ddd', fontSize: 14, fontWeight: '600' },
  acSub: { color: '#666', fontSize: 11, marginTop: 2 },

  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    margin: 24,
    padding: 16,
    borderRadius: 14,
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#FF444422',
    gap: 8,
  },
  logoutText: { color: '#FF4444', fontSize: 16, fontWeight: '600' },

  // 시간 선택 모달
  pickerOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: '#1A1A1A',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  pickerTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 20, textAlign: 'center' },
  pickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
  pickerCol: { alignItems: 'center', flex: 1 },
  pickerColLabel: { color: '#666', fontSize: 12, fontWeight: '700', marginBottom: 8 },
  pickerScroll: { height: 200 },
  pickerItem: {
    paddingVertical: 10, paddingHorizontal: 16,
    borderRadius: 10, marginBottom: 4,
  },
  pickerItemActive: { backgroundColor: '#4F8EF7' },
  pickerItemText: { color: '#888', fontSize: 17, fontWeight: '600', textAlign: 'center' },
  pickerItemTextActive: { color: '#fff' },
  pickerColon: { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 24 },
  pickerPreview: {
    color: '#888', fontSize: 13, textAlign: 'center',
    marginTop: 16, marginBottom: 20,
  },
  pickerButtons: { flexDirection: 'row', gap: 10 },
  pickerCancelBtn: {
    flex: 1, padding: 14, borderRadius: 12,
    backgroundColor: '#2A2A2A', alignItems: 'center',
  },
  pickerCancelText: { color: '#888', fontWeight: '600', fontSize: 15 },
  pickerConfirmBtn: {
    flex: 1, padding: 14, borderRadius: 12,
    backgroundColor: '#4F8EF7', alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  pickerConfirmText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  // TTS 음성 선택
  voiceSheet: {
    backgroundColor: '#1A1A1A',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  voiceHint: { color: '#666', fontSize: 12, textAlign: 'center', marginBottom: 16, marginTop: -10 },
  voiceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#0D0D0D',
    borderWidth: 1,
    borderColor: '#222',
    marginBottom: 6,
  },
  voiceItemActive: { borderColor: '#22C55E', backgroundColor: '#22C55E15' },
  voiceName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  voiceMeta: { color: '#666', fontSize: 11, marginTop: 2 },
});
