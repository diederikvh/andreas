/**
 * Eén filter-chip voor de hele app.
 *
 * Ze liepen uit elkaar: Agenda, Venues en Vandaag gebruikten 44px hoge
 * chips met een getinte vulling, accent-rand en accent-tekst; Clubs,
 * Live, Theater en Voor jou gebruikten 32px chips die actief volledig
 * accent-gevuld waren, zonder rand. Twee visuele talen voor precies
 * hetzelfde gebaar.
 *
 * De tokens staan hier los van de component, zodat schermen die hun
 * eigen Pressable nodig hebben (icoon-toggles, long-press op opgeslagen
 * zoekopdrachten) dezelfde kleuren kunnen lezen zonder de component
 * over te nemen. Dát is wat 't uit elkaar lopen tegenhoudt — niet de
 * component zelf.
 */
import { StyleSheet, Text, View, Pressable } from 'react-native';
import type { ReactNode } from 'react';

import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/** Hoogte van de chip; rij-containers rekenen hiermee. */
export const FILTER_CHIP_HEIGHT = 44;
/** Hoogte van een rij chips inclusief lucht boven en onder. */
export const FILTER_ROW_HEIGHT = 60;

export function useFilterChipColors(active: boolean) {
  const roles = useRoles();
  const isNacht = useMode() === 'nacht';
  return {
    borderColor: active ? roles.accent : isNacht ? '#2a2a2d' : palette.paper,
    backgroundColor: active
      ? `${isNacht ? palette.acid : palette.red}1f`
      : isNacht
        ? palette.noir2
        : palette.paper2,
    color: active ? roles.accent : roles.fgMuted,
  };
}

export function FilterChip({
  label,
  count,
  icon,
  active,
  onPress,
  onLongPress,
}: {
  label: string;
  /** Optioneel aantal achter het label, in gedempte kleur. */
  count?: number;
  icon?: ReactNode;
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const roles = useRoles();
  const c = useFilterChipColors(active);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      style={[
        styles.chip,
        { borderColor: c.borderColor, backgroundColor: c.backgroundColor },
      ]}
    >
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text style={[styles.label, { color: c.color }]}>
        {label}
        {count !== undefined && (
          <Text style={{ color: active ? c.color : roles.fgPlaceholder }}>
            {` ${count}`}
          </Text>
        )}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: FILTER_CHIP_HEIGHT,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
  },
  icon: { marginLeft: -2 },
  label: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.06,
  },
});
