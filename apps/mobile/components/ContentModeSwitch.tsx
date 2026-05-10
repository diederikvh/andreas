import { Pressable, StyleSheet, Text, View } from 'react-native';

import { tinyTap } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { useContentMode, useSetContentMode } from '@/store/contentMode';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

// Twee-staat segmented control voor de top-level content-as: 'uit' óf
// 'expo'. Visueel zwaarder dan de filter-chips eronder zodat duidelijk
// is dat dit een hoofd-keuze is, niet een filter. Active pill is filled
// met brand-accent; inactive pill is outline.
//
// Bewust zonder eigen sticky-positioning — ouder layout (avond.tsx /
// agenda.tsx) zet 'm in de AppHeader-children boven de chipRow.
export function ContentModeSwitch() {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const cmode = useContentMode();
  const setMode = useSetContentMode();

  const onTap = (next: 'uit' | 'expo') => {
    if (next === cmode) return;
    tinyTap();
    setMode(next);
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
      <Pill
        label={t('Uit', 'Going out')}
        active={cmode === 'uit'}
        onPress={() => onTap('uit')}
        activeBg={roles.fg}
        activeFg={roles.bg}
        inactiveFg={roles.fgMuted}
      />
      <Pill
        label={t('Expo', 'Expo')}
        active={cmode === 'expo'}
        onPress={() => onTap('expo')}
        activeBg={roles.fg}
        activeFg={roles.bg}
        inactiveFg={roles.fgMuted}
      />
    </View>
  );
}

function Pill({
  label,
  active,
  onPress,
  activeBg,
  activeFg,
  inactiveFg,
}: {
  label: string;
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
      onPress={onPress}
      style={[
        styles.pill,
        active && { backgroundColor: activeBg },
      ]}
    >
      <Text
        style={[
          styles.pillText,
          { color: active ? activeFg : inactiveFg },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    height: 38,
    padding: 3,
    borderRadius: 999,
    borderWidth: 1,
    gap: 2,
  },
  pill: {
    height: 32,
    paddingHorizontal: 18,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.1,
  },
});
