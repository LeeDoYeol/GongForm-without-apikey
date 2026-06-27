import { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { addStudySeconds, formatStudyTime } from '@/lib/studyTime';

interface Props {
  userId: string | null | undefined;
  /** 오늘까지 저장된 누적 순공 시간(초). 진행 중 swElapsed는 컴포넌트가 더해서 표시 */
  baseStudySec: number;
  /** 저장 성공 시 호출: 부모는 studyTimeMap 재로딩 */
  onSaved: () => Promise<void> | void;
}

export function StopwatchCard({ userId, baseStudySec, onSaved }: Props) {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [savedMsg, setSavedMsg] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);
  const baseRef = useRef<number>(0); // 일시정지까지 누적된 초
  const runningRef = useRef(false);  // blur 클로저에서 접근용

  const start = useCallback(() => {
    startRef.current = Date.now();
    intervalRef.current = setInterval(() => {
      setElapsed(baseRef.current + Math.floor((Date.now() - startRef.current) / 1000));
    }, 500);
    runningRef.current = true;
    setRunning(true);
    setSavedMsg(false);
  }, []);

  const pause = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    baseRef.current += Math.floor((Date.now() - startRef.current) / 1000);
    setElapsed(baseRef.current);
    runningRef.current = false;
    setRunning(false);
  }, []);

  const reset = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    baseRef.current = 0;
    runningRef.current = false;
    setElapsed(0);
    setRunning(false);
    setSavedMsg(false);
  }, []);

  const save = useCallback(async () => {
    if (!userId) return;
    // ref에서 직접 계산 → state의 stale 문제 없음
    const finalElapsed = runningRef.current
      ? baseRef.current + Math.floor((Date.now() - startRef.current) / 1000)
      : baseRef.current;
    if (finalElapsed < 1) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    runningRef.current = false;
    setRunning(false);
    await addStudySeconds(userId, finalElapsed);
    await onSaved();
    baseRef.current = 0;
    setElapsed(0);
    setSavedMsg(true);
  }, [userId, onSaved]);

  // 언마운트 시 인터벌 정리
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // 화면 떠날 때 자동 일시정지 → 쇼츠 시청 시간과 중복 집계 방지
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (runningRef.current) pause();
      };
    }, [pause])
  );

  const todayTotalSec = baseStudySec + elapsed;

  return (
    <View style={s.card}>
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Ionicons name="time-outline" size={18} color="#4F8EF7" />
          <Text style={s.title}>오늘 순공</Text>
        </View>
        <Text style={s.total}>{formatStudyTime(todayTotalSec)}</Text>
      </View>

      <View style={s.row}>
        <Text style={s.time}>{formatStudyTime(elapsed)}</Text>
        <View style={s.btns}>
          {!running ? (
            <TouchableOpacity style={[s.btn, s.btnStart]} onPress={start}>
              <Ionicons name="play" size={14} color="#fff" />
              <Text style={s.btnText}>{elapsed > 0 ? '계속' : '시작'}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[s.btn, s.btnPause]} onPress={pause}>
              <Ionicons name="pause" size={14} color="#fff" />
              <Text style={s.btnText}>일시정지</Text>
            </TouchableOpacity>
          )}
          {elapsed > 0 && !running && (
            <TouchableOpacity style={[s.btn, s.btnSave]} onPress={save}>
              <Ionicons name="checkmark" size={14} color="#fff" />
              <Text style={s.btnText}>저장</Text>
            </TouchableOpacity>
          )}
          {elapsed > 0 && (
            <TouchableOpacity style={[s.btn, s.btnReset]} onPress={reset}>
              <Ionicons name="refresh" size={14} color="#aaa" />
            </TouchableOpacity>
          )}
        </View>
      </View>
      {savedMsg && <Text style={s.savedMsg}>✓ 저장되었습니다</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#161616',
    borderRadius: 22,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: '#aaa', fontWeight: '700', fontSize: 13 },
  total: { color: '#4F8EF7', fontSize: 16, fontWeight: '800' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0D0D0D',
    borderRadius: 16,
    padding: 10,
    marginTop: 10,
  },
  time: { color: '#fff', fontSize: 20, fontWeight: '800', minWidth: 88, fontVariant: ['tabular-nums'] },
  btns: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
  },
  btnStart: { backgroundColor: '#4F8EF7' },
  btnPause: { backgroundColor: '#F97316' },
  btnSave: { backgroundColor: '#22C55E' },
  btnReset: { backgroundColor: '#2A2A2A', paddingHorizontal: 10 },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  savedMsg: { color: '#22C55E', fontSize: 12, marginTop: 8, textAlign: 'center' },
});
