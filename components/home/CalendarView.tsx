import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getActivityForDate, DailyActivity } from '@/lib/dailyActivity';
import { SingleDayChart, SingleDayStats } from '@/components/ActivityChart';
import { colors, fonts, radius } from '@/lib/theme';

interface Props {
  studyDates: string[];
  studyTimeMap: Record<string, number>;
  month: Date;
  onPrev: () => void;
  onNext: () => void;
  userId: string | null;
}

export function CalendarView({ studyDates, studyTimeMap, month, onPrev, onNext, userId }: Props) {
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [selectedActivity, setSelectedActivity] = useState<DailyActivity | null>(null);

  const year = month.getFullYear();
  const mon = month.getMonth();

  useEffect(() => {
    if (selectedDay === null || !userId) { setSelectedActivity(null); return; }
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${year}-${pad2(mon + 1)}-${pad2(selectedDay)}`;
    let alive = true;
    getActivityForDate(userId, dateStr).then((a) => { if (alive) setSelectedActivity(a); }).catch(() => {});
    return () => { alive = false; };
  }, [selectedDay, year, mon, userId]);

  const dateSet = new Set(studyDates);
  const today = new Date();
  const firstDay = new Date(year, mon, 1).getDay();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(d);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) weeks.push([...week, ...Array(7 - week.length).fill(null)]);

  const pad = (n: number) => String(n).padStart(2, '0');
  const dateKey = (d: number) => `${year}-${pad(mon + 1)}-${pad(d)}`;
  const isStudied = (d: number) => dateSet.has(dateKey(d));
  const isToday = (d: number) => today.getFullYear() === year && today.getMonth() === mon && today.getDate() === d;
  const getTime = (d: number) => studyTimeMap[dateKey(d)] ?? 0;

  const monthName = `${year}년 ${mon + 1}월`;
  const studiedThisMonth = Array.from({ length: daysInMonth }, (_, i) => i + 1).filter(isStudied).length;
  const totalSecThisMonth = Array.from({ length: daysInMonth }, (_, i) => i + 1).reduce((acc, d) => acc + getTime(d), 0);

  function shortTime(seconds: number): string {
    if (seconds < 60) return `${seconds}초`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}분`;
    return `${Math.floor(m / 60)}h`;
  }

  const selectedSecs = selectedDay !== null ? getTime(selectedDay) : 0;
  const selectedStudied = selectedDay !== null ? isStudied(selectedDay) : false;

  return (
    <View>
      <View style={s.calHeader}>
        <TouchableOpacity onPress={() => { onPrev(); setSelectedDay(null); }} style={s.navBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={20} color={colors.ink} />
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={s.calTitle}>{monthName}</Text>
          <View style={{ flexDirection: 'row', marginTop: 2 }}>
            {studiedThisMonth > 0 && (
              <Text style={s.calSub}>{studiedThisMonth}일 학습</Text>
            )}
            {totalSecThisMonth > 0 && (
              <Text style={[s.calSub, { color: colors.accent, marginLeft: 8 }]}>
                {shortTime(totalSecThisMonth)} 순공
              </Text>
            )}
          </View>
        </View>
        <TouchableOpacity onPress={() => { onNext(); setSelectedDay(null); }} style={s.navBtn} hitSlop={8}>
          <Ionicons name="chevron-forward" size={20} color={colors.ink} />
        </TouchableOpacity>
      </View>

      <View style={{ flexDirection: 'row', marginBottom: 4 }}>
        {['일', '월', '화', '수', '목', '금', '토'].map((d) => (
          <Text key={d} style={s.dayLabel}>{d}</Text>
        ))}
      </View>

      {weeks.map((week, wi) => (
        <View key={wi} style={{ flexDirection: 'row', marginBottom: 4 }}>
          {week.map((d, di) => {
            const secs = d !== null ? getTime(d) : 0;
            const isSelected = d === selectedDay;
            const studied = d !== null && isStudied(d);
            const todayCell = d !== null && isToday(d);
            return (
              <View key={di} style={{ flex: 1, alignItems: 'center' }}>
                {d !== null && (
                  <TouchableOpacity
                    onPress={() => setSelectedDay((prev) => (prev === d ? null : d))}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        s.dayCell,
                        studied && { backgroundColor: colors.accent, borderColor: colors.accent },
                        todayCell && !studied && { borderColor: colors.accent, borderWidth: 1.5 },
                        isSelected && { backgroundColor: colors.accentDeep, borderColor: colors.accentDeep },
                      ]}
                    >
                      <Text
                        style={[
                          s.dayNum,
                          studied && { color: colors.paper },
                          isSelected && { color: colors.paper },
                        ]}
                      >
                        {d}
                      </Text>
                      {secs >= 60 && (
                        <Text style={[s.timeTag, (studied || isSelected) && { color: colors.paper }]}>
                          {shortTime(secs)}
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>
      ))}

      {selectedDay !== null && (
        <View style={s.detailBox}>
          <Text style={s.detailDate}>{year}년 {mon + 1}월 {selectedDay}일</Text>
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="checkmark-circle-outline" size={18} color={selectedStudied ? colors.accent : colors.ink4} />
              <Text style={[s.detailLabel, { color: selectedStudied ? colors.accent : colors.ink4 }]}>
                {selectedStudied ? '학습 완료' : '학습 없음'}
              </Text>
            </View>
          </View>
          {selectedActivity && (
            <View style={s.detailDivider}>
              <SingleDayChart activity={selectedActivity} />
            </View>
          )}
          {selectedActivity && (
            <View style={s.detailDivider}>
              <SingleDayStats secs={selectedSecs} activity={selectedActivity} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  calHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  navBtn: { padding: 6 },
  calTitle: { fontFamily: fonts.body, fontSize: 16, color: colors.ink },
  calSub: { fontFamily: fonts.mono, fontSize: 11, color: colors.accent },
  dayLabel: { flex: 1, textAlign: 'center', fontFamily: fonts.body, fontSize: 12, color: colors.ink3 },
  dayCell: {
    width: 36, height: 42, borderRadius: 10,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 0, borderColor: 'transparent',
  },
  dayNum: { fontFamily: fonts.body, fontSize: 13, color: colors.ink2 },
  timeTag: { fontFamily: fonts.mono, fontSize: 9, color: colors.ink3, marginTop: 1 },
  detailBox: {
    marginTop: 12,
    borderWidth: 1.5,
    borderColor: colors.stroke,
    backgroundColor: colors.paper2,
    borderRadius: radius.md,
    padding: 12,
  },
  detailDate: { fontFamily: fonts.body, fontSize: 14, color: colors.ink, marginBottom: 8 },
  detailLabel: { fontFamily: fonts.body, fontSize: 13 },
  detailDivider: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.strokeSoft },
});
