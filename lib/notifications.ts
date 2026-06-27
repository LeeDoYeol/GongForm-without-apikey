import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const SETTINGS_KEY = 'reminder_settings';

export interface ReminderSettings {
  enabled: boolean;
  hour: number;   // 0~23
  minute: number; // 0~59
}

const DEFAULT_SETTINGS: ReminderSettings = { enabled: false, hour: 20, minute: 0 };

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowList: true,
  }),
});

export async function getReminderSettings(): Promise<ReminderSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveReminderSettings(settings: ReminderSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false; // 웹은 scheduleNotification 미지원
  // expo-modules-core 의 `PermissionResponse` 타입이 `expo-modules-core/types`로 노출되지 않아
  // (.granted/.status가 타입에 없음) any 캐스팅으로 우회. 런타임에는 정상.
  const existing: any = await Notifications.getPermissionsAsync();
  if (existing.status === 'granted' || existing.granted) return true;
  const result: any = await Notifications.requestPermissionsAsync();
  return result.status === 'granted' || result.granted;
}

export async function scheduleDailyReminder(settings: ReminderSettings): Promise<void> {
  if (Platform.OS === 'web') {
    throw new Error('웹에서는 로컬 알림이 지원되지 않습니다.');
  }
  // 기존 예약 전부 취소 후 재설정
  await Notifications.cancelAllScheduledNotificationsAsync();
  if (!settings.enabled) return;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('daily-reminder', {
      name: '학습 리마인드',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#4F8EF7',
    });
  }

  // expo-notifications 0.32 (SDK 54): DAILY trigger 사용. channelId는 trigger에 들어가야 함.
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '📚 오늘 학습하셨나요?',
      body: '공폼에서 오늘의 숏폼 학습을 이어가세요!',
      sound: 'default',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: settings.hour,
      minute: settings.minute,
      ...(Platform.OS === 'android' ? { channelId: 'daily-reminder' } : {}),
    },
  });
}

export async function cancelReminder(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

export function formatTime(hour: number, minute: number): string {
  const ampm = hour < 12 ? '오전' : '오후';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const m = String(minute).padStart(2, '0');
  return `${ampm} ${h}:${m}`;
}
