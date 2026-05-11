import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { useModeSwitch } from '@/components/ModeCurtain';
import { useMode, useRoles } from '@/store/mode';
import { palette } from '@/theme/tokens';

/**
 * Nacht/Dag visuele-mode toggle als pill. Was eerst rechtsboven in
 * AppHeader; sinds de IA-shift staat de content-mode-switch (Uit/Expo)
 * op die plek, dn-switch verhuisde naar /jij omdat 'ie typisch
 * eens-per-dag wordt aangetikt en geen vluchtige interactie is.
 */
export function DnSwitch() {
  const mode = useMode();
  const roles = useRoles();
  const switchMode = useModeSwitch();
  const isNacht = mode === 'nacht';

  const trackBg = isNacht ? 'rgba(31,31,35,0.7)' : 'rgba(235,230,216,0.7)';
  const trackBorder = isNacht ? '#2a2a2d' : palette.paper;
  const idle = roles.fgPlaceholder;

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: isNacht }}
      onPress={() => switchMode()}
      hitSlop={8}
      style={[
        styles.track,
        { backgroundColor: trackBg, borderColor: trackBorder },
      ]}
    >
      <View style={[styles.glyph, styles.sun, { backgroundColor: idle }]} />
      <Ionicons
        name="moon"
        size={12}
        color={idle}
        style={styles.moonIcon}
      />
      <View
        style={[
          styles.thumb,
          {
            backgroundColor: roles.accent,
            left: isNacht ? undefined : 2,
            right: isNacht ? 2 : undefined,
          },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: 52,
    height: 28,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
  },
  glyph: {
    position: 'absolute',
    top: '50%',
    marginTop: -5,
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  sun: { left: 8 },
  moonIcon: {
    position: 'absolute',
    top: '50%',
    right: 7,
    marginTop: -6,
  },
  thumb: {
    position: 'absolute',
    top: '50%',
    marginTop: -11,
    width: 22,
    height: 22,
    borderRadius: 999,
  },
});
