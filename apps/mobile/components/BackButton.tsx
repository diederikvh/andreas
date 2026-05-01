import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { useMode, useRoles } from '@/store/mode';
import { palette } from '@/theme/tokens';

/**
 * Standaard back-button voor schermen zonder hero-photo. Subtiele
 * bg-tint (matcht de chip-row), geen border. Voor schermen mét hero
 * (event detail, venue detail) gebruiken we de transparante CircleButton
 * in die files — daar zorgt de foto eronder voor contrast.
 */
export function BackButton({
  onPress,
  size = 40,
}: {
  onPress?: () => void;
  size?: number;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const handlePress = onPress ?? (() => router.back());
  return (
    <Pressable
      onPress={handlePress}
      hitSlop={6}
      style={[
        styles.btn,
        {
          width: size,
          height: size,
          backgroundColor: isNacht ? palette.noir2 : palette.paper2,
        },
      ]}
    >
      <Ionicons name="chevron-back" size={20} color={roles.fg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
