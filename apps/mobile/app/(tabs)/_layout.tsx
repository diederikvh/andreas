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
      {/* Kaart is een verborgen tab — niet in de TabBar zichtbaar,
          wordt bereikt via de banner op Avond. Blijft binnen de
          tabs-group zodat de TabBar onderin zichtbaar blijft. */}
      <Tabs.Screen name="kaart" options={{ href: null }} />
      <Tabs.Screen name="venues" />
      <Tabs.Screen name="social" />
    </Tabs>
  );
}
