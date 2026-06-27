import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LevelInfo, XP_TABLE } from '@/lib/levelSystem';
import { colors, fonts, radius, text as t } from '@/lib/theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  levelInfo: LevelInfo | null;
  /** @deprecated 디자인 토큰의 display 폰트로 통일. 호환 위해 prop 유지 */
  numberFont?: string;
}

// 각 사유에 카테고리 아이콘 + 색 매핑: 다른 화면(프로젝트 타입 배지·스트릭·AI 생성 등)과 동일 톤 사용해 시각 식별성 통일
const XP_REASONS: {
  reason: keyof typeof XP_TABLE;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  color: string;
}[] = [
  { reason: 'shortform_watched',  label: '개념 정리 시청 완료', icon: 'bulb-outline',         color: '#6398E0' },
  { reason: 'quiz_correct',       label: 'OX 퀴즈 정답',         icon: 'help-circle-outline',  color: '#D5973D' },
  { reason: 'example_correct',    label: '예시 문제 정답',       icon: 'code-slash-outline',   color: '#39AF65' },
  { reason: 'review_correct',     label: '오답 복습 통과',       icon: 'refresh-outline',      color: colors.bad },
  { reason: 'daily_first',        label: '오늘 첫 학습 보너스',  icon: 'sunny-outline',        color: colors.accentYellow },
  { reason: 'streak_milestone',   label: '연속 학습 마일스톤',   icon: 'flame-outline',        color: '#F97316' },
  { reason: 'project_generated',  label: 'AI 생성 완료',         icon: 'sparkles-outline',     color: '#A78BFA' },
];

export function LevelDetailModal({ visible, onClose, levelInfo }: Props) {
  const progress = Math.min(100, Math.max(0, (levelInfo?.progress ?? 0) * 100));
  const xpRemaining = Math.max(0, (levelInfo?.xpNeededForNext ?? 0) - (levelInfo?.xpInCurrentLevel ?? 0));

  return (
    <Modal visible={visible} transparent animationType="fade">
      <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={s.sheet}>
          <View style={s.header}>
            <View style={s.badge}>
              <Ionicons name="trophy-outline" size={26} color={colors.accentYellow} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.lv}>Lv. {levelInfo?.level ?? 1}</Text>
              <Text style={s.xp}>누적 {(levelInfo?.totalXP ?? 0).toLocaleString()} XP</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={20} color={colors.ink2} />
            </TouchableOpacity>
          </View>

          <View style={s.barBg}>
            <View style={[s.barFill, { width: `${progress}%` }]} />
          </View>
          <Text style={s.next}>다음 레벨까지 {xpRemaining.toLocaleString()} XP</Text>

          <Text style={[t.meta, s.sectionTitle]}>XP 적립 방법</Text>
          <View style={s.list}>
            {XP_REASONS.map((r) => (
              <View key={r.reason} style={s.row}>
                <View style={[s.iconBox, { backgroundColor: r.color + '20', borderColor: r.color + '60' }]}>
                  <Ionicons name={r.icon} size={14} color={r.color} />
                </View>
                <Text style={s.label}>{r.label}</Text>
                <Text style={[s.value, { color: r.color }]}>+{XP_TABLE[r.reason]} XP</Text>
              </View>
            ))}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(21,23,28,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  sheet: {
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    padding: 20,
    width: '100%',
    maxWidth: 420,
    borderWidth: 1.5,
    borderColor: colors.stroke,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 14,
  },
  badge: {
    width: 52, height: 52, borderRadius: 14,
    backgroundColor: colors.paper2,
    borderWidth: 1.5, borderColor: colors.stroke,
    alignItems: 'center', justifyContent: 'center',
  },
  lv: { fontFamily: fonts.display, fontSize: 24, color: colors.accentYellow, lineHeight: 28 },
  xp: { fontFamily: fonts.mono, fontSize: 11, color: colors.ink3, marginTop: 2 },
  barBg: {
    height: 8, backgroundColor: colors.ink4,
    borderRadius: 4, overflow: 'hidden',
    marginBottom: 4,
  },
  barFill: { height: '100%', backgroundColor: colors.accentYellow, borderRadius: 4 },
  next: { fontFamily: fonts.mono, fontSize: 11, color: colors.ink3, textAlign: 'right' },
  sectionTitle: { marginTop: 16, marginBottom: 10 },
  list: { gap: 6 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: colors.paper2,
    borderRadius: 10,
    borderWidth: 1, borderColor: colors.strokeSoft,
  },
  iconBox: {
    width: 26, height: 26, borderRadius: 8,
    borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  label: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.ink },
  value: { fontFamily: fonts.display, fontSize: 14, color: colors.accentYellow },
});
