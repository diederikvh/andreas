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
      {/* Kaart blijft een route maar staat niet in de tab-bar — wordt
          bereikt vanuit Avond via een banner-knop. */}
      <Tabs.Screen name="kaart" options={{ href: null }} />
      <Tabs.Screen name="venues" />
      <Tabs.Screen name="social" />
      <Tabs.Screen name="jij" />
    </Tabs>
  );
}
