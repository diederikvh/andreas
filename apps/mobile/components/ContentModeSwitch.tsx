import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { useModeSwitch } from '@/components/ModeCurtain';
import { tinyTap } from '@/lib/haptics';
import { useContentMode, useSetContentMode } from '@/store/contentMode';
import { useMode, useRoles } from '@/store/mode';
import { palette } from '@/theme/tokens';

// Twee-staat segmented control met iconen — muziek = 'uit' (going out),
// palette = 'expo' (cultuur). Tap flipt zowel de content-as als de
// visuele mode (nacht ⇄ dag) via de curtain-animatie. De koppeling is
// bewust 1-op-1: nacht is de going-out-vibe (donker, acid-yellow),
// dag is de planning-vibe (cream, karmijn).
//
// Vervangt de oude dn-switch op de rechter-rij van AppHeader. De
// dn-switch bestaat nog als component voor debug/storybook gevallen,
// maar wordt niet meer gerenderd in de hoofd-UI.
export function ContentModeSwitch() {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const cmode = useContentMode();
  const setCmode = useSetContentMode();
  const switchVisualMode = useModeSwitch();

  // Combined-toggle: flipt content-mode synchronously en triggert de
  // curtain animation die mid-sweep ook de visuele mode flipt. Beide
  // stores eindigen consistent. We doen geen separate visual-mode-set
  // hier — useModeSwitch handelt dat zelf af binnen de curtain.
  const onTap = (next: 'uit' | 'expo') => {
    if (next === cmode) return;
    tinyTap();
    setCmode(next);
    switchVisualMode();
  };

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: isNacht ? palette.noir2 : palette.paper2,
          borderColor: isNacht ? '#2a2a2d' : palette.paper,
        },
      ]}
    >
      <IconPill
        icon="musical-notes"
        active={cmode === 'uit'}
        onPress={() => onTap('uit')}
        activeBg={roles.fg}
        activeFg={roles.bg}
        inactiveFg={roles.fgPlaceholder}
      />
      <IconPill
        icon="color-palette"
        active={cmode === 'expo'}
        onPress={() => onTap('expo')}
        activeBg={roles.fg}
        activeFg={roles.bg}
        inactiveFg={roles.fgPlaceholder}
      />
    </View>
  );
}

function IconPill({
  icon,
  active,
  onPress,
  activeBg,
  activeFg,
  inactiveFg,
}: {
  icon: 'musical-notes' | 'color-palette';
  active: boolean;
  onPress: () => void;
  activeBg: string;
  activeFg: string;
  inactiveFg: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={icon === 'musical-notes' ? 'Uit' : 'Expo'}
      onPress={onPress}
      style={[styles.pill, active && { backgroundColor: activeBg }]}
    >
      <Ionicons
        name={icon}
        size={14}
        color={active ? activeFg : inactiveFg}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Compact-size matched op dn-switch (28px hoog) zodat 'ie naadloos
  // op die plek in de AppHeader past.
  wrap: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    height: 28,
    padding: 2,
    borderRadius: 999,
    borderWidth: 1,
    gap: 2,
  },
  pill: {
    width: 28,
    height: 22,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
