import { Tabs } from 'expo-router';

import { TabBar } from '@/components/TabBar';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <TabBar {...props} />}
    >
      <Tabs.Screen name="avond" />
      <Tabs.Screen name="agenda" />
      <Tabs.Screen name="kaart" />
      <Tabs.Screen name="gered" />
      <Tabs.Screen name="jij" />
    </Tabs>
  );
}
