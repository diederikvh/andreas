import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { softTap } from '@/lib/haptics';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Instellingen in de vorm die iedereen al kent uit iOS.
 *
 * De schermen hiervoor zetten elke instelling neer als een kop, een
 * alinea uitleg en een tabbalkje. Vijf daarvan onder elkaar lezen als een
 * document in plaats van als knoppen: je moet alles lezen om te vinden
 * wat je zoekt, en een keuze van twee opties kreeg evenveel aandacht als
 * de belangrijkste.
 *
 * Het patroon hier is dat van Instellingen: een grijs kopje, een blok
 * rijen met scheidingslijntjes, en de uitleg één keer ónder het blok in
 * plaats van bij elke rij. De rijen zijn 44 punten hoog -- dat is niet
 * willekeurig, dat is wat Apple als kleinste raakvlak aanhoudt.
 */

/** Blok met een kopje erboven en uitleg eronder. */
export function SettingsGroup({
  header,
  footer,
  children,
  style,
  inset = 16,
}: {
  header?: string;
  footer?: string;
  children: React.ReactNode;
  style?: ViewStyle;
  /**
   * Waar het scheidingslijntje begint. In Instellingen loopt dat niet
   * tot de rand maar tot waar de tékst begint — bij rijen met een icoon
   * dus voorbij dat icoon. Gebruik `ICON_INSET` voor zo'n groep.
   */
  inset?: number;
}) {
  const roles = useRoles();
  const rows = Array.isArray(children) ? children.filter(Boolean) : [children];

  return (
    <View style={[styles.wrap, style]}>
      {header ? (
        <Text style={[styles.header, { color: roles.fgMuted }]}>
          {header.toUpperCase()}
        </Text>
      ) : null}
      <View style={[styles.group, { backgroundColor: roles.bgChip }]}>
        {rows.map((row, i) => (
          <View key={i}>
            {/* Lijntje tússen rijen, niet eronder: een streep onder de
                laatste rij zou de afronding van het blok doorsnijden. En
                ingesprongen vanaf links, zoals in Instellingen. */}
            {i > 0 ? (
              <View
                style={[
                  styles.divider,
                  { backgroundColor: roles.bg, marginLeft: inset },
                ]}
              />
            ) : null}
            {row}
          </View>
        ))}
      </View>
      {footer ? (
        <Text style={[styles.footer, { color: roles.fgMuted }]}>{footer}</Text>
      ) : null}
    </View>
  );
}

/** Rij met een schakelaar rechts. Voor alles wat aan of uit is. */
export function SettingsSwitch({
  label,
  sub,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  sub?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const roles = useRoles();
  const isNacht = useMode() === 'nacht';
  return (
    <View style={[styles.row, disabled ? styles.rowOff : null]}>
      <View style={styles.rowText}>
        <Text style={[styles.label, { color: roles.fg }]}>{label}</Text>
        {sub ? (
          <Text style={[styles.sub, { color: roles.fgMuted }]}>{sub}</Text>
        ) : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          softTap();
          onValueChange(next);
        }}
        trackColor={{
          true: roles.accent,
          false: isNacht ? '#2a2a2d' : palette.paper,
        }}
        thumbColor={isNacht ? palette.ink : palette.paper3}
      />
    </View>
  );
}

/**
 * Rij met een keuze uit meerdere. Toont de huidige waarde rechts, en
 * klapt de opties eronder uit met een vinkje bij wat aan staat.
 *
 * Apple duwt hiervoor meestal een nieuw scherm op de stapel. Dat kan hier
 * niet zonder omweg -- deze instellingen zitten in een modal die zelf al
 * een sheet is, en een sheet in een sheet is precies het soort stapeling
 * waar je niet meer uit komt. Uitklappen laat je bovendien zien wat de
 * andere opties zijn zonder je plek kwijt te raken.
 */
export function SettingsChoice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  const roles = useRoles();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <View>
      <Pressable
        onPress={() => {
          softTap();
          setOpen((o) => !o);
        }}
        style={styles.row}
      >
        <Text style={[styles.label, { color: roles.fg }]}>{label}</Text>
        <View style={styles.value}>
          <Text style={[styles.valueText, { color: roles.fgMuted }]}>
            {current?.label ?? value}
          </Text>
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={15}
            color={roles.fgPlaceholder}
          />
        </View>
      </Pressable>

      {open
        ? options.map((o) => (
            <Pressable
              key={o.value}
              onPress={() => {
                softTap();
                onChange(o.value);
                setOpen(false);
              }}
              style={[styles.row, styles.optionRow]}
            >
              <Text style={[styles.label, { color: roles.fg }]}>{o.label}</Text>
              {o.value === value ? (
                <Ionicons name="checkmark" size={18} color={roles.accent} />
              ) : null}
            </Pressable>
          ))
        : null}
    </View>
  );
}

/** Rij die ergens heen gaat of iets doet. Waarde rechts, optioneel een
    knoptekst in accentkleur. */
/** Padding + icoon + tussenruimte: waar de tekst begint in een groep met
    iconen, en dus waar het lijntje moet beginnen. */
export const ICON_INSET = 16 + 22 + 12;

export function SettingsAction({
  label,
  sub,
  value,
  action,
  icon,
  onPress,
}: {
  label: string;
  sub?: string;
  value?: string;
  action?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
}) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={() => {
        if (!onPress) return;
        softTap();
        onPress();
      }}
      disabled={!onPress}
      style={styles.row}
    >
      {icon ? <Ionicons name={icon} size={22} color={roles.accent} /> : null}
      <View style={styles.rowText}>
        <Text style={[styles.label, { color: roles.fg }]}>{label}</Text>
        {sub ? (
          <Text style={[styles.sub, { color: roles.fgMuted }]}>{sub}</Text>
        ) : null}
      </View>
      <View style={styles.value}>
        {value ? (
          <Text style={[styles.valueText, { color: roles.fgMuted }]}>
            {value}
          </Text>
        ) : null}
        {action ? (
          <Text style={[styles.action, { color: roles.accent }]}>{action}</Text>
        ) : null}
        {onPress && !action ? (
          <Ionicons
            name="chevron-forward"
            size={15}
            color={roles.fgPlaceholder}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 18, marginTop: 22 },
  header: {
    fontFamily: fontFamily.display,
    fontSize: 11.5,
    letterSpacing: 0.6,
    marginBottom: 7,
    marginLeft: 4,
  },
  group: { borderRadius: 12, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth },
  row: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  // Een uitgeklapte optie springt in, zodat je ziet dat hij bij de rij
  // erboven hoort en niet zelf een instelling is.
  optionRow: { paddingLeft: 32, minHeight: 48 },
  rowOff: { opacity: 0.45 },
  rowText: { flex: 1, gap: 2 },
  label: { fontFamily: fontFamily.medium, fontSize: 15.5, letterSpacing: -0.2 },
  sub: { fontFamily: fontFamily.body, fontSize: 12.5, lineHeight: 16.5 },
  value: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  valueText: { fontFamily: fontFamily.body, fontSize: 14.5 },
  action: { fontFamily: fontFamily.bold, fontSize: 14.5 },
  footer: {
    fontFamily: fontFamily.body,
    fontSize: 12.5,
    lineHeight: 17,
    marginTop: 7,
    marginHorizontal: 4,
  },
});
