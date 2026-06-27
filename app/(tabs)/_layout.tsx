import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/lib/theme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// Hi-fi 다크 탭 아이콘: focused 시 filled, 아니면 outline. 박스 wrapper 없이 깔끔.
function TabIcon({ name, focused }: { name: IoniconName; focused: boolean }) {
  return (
    <Ionicons
      name={focused ? name : (`${name}-outline` as IoniconName)}
      size={24}
      color={focused ? colors.accent : '#555'}
    />
  );
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const CONTENT_HEIGHT = 70;
  const tabBarHeight = CONTENT_HEIGHT + insets.bottom;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#111',
          borderTopColor: '#1E1E1E',
          height: tabBarHeight,
          paddingTop: 10,
          paddingBottom: insets.bottom > 0 ? insets.bottom + 6 : 10,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: '#555',
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          marginTop: 2,
          marginBottom: 4,
          paddingBottom: 0,
          includeFontPadding: false,
        },
        tabBarIconStyle: { marginTop: 0 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '홈',
          tabBarIcon: ({ focused }) => <TabIcon name="home" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="folders"
        options={{
          title: '프로젝트',
          tabBarIcon: ({ focused }) => <TabIcon name="layers" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="collection"
        options={{
          title: '컬렉션',
          tabBarIcon: ({ focused }) => <TabIcon name="bookmark" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="my"
        options={{
          title: '마이',
          tabBarIcon: ({ focused }) => <TabIcon name="person" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
