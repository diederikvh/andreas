import { Tabs } from 'expo-router';
import { View } from 'react-native';

import { GuideOverlay } from '@/components/GuideOverlay';
import { TabBar } from '@/components/TabBar';
import { useZoekStore } from '@/store/zoek';

export default function TabsLayout() {
  const guideOpen = useZoekStore((s) => s.guideOpen);
  const closeGuide = useZoekStore((s) => s.closeGuide);
  return (
    <View style={{ flex: 1 }}>
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
      {/* Gids-overlay buiten de Tabs gerenderd zodat 'ie óók over de
          (absolute) TabBar heen valt — anders dekt de menubalk het
          invoerveld onderaan af. */}
      <GuideOverlay visible={guideOpen} onClose={closeGuide} />
    </View>
  );
}
