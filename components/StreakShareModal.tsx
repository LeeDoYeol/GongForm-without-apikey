import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Linking,
  Dimensions,
  ScrollView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StreakData, getMotivationalMessage } from '@/lib/streak';

// react-native-view-shot / expo-media-library / expo-sharing only on native
let captureRef: any = null;
let Sharing: any = null;
let MediaLibrary: any = null;
if (Platform.OS !== 'web') {
  captureRef = require('react-native-view-shot').captureRef;
  Sharing = require('expo-sharing');
  MediaLibrary = require('expo-media-library');
}

const { width: SW } = Dimensions.get('window');
const CARD_W = Math.min(SW - 64, 300);
const CARD_H = CARD_W * (16 / 9);

type Theme = 'dark' | 'gradient' | 'minimal';

const THEMES: { id: Theme; label: string; bg: string; accent: string; text: string; sub: string; blob2: string }[] = [
  { id: 'dark',     label: '다크',     bg: '#0A0E1A', accent: '#4F8EF7', text: '#ffffff', sub: '#888888', blob2: '#4F8EF7' },
  { id: 'gradient', label: '그라디언트', bg: '#1A0A2E', accent: '#F97316', text: '#ffffff', sub: '#aaaaaa', blob2: '#C13584' },
  { id: 'minimal',  label: '미니멀',   bg: '#111111', accent: '#22C55E', text: '#ffffff', sub: '#666666', blob2: '#22C55E' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  streak: StreakData;
  email?: string;
}

export default function StreakShareModal({ visible, onClose, streak, email }: Props) {
  const cardRef = useRef<View>(null);
  const [sharing, setSharing] = useState(false);
  const [theme, setTheme] = useState<Theme>('dark');

  const t = THEMES.find((x) => x.id === theme)!;

  // Web: HTML Canvas로 카드 그리기
  const captureCardWeb = async (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const scale = 2;
      const W = Math.round(CARD_W);
      const H = Math.round(CARD_H);
      const canvas = document.createElement('canvas');
      canvas.width = W * scale;
      canvas.height = H * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(scale, scale);

      const r = (hex: string, a = 1) => {
        const h = hex.replace('#', '');
        const n = parseInt(h.length === 8 ? h : h + 'ff', 16);
        return `rgba(${(n >> 24) & 255},${(n >> 16) & 255},${(n >> 8) & 255},${((n & 255) / 255 * a).toFixed(3)})`;
      };

      const hexToRgba = (hex: string, alpha = 1) => {
        const clean = hex.replace('#', '').slice(0, 6);
        const bigint = parseInt(clean, 16);
        return `rgba(${(bigint >> 16) & 255},${(bigint >> 8) & 255},${bigint & 255},${alpha})`;
      };

      // Rounded rect clip
      const radius = 24;
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.lineTo(W - radius, 0);
      ctx.quadraticCurveTo(W, 0, W, radius);
      ctx.lineTo(W, H - radius);
      ctx.quadraticCurveTo(W, H, W - radius, H);
      ctx.lineTo(radius, H);
      ctx.quadraticCurveTo(0, H, 0, H - radius);
      ctx.lineTo(0, radius);
      ctx.quadraticCurveTo(0, 0, radius, 0);
      ctx.closePath();
      ctx.clip();

      // Background
      ctx.fillStyle = t.bg;
      ctx.fillRect(0, 0, W, H);

      // Blob 1
      ctx.beginPath();
      ctx.arc(W - 60 + 110, -80 + 110, 110, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(t.accent, 0.18);
      ctx.fill();

      // Blob 2
      ctx.beginPath();
      ctx.arc(-50 + 80, H - 60 + 80 - 80, 90, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(t.blob2, 0.12);
      ctx.fill();

      // App name
      ctx.fillStyle = t.accent;
      ctx.font = `900 28px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('공폼', W / 2, 52);

      ctx.fillStyle = hexToRgba(t.accent, 0.55);
      ctx.font = `400 11px -apple-system, sans-serif`;
      ctx.fillText('AI 숏폼 학습 플랫폼', W / 2, 70);

      // Streak ring
      const cx = W / 2, cy = H / 2 - 10;
      const ringR = 66;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(t.accent, 0.07);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(t.accent, 0.38);
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Fire emoji
      ctx.font = '28px serif';
      ctx.textAlign = 'center';
      ctx.fillText('🔥', cx, cy - 20);

      // Streak number
      ctx.fillStyle = t.text;
      ctx.font = `900 46px -apple-system, sans-serif`;
      ctx.fillText(String(streak.currentStreak), cx, cy + 26);

      // 일 연속
      ctx.fillStyle = t.sub;
      ctx.font = `400 13px -apple-system, sans-serif`;
      ctx.fillText('일 연속', cx, cy + 48);

      // Milestone badge
      const milestone = getMilestoneLabel(streak.currentStreak);
      if (milestone) {
        const badgeY = cy + ringR + 20;
        const badgeW = 160, badgeH = 28;
        const bx = (W - badgeW) / 2;
        ctx.beginPath();
        ctx.roundRect(bx, badgeY, badgeW, badgeH, 14);
        ctx.fillStyle = hexToRgba(t.accent, 0.13);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(t.accent, 0.38);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = t.accent;
        ctx.font = `700 12px -apple-system, sans-serif`;
        ctx.fillText(milestone, W / 2, badgeY + 18);
      }

      // Motivational message
      const msg = getMotivationalMessage(streak.currentStreak);
      ctx.fillStyle = t.sub;
      ctx.font = `400 12px -apple-system, sans-serif`;
      ctx.fillText(msg, W / 2, H - 90);

      // Stats box
      const sboxY = H - 72, sboxH = 44;
      ctx.beginPath();
      ctx.roundRect(16, sboxY, W - 32, sboxH, 12);
      ctx.fillStyle = hexToRgba(t.text, 0.05);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(t.text, 0.07);
      ctx.lineWidth = 1;
      ctx.stroke();

      // Stat: 총 학습일
      ctx.fillStyle = t.text;
      ctx.font = `800 18px -apple-system, sans-serif`;
      ctx.fillText(String(streak.totalStudyDays), W / 4, sboxY + 18);
      ctx.fillStyle = t.sub;
      ctx.font = `400 10px -apple-system, sans-serif`;
      ctx.fillText('총 학습일', W / 4, sboxY + 34);

      // Divider
      ctx.beginPath();
      ctx.moveTo(W / 2, sboxY + 8);
      ctx.lineTo(W / 2, sboxY + 36);
      ctx.strokeStyle = hexToRgba(t.text, 0.1);
      ctx.lineWidth = 1;
      ctx.stroke();

      // Stat: 최장 연속
      ctx.fillStyle = t.text;
      ctx.font = `800 18px -apple-system, sans-serif`;
      ctx.fillText(String(streak.longestStreak), (W * 3) / 4, sboxY + 18);
      ctx.fillStyle = t.sub;
      ctx.font = `400 10px -apple-system, sans-serif`;
      ctx.fillText('최장 연속', (W * 3) / 4, sboxY + 34);

      // Tag
      ctx.fillStyle = hexToRgba(t.text, 0.18);
      ctx.font = `400 10px -apple-system, sans-serif`;
      ctx.fillText('#공폼 #AI학습 #연속학습챌린지', W / 2, H - 10);

      canvas.toBlob((blob) => resolve(blob), 'image/png', 1);
    });
  };

  const shareWeb = async () => {
    setSharing(true);
    try {
      const blob = await captureCardWeb();
      if (!blob) { Alert.alert('오류', '이미지 생성에 실패했습니다.'); return; }
      const file = new File([blob], 'gongform-streak.png', { type: 'image/png' });

      if (typeof navigator !== 'undefined' && (navigator as any).share && (navigator as any).canShare?.({ files: [file] })) {
        await (navigator as any).share({
          title: `🔥 ${streak.currentStreak}일 연속 학습 중!`,
          text: `공폼 AI 숏폼 학습 앱으로 ${streak.currentStreak}일 연속 공부하고 있어요!\n#공폼 #AI학습 #연속학습챌린지`,
          files: [file],
        });
      } else {
        // Fallback: 다운로드
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'gongform-streak.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        Alert.alert('다운로드 완료', '이미지를 다운로드했어요! 인스타그램에 직접 올려보세요 📸');
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        Alert.alert('오류', e.message || '공유에 실패했습니다.');
      }
    } finally {
      setSharing(false);
    }
  };

  // Native: react-native-view-shot
  const shareToInstagramNative = async () => {
    setSharing(true);
    try {
      const uri = await captureRef(cardRef, { format: 'png', quality: 1, result: 'tmpfile' });
      const { status, canAskAgain } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        if (!canAskAgain) {
          Alert.alert('권한 필요', '설정 > 앱 > GongForm > 권한에서 사진 접근을 허용해주세요.', [
            { text: '설정 열기', onPress: () => Linking.openSettings() },
            { text: '취소', style: 'cancel' },
          ]);
        } else {
          Alert.alert('권한 필요', '갤러리 저장 권한이 필요합니다.');
        }
        return;
      }
      await MediaLibrary.saveToLibraryAsync(uri);
      Alert.alert('갤러리 저장 완료!', '인스타그램 스토리에서 사진을 선택해 공유하세요 📸', [
        { text: '인스타 열기', onPress: () => Linking.openURL('instagram://') },
        { text: '확인' },
      ]);
    } catch (e: any) {
      Alert.alert('오류', e.message || '캡처에 실패했습니다.');
    } finally {
      setSharing(false);
    }
  };

  const shareGeneralNative = async () => {
    setSharing(true);
    try {
      const uri = await captureRef(cardRef, { format: 'png', quality: 1, result: 'tmpfile' });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: '공폼 스트릭 공유하기' });
      } else {
        Alert.alert('공유 불가', '이 기기에서는 공유 기능을 사용할 수 없습니다.');
      }
    } catch (e: any) {
      Alert.alert('오류', e.message || '공유에 실패했습니다.');
    } finally {
      setSharing(false);
    }
  };

  const handleInstagram = Platform.OS === 'web' ? shareWeb : shareToInstagramNative;
  const handleGeneral = Platform.OS === 'web' ? shareWeb : shareGeneralNative;

  const milestone = getMilestoneLabel(streak.currentStreak);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.sheet} activeOpacity={1} onPress={() => {}}>
          {/* 헤더 */}
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitleRow}>
              <Ionicons name="logo-instagram" size={20} color="#C13584" />
              <Text style={styles.sheetTitle}>인스타에 자랑하기</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color="#888" />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
            {/* 테마 선택 */}
            <View style={styles.themeRow}>
              {THEMES.map((th) => (
                <TouchableOpacity
                  key={th.id}
                  style={[styles.themeBtn, theme === th.id && { borderColor: th.accent, backgroundColor: '#1E1E1E' }]}
                  onPress={() => setTheme(th.id)}
                >
                  <View style={[styles.themeCircle, { backgroundColor: th.bg, borderColor: th.accent + '99' }]} />
                  <Text style={[styles.themeLabel, theme === th.id && { color: '#fff' }]}>{th.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* 카드 미리보기 */}
            <View
              ref={cardRef}
              style={[styles.card, { width: CARD_W, height: CARD_H, backgroundColor: t.bg }]}
              collapsable={false}
            >
              <View style={[styles.blob1, { backgroundColor: t.accent + '2E' }]} />
              <View style={[styles.blob2, { backgroundColor: t.blob2 + '1F' }]} />

              <View style={styles.cardTop}>
                <Text style={[styles.cardApp, { color: t.accent }]}>공폼</Text>
                <Text style={[styles.cardAppSub, { color: t.accent + '8C' }]}>AI 숏폼 학습 플랫폼</Text>
              </View>

              <View style={styles.cardCenter}>
                <View style={[styles.streakRing, { borderColor: t.accent + '60', backgroundColor: t.accent + '12' }]}>
                  <Text style={styles.streakFire}>🔥</Text>
                  <Text style={[styles.streakNum, { color: t.text }]}>{streak.currentStreak}</Text>
                  <Text style={[styles.streakUnit, { color: t.sub }]}>일 연속</Text>
                </View>

                {milestone && (
                  <View style={[styles.milestoneBadge, { backgroundColor: t.accent + '20', borderColor: t.accent + '60' }]}>
                    <Text style={[styles.milestoneText, { color: t.accent }]}>{milestone}</Text>
                  </View>
                )}

                <Text style={[styles.cardMessage, { color: t.sub }]}>
                  {getMotivationalMessage(streak.currentStreak)}
                </Text>
              </View>

              <View style={[styles.cardStats, { backgroundColor: t.text + '0D', borderColor: t.text + '12' }]}>
                <View style={styles.cardStat}>
                  <Text style={[styles.cardStatNum, { color: t.text }]}>{streak.totalStudyDays}</Text>
                  <Text style={[styles.cardStatLabel, { color: t.sub }]}>총 학습일</Text>
                </View>
                <View style={[styles.cardStatDivider, { backgroundColor: t.text + '18' }]} />
                <View style={styles.cardStat}>
                  <Text style={[styles.cardStatNum, { color: t.text }]}>{streak.longestStreak}</Text>
                  <Text style={[styles.cardStatLabel, { color: t.sub }]}>최장 연속</Text>
                </View>
              </View>

              <Text style={[styles.cardTag, { color: t.text + '30' }]}>#공폼 #AI학습 #연속학습챌린지</Text>
            </View>

            {/* 공유 버튼 */}
            {sharing ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color="#4F8EF7" />
                <Text style={styles.loadingText}>이미지 생성 중...</Text>
              </View>
            ) : (
              <View style={styles.btnCol}>
                <TouchableOpacity style={styles.instagramBtn} onPress={handleInstagram}>
                  <View style={styles.instaBtnInner}>
                    <Ionicons name="logo-instagram" size={22} color="#fff" />
                    <View>
                      <Text style={styles.instaBtnTitle}>인스타그램에 자랑하기</Text>
                      <Text style={styles.instaBtnSub}>
                        {Platform.OS === 'web' ? '이미지 다운로드 / 공유' : '갤러리 저장 후 스토리에 공유'}
                      </Text>
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color="#ffffff80" />
                </TouchableOpacity>

                {Platform.OS !== 'web' && (
                  <TouchableOpacity style={styles.generalBtn} onPress={handleGeneral}>
                    <Ionicons name="share-outline" size={18} color="#aaa" />
                    <Text style={styles.generalBtnText}>다른 앱으로 공유</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function getMilestoneLabel(streak: number): string | null {
  const map: Record<number, string> = {
    1: '🌱 첫 학습 달성!', 3: '🌿 3일 연속 달성!', 7: '🎯 7일 달성!',
    14: '👑 14일 달성!', 30: '🏆 30일 달성!', 60: '💎 60일 달성!', 100: '🔥 100일 달성!',
  };
  return map[streak] ?? null;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#111', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    padding: 24, paddingBottom: 40, alignItems: 'center', maxHeight: '95%',
  },
  sheetHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    width: '100%', marginBottom: 20,
  },
  sheetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  scrollContent: { alignItems: 'center', paddingBottom: 8, width: SW - 48 },

  // 테마
  themeRow: { flexDirection: 'row', gap: 10, marginBottom: 20, width: '100%' },
  themeBtn: {
    flex: 1, alignItems: 'center', gap: 6, padding: 10,
    borderRadius: 14, borderWidth: 1.5, borderColor: '#2A2A2A', backgroundColor: '#1A1A1A',
  },
  themeCircle: { width: 28, height: 28, borderRadius: 14, borderWidth: 2 },
  themeLabel: { color: '#666', fontSize: 12, fontWeight: '600' },

  // Card (9:16)
  card: { borderRadius: 24, overflow: 'hidden', padding: 24, justifyContent: 'space-between', alignItems: 'center' },
  blob1: { position: 'absolute', width: 220, height: 220, borderRadius: 110, top: -80, right: -60 },
  blob2: { position: 'absolute', width: 180, height: 180, borderRadius: 90, bottom: 60, left: -50 },
  cardTop: { alignItems: 'center', marginTop: 8, zIndex: 1 },
  cardApp: { fontSize: 36, fontWeight: '900' },
  cardAppSub: { fontSize: 13, marginTop: -4 },
  cardCenter: { alignItems: 'center', gap: 14, flex: 1, justifyContent: 'center', zIndex: 1 },
  streakRing: {
    width: 160, height: 160, borderRadius: 80, borderWidth: 2.5,
    justifyContent: 'center', alignItems: 'center', gap: 2,
  },
  streakFire: { fontSize: 30 },
  streakNum: { fontSize: 52, fontWeight: '900', lineHeight: 56 },
  streakUnit: { fontSize: 14 },
  milestoneBadge: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 6 },
  milestoneText: { fontSize: 14, fontWeight: '700' },
  cardMessage: { fontSize: 14, textAlign: 'center', paddingHorizontal: 12, lineHeight: 20 },
  cardStats: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1,
    borderRadius: 16, padding: 14, width: '100%', zIndex: 1,
  },
  cardStat: { flex: 1, alignItems: 'center' },
  cardStatNum: { fontSize: 26, fontWeight: '800' },
  cardStatLabel: { fontSize: 12, marginTop: 2 },
  cardStatDivider: { width: 1, height: 34 },
  cardTag: { fontSize: 11, textAlign: 'center', marginBottom: 4, zIndex: 1 },

  // Buttons
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 24 },
  loadingText: { color: '#888', fontSize: 14 },
  btnCol: { width: '100%', gap: 10, marginTop: 20 },
  instagramBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderRadius: 16, padding: 16, paddingHorizontal: 18, backgroundColor: '#C13584',
  },
  instaBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  instaBtnTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  instaBtnSub: { color: '#ffffff80', fontSize: 12, marginTop: 2 },
  generalBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: 16, padding: 14, gap: 8,
    backgroundColor: '#1E1E1E', borderWidth: 1, borderColor: '#2A2A2A',
  },
  generalBtnText: { color: '#aaa', fontSize: 14, fontWeight: '600' },
});
