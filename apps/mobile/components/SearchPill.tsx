/**
 * Search-pill — visueel een input-veld met loep + placeholder, maar
 * functioneel een Pressable die de SearchOverlay activeert. Echte
 * TextInput leeft in die overlay (auto-focus + keyboard); de pill
 * blijft alleen achter als visual.
 *
 * Plaatsing: bovenaan /avond, tussen featured-carousel en shortcuts.
 * IMDB-pattern: één entrypoint dat zowel venues als events doorzoekt.
 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useT } from '@/lib/i18n';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

export function SearchPill({ onPress }: { onPress: () => void }) {
  const roles = useRoles();
  const t = useT();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.wrap,
        {
          backgroundColor: roles.bgLift,
          borderColor: roles.bgChip,
        },
      ]}
    >
      <Ionicons name="search" size={18} color={roles.fgMuted} />
      <Text
        style={[styles.placeholder, { color: roles.fgMuted }]}
        numberOfLines={1}
      >
        {t('Zoek venues, events, artiesten…', 'Search venues, events, artists…')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 22,
    paddingHorizontal: 14,
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
  },
  placeholder: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.1,
  },
});
