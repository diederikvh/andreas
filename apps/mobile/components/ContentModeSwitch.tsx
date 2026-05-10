import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { useModeSwitch } from '@/components/ModeCurtain';
import { tinyTap } from '@/lib/haptics';
import { useContentMode, useSetContentMode } from '@/store/contentMode';
import { useMode, useRoles } from '@/store/mode';
import { palette } from '@/theme/tokens';

// Twee-staat toggle met iconen — maan = 'uit' (going out, nacht), zon
// = 'expo' (cultuur, dag). De héle pill is tappable: een tap (waar dan
// ook) flipt naar de andere stand. Iconen zijn puur visuele
// indicatoren van de huidige staat. Flipt zowel de content-as als de
// visuele mode (nacht ⇄ dag) via de curtain-animatie. Koppeling is
// 1-op-1: nacht is de going-out-vibe (donker, acid-yellow), dag de
// planning-vibe (cream, karmijn).
//
// Vervangt de oude dn-switch op de rechter-rij van AppHeader.
export function ContentModeSwitch() {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const cmode = useContentMode();
  const setCmode = useSetContentMode();
  const switchVisualMode = useModeSwitch();

  // Combined-toggle: flipt content-mode synchronously en triggert de
  // curtain animation die mid-sweep ook de visuele mode flipt. Beide
  // stores eindigen consistent.
  const onToggle = () => {
    tinyTap();
    setCmode(cmode === 'uit' ? 'expo' : 'uit');
    switchVisualMode();
  };

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: cmode === 'expo' }}
      accessibilityLabel={cmode === 'uit' ? 'Uit' : 'Expo'}
      onPress={onToggle}
      hitSlop={6}
      style={[
        styles.wrap,
        {
          backgroundColor: isNacht ? palette.noir2 : palette.paper2,
          borderColor: isNacht ? '#2a2a2d' : palette.paper,
        },
      ]}
    >
      <IconSlot
        icon="moon"
        active={cmode === 'uit'}
        activeBg={roles.fg}
        activeFg={roles.bg}
        inactiveFg={roles.fgPlaceholder}
      />
      <IconSlot
        icon="sunny"
        active={cmode === 'expo'}
        activeBg={roles.fg}
        activeFg={roles.bg}
        inactiveFg={roles.fgPlaceholder}
      />
    </Pressable>
  );
}

function IconSlot({
  icon,
  active,
  activeBg,
  activeFg,
  inactiveFg,
}: {
  icon: 'moon' | 'sunny';
  active: boolean;
  activeBg: string;
  activeFg: string;
  inactiveFg: string;
}) {
  return (
    <View
      style={[styles.slot, active && { backgroundColor: activeBg }]}
    >
      <Ionicons
        name={icon}
        size={14}
        color={active ? activeFg : inactiveFg}
      />
    </View>
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
  slot: {
    width: 28,
    height: 22,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
