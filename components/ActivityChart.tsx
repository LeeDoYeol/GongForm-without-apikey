// 일별 학습 활동 막대그래프 (스택형): 타입별 색상 구분.
// 한 막대 = 하루, 세로로 4개 색이 쌓여 총량 표시.
import { View, Text, StyleSheet } from 'react-native';
import { DailyActivity } from '@/lib/dailyActivity';

const COLOR_CONCEPT = '#4F8EF7'; // 개념
const COLOR_EXAMPLE = '#22C55E'; // 예시
const COLOR_QUIZ = '#F97316';    // OX
const COLOR_WRONG = '#EF4444';   // 오답

const BAR_H = 110;

interface DayData {
  date: string;
  activity: DailyActivity;
}

function dayLabel(dateStr: string): string {
  // YYYY-MM-DD → "D" (오늘은 "오늘"). 로컬(=한국) 기준, dailyActivity의 키와 동일 포맷.
  const n = new Date();
  const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  if (dateStr === today) return '오늘';
  const d = new Date(dateStr + 'T00:00:00');
  return String(d.getDate());
}

export function WeeklyActivityChart({ data }: { data: DayData[] }) {
  // data는 최신 → 과거 순. 그래프는 과거 → 최신으로 reverse.
  const days = [...data].reverse();
  const totals = days.map((d) => d.activity.concept + d.activity.example + d.activity.quiz + d.activity.wrong);
  const max = Math.max(1, ...totals); // 0 division 방지

  return (
    <View style={styles.wrap}>
      <View style={styles.chart}>
        {days.map((d) => {
          const a = d.activity;
          const total = a.concept + a.example + a.quiz + a.wrong;
          const ratio = total / max;
          const barH = ratio * BAR_H;
          // 각 세그먼트 높이 (전체 막대 높이 기준)
          const seg = (n: number) => (total > 0 ? (n / total) * barH : 0);
          return (
            <View key={d.date} style={styles.col}>
              <Text style={styles.colTotal}>{total > 0 ? total : ''}</Text>
              <View style={styles.barBg}>
                <View style={styles.barInner}>
                  {/* 위에서부터 쌓임: 빨강(오답)→주황(OX)→녹색(예시)→파랑(개념) */}
                  {a.wrong > 0 && <View style={{ height: seg(a.wrong), backgroundColor: COLOR_WRONG }} />}
                  {a.quiz > 0 && <View style={{ height: seg(a.quiz), backgroundColor: COLOR_QUIZ }} />}
                  {a.example > 0 && <View style={{ height: seg(a.example), backgroundColor: COLOR_EXAMPLE }} />}
                  {a.concept > 0 && <View style={{ height: seg(a.concept), backgroundColor: COLOR_CONCEPT }} />}
                </View>
              </View>
              <Text style={styles.colLabel}>{dayLabel(d.date)}</Text>
            </View>
          );
        })}
      </View>
      <View style={styles.legend}>
        <LegendDot color={COLOR_CONCEPT} label="개념" />
        <LegendDot color={COLOR_EXAMPLE} label="예시" />
        <LegendDot color={COLOR_QUIZ} label="OX" />
        <LegendDot color={COLOR_WRONG} label="오답" />
      </View>
    </View>
  );
}

/** 하루치 학습 활동: 가로 막대 (캘린더 선택일 상세용) */
export function SingleDayChart({ activity }: { activity: DailyActivity }) {
  const total = activity.concept + activity.example + activity.quiz + activity.wrong;
  const rows = [
    { color: COLOR_CONCEPT, label: '개념', count: activity.concept },
    { color: COLOR_EXAMPLE, label: '예시', count: activity.example },
    { color: COLOR_QUIZ, label: 'OX',   count: activity.quiz    },
    { color: COLOR_WRONG, label: '오답', count: activity.wrong   },
  ];
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <View style={singleStyles.wrap}>
      {total === 0 ? (
        <Text style={singleStyles.empty}>학습 기록이 없어요</Text>
      ) : (
        rows.map((r) => (
          <View key={r.label} style={singleStyles.row}>
            <View style={[singleStyles.dot, { backgroundColor: r.color }]} />
            <Text style={singleStyles.label}>{r.label}</Text>
            <View style={singleStyles.barBg}>
              <View
                style={[
                  singleStyles.barFill,
                  { width: `${(r.count / max) * 100}%`, backgroundColor: r.color },
                ]}
              />
            </View>
            <Text style={singleStyles.count}>{r.count}</Text>
          </View>
        ))
      )}
      {total > 0 && (
        <Text style={singleStyles.totalText}>총 {total}개 학습</Text>
      )}
    </View>
  );
}

/** 주간 순공 시간 막대그래프 (초 단위). studyTimeMap: { 'YYYY-MM-DD': seconds } */
export function WeeklyStudyTimeChart({ data, studyTimeMap }: { data: DayData[]; studyTimeMap: Record<string, number> }) {
  const days = [...data].reverse();
  const values = days.map((d) => studyTimeMap[d.date] ?? 0);
  const max = Math.max(60, ...values); // 최소 1분 기준
  const fmt = (s: number) => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}분`;
    return `${Math.floor(m / 60)}h${m % 60 > 0 ? (m % 60) + '분' : ''}`;
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.chart}>
        {days.map((d, i) => {
          const v = values[i];
          const ratio = v / max;
          const barH = ratio * BAR_H;
          return (
            <View key={d.date} style={styles.col}>
              <Text style={styles.colTotal}>{v > 0 ? fmt(v) : ''}</Text>
              <View style={styles.barBg}>
                <View style={styles.barInner}>
                  {v > 0 && <View style={{ height: barH, backgroundColor: '#4F8EF7' }} />}
                </View>
              </View>
              <Text style={styles.colLabel}>{dayLabel(d.date)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** 주간 정답률 막대그래프. quiz / (quiz + wrong), 데이터 없는 날은 빈 막대. */
export function WeeklyAccuracyChart({ data }: { data: DayData[] }) {
  const days = [...data].reverse();
  return (
    <View style={styles.wrap}>
      <View style={styles.chart}>
        {days.map((d) => {
          const a = d.activity;
          const total = a.quiz + a.wrong;
          const acc = total > 0 ? a.quiz / total : 0;
          const barH = acc * BAR_H;
          // 60% 이상 녹색, 30~60% 노랑, 그 아래는 빨강
          const color = acc >= 0.6 ? '#22C55E' : acc >= 0.3 ? '#FBBF24' : total > 0 ? '#EF4444' : '#333';
          return (
            <View key={d.date} style={styles.col}>
              <Text style={styles.colTotal}>{total > 0 ? `${Math.round(acc * 100)}%` : ''}</Text>
              <View style={styles.barBg}>
                <View style={styles.barInner}>
                  {total > 0 && <View style={{ height: Math.max(2, barH), backgroundColor: color }} />}
                </View>
              </View>
              <Text style={styles.colLabel}>{dayLabel(d.date)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** 하루치 순공 시간 + 정답률 가로 막대 */
export function SingleDayStats({ secs, activity }: { secs: number; activity: DailyActivity }) {
  const fmtTime = (s: number) => {
    if (s < 60) return `${s}초`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}분 ${s % 60 > 0 ? (s % 60) + '초' : ''}`.trim();
    return `${Math.floor(m / 60)}시간 ${m % 60}분`;
  };
  // 1시간을 기준으로 가로 막대 너비 산정 (1시간 이상이면 100%)
  const TIME_REF = 3600;
  const timeRatio = Math.min(1, secs / TIME_REF);
  const quizTotal = activity.quiz + activity.wrong;
  const acc = quizTotal > 0 ? activity.quiz / quizTotal : 0;
  const accColor = acc >= 0.6 ? '#22C55E' : acc >= 0.3 ? '#FBBF24' : '#EF4444';

  return (
    <View style={singleStyles.wrap}>
      {/* 순공 시간 */}
      <View style={singleStyles.row}>
        <View style={[singleStyles.dot, { backgroundColor: '#4F8EF7' }]} />
        <Text style={singleStyles.label}>순공</Text>
        <View style={singleStyles.barBg}>
          <View
            style={[
              singleStyles.barFill,
              { width: `${timeRatio * 100}%`, backgroundColor: '#4F8EF7' },
            ]}
          />
        </View>
        <Text style={singleStyles.count}>{secs > 0 ? fmtTime(secs) : '-'}</Text>
      </View>
      {/* 정답률 */}
      <View style={singleStyles.row}>
        <View style={[singleStyles.dot, { backgroundColor: accColor }]} />
        <Text style={singleStyles.label}>정답률</Text>
        <View style={singleStyles.barBg}>
          <View
            style={[
              singleStyles.barFill,
              { width: `${acc * 100}%`, backgroundColor: accColor },
            ]}
          />
        </View>
        <Text style={singleStyles.count}>
          {quizTotal > 0 ? `${Math.round(acc * 100)}%` : '-'}
        </Text>
      </View>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 10,
  },
  // 컬럼은 flex:1로 늘어나되, 막대 자체만 maxWidth로 제한.
  // → 좌우 여백 없이 균등 분포, 막대만 적당히 굵음.
  col: { flex: 1, alignItems: 'center', gap: 4 },
  colTotal: { color: '#888', fontSize: 10, fontWeight: '700', minHeight: 14 },
  barBg: {
    width: '100%',
    maxWidth: 52,
    height: BAR_H,
    borderRadius: 12,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  barInner: {
    width: '100%',
    flexDirection: 'column-reverse', // 아래에서 위로 쌓이게
  },
  colLabel: { color: '#aaa', fontSize: 10, fontWeight: '700' },
  legend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    paddingTop: 4,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { color: '#888', fontSize: 11, fontWeight: '600' },
});

const singleStyles = StyleSheet.create({
  wrap: { gap: 10 },
  empty: { color: '#666', fontSize: 13, textAlign: 'center', paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { color: '#aaa', fontSize: 12, fontWeight: '600', width: 32 },
  barBg: {
    flex: 1, height: 18,
    backgroundColor: '#222', borderRadius: 9,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 9 },
  count: { color: '#ccc', fontSize: 12, fontWeight: '700', minWidth: 28, textAlign: 'right' },
  totalText: { color: '#666', fontSize: 11, textAlign: 'right', marginTop: 4 },
});
