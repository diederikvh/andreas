import { Tabs } from 'expo-router';
import { View } from 'react-native';

import { GuideOverlay } from '@/components/GuideOverlay';
import { SearchOverlay } from '@/components/SearchOverlay';
import { TabBar } from '@/components/TabBar';
import { useZoekStore } from '@/store/zoek';

export default function TabsLayout() {
  const guideOpen = useZoekStore((s) => s.guideOpen);
  const closeGuide = useZoekStore((s) => s.closeGuide);
  const searchOpen = useZoekStore((s) => s.searchOpen);
  const closeSearch = useZoekStore((s) => s.closeSearch);
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
        {/* Venues zat in de tab-bar maar is bladermateriaal, geen
            dagelijkse ingang — verhuisd naar Meer, net als Kaart. */}
        <Tabs.Screen name="venues" options={{ href: null }} />
        <Tabs.Screen name="social" />
        <Tabs.Screen name="meer" />
      </Tabs>
      {/* Gids-overlay buiten de Tabs gerenderd zodat 'ie óók over de
          (absolute) TabBar heen valt — anders dekt de menubalk het
          invoerveld onderaan af. */}
      <GuideOverlay visible={guideOpen} onClose={closeGuide} />
      {/* Zelfde reden als de gids: de zoek-knop zit in de AppHeader en
          moet vanaf elke tab kunnen openen, óók over de TabBar heen. */}
      <SearchOverlay visible={searchOpen} onClose={closeSearch} />
    </View>
  );
}
