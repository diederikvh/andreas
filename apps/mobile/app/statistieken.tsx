import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { MirrorSection } from '@/app/jij';
import { useIsRegistered } from '@/lib/authClient';
import { useT } from '@/lib/i18n';
import { useRoles } from '@/store/mode';

/**
 * Je persoonlijke spiegel, op een eigen scherm.
 *
 * Stond uitgeklapt op /jij en duwde alles naar beneden. Een profiel is
 * een plek waar je iets doet — foto wijzigen, iemand toevoegen — en dit
 * is iets wat je leest. Nu achter een knop, zoals Diederik vroeg.
 */
export default function StatistiekenScreen() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const authed = useIsRegistered();

  const closeBtn = (
    <Pressable onPress={() => router.back()} hitSlop={8} style={styles.closeBtn}>
      <Ionicons name="close" size={20} color={roles.fg} />
    </Pressable>
  );

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT + 8,
          paddingBottom: insets.bottom + 96,
        }}
      >
        <MirrorSection authed={authed} />
      </ScrollView>

      <AppHeader
        title={t('Statistieken', 'Statistics')}
        hideAvatar
        rightSlot={closeBtn}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
