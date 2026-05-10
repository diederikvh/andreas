import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { useModeSwitch } from '@/components/ModeCurtain';
import { tinyTap } from '@/lib/haptics';
import { useContentMode, useSetContentMode } from '@/store/contentMode';
import { useMode, useRoles } from '@/store/mode';
import { palette } from '@/theme/tokens';

// Symbool-type voor de twee slots:
// - 'moon': Ionicons-maan voor 'uit' (nacht-vibe).
// - 'sun': een rustige cirkel zonder stralen voor 'expo' (dag-vibe).
type SlotSymbol = 'moon' | 'sun';

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
        activeBg={roles.accent}
        activeFg={roles.onAccent}
        inactiveFg={roles.fgPlaceholder}
      />
      <IconSlot
        icon="sun"
        active={cmode === 'expo'}
        activeBg={roles.accent}
        activeFg={roles.onAccent}
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
  icon: SlotSymbol;
  active: boolean;
  activeBg: string;
  activeFg: string;
  inactiveFg: string;
}) {
  const fg = active ? activeFg : inactiveFg;
  return (
    <View
      style={[styles.slot, active && { backgroundColor: activeBg }]}
    >
      {icon === 'moon' ? (
        <Ionicons name="moon" size={14} color={fg} />
      ) : (
        // Bewust géén Ionicons.sunny met stralen — een platte cirkel
        // is rustiger en past beter bij de minimalistische dn-switch
        // estetiek.
        <View style={[styles.sunDot, { backgroundColor: fg }]} />
      )}
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
  // Plat cirkeltje voor de zon — visueel iets kleiner dan het maan-
  // glyph zodat ze optisch even zwaar lezen.
  sunDot: {
    width: 11,
    height: 11,
    borderRadius: 999,
  },
});
