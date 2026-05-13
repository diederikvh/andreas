import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { useModeSwitch } from '@/components/ModeCurtain';
import { tinyTap } from '@/lib/haptics';
import { useContentMode, useSetContentMode } from '@/store/contentMode';
import { useMode, useModeStore, useRoles } from '@/store/mode';
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

  // Combined-toggle: triggert de curtain en flipt content-mode op het
  // moment dat de curtain volledig dekkend is (via onCommit), zodat de
  // gebruiker de pill niet ziet omschakelen vóór de curtain hem
  // afdekt. Visuele mode flipt op datzelfde moment. Eerste keer dat
  // 'r gewisseld wordt dismissen we óók de coachmark-hint.
  const onToggle = () => {
    tinyTap();
    useModeStore.getState().dismissContentSwitchHint();
    const next = cmode === 'uit' ? 'expo' : 'uit';
    switchVisualMode(() => {
      setCmode(next);
    });
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
  // Op de actieve, brand-gekleurde achtergrond zakken de glyphs naar
  // 30% opacity — laat de accent-kleur dominant zijn als 'jij staat
  // hier'-signaal, glyph wordt een rustige hint.
  const glyphOpacity = active ? 0.3 : 1;
  return (
    <View
      style={[styles.slot, active && { backgroundColor: activeBg }]}
    >
      {icon === 'moon' ? (
        <Ionicons name="moon" size={14} color={fg} style={{ opacity: glyphOpacity }} />
      ) : (
        // Bewust géén Ionicons.sunny met stralen — een platte cirkel
        // is rustiger en past beter bij de minimalistische dn-switch
        // estetiek.
        <View
          style={[
            styles.sunDot,
            { backgroundColor: fg, opacity: glyphOpacity },
          ]}
        />
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
    // Expliciete halve-hoogte radius i.p.v. 999 — Android renderde
    // `999` in combinatie met de actieve-slot backgroundColor niet
    // betrouwbaar (slot bleef vierkant ondanks ronde wrap).
    borderRadius: 14,
    borderWidth: 1,
    gap: 2,
    overflow: 'hidden',
  },
  slot: {
    width: 28,
    height: 22,
    // Halve-hoogte i.p.v. 999. + overflow:hidden zodat Android de
    // active-bg-fill clipt op de ronde shape (anders verschijnt
    // 'r een vierkante achterkant achter de ronde slot).
    borderRadius: 11,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Plat cirkeltje voor de zon — bewust klein en strak, geen stralen.
  sunDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
});
