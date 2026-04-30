import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMode, useModeStore, useRoles } from '@/store/mode';
import { fontFamily, palette, type Mode } from '@/theme/tokens';

type Props = {
  onPicked: (mode: Mode) => void;
};

export function ModePick({ onPicked }: Props) {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const setMode = useModeStore((s) => s.setMode);

  const pick = (mode: Mode) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMode(mode);
    onPicked(mode);
  };

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
      <Text style={[styles.kicker, { color: roles.accent }]}>— Twee snelheden</Text>

      <Text style={[styles.title, { color: roles.fg }]}>
        Hoe gaat{'\n'}het er{' '}
        <Text style={[styles.titleEm, { color: roles.emphasis }]}>nu</Text>
        {'\n'}aan toe?
      </Text>

      <Text style={[styles.sub, { color: roles.fgRead }]}>
        Twee snelheden, één app. Nacht voor nightlife, dag voor een dagje uit. Je
        schakelt zelf.
      </Text>

      <View style={styles.tiles}>
        <ModeTile
          name="Nacht"
          meta="nightlife"
          onPress={() => pick('nacht')}
          variant="nacht"
        />
        <ModeTile
          name="Dag"
          meta="dagje uit"
          onPress={() => pick('dag')}
          variant="dag"
        />
      </View>

      <View style={styles.footWrap}>
        <Text style={[styles.foot, { color: roles.fgMuted }]}>
          je kan dit altijd wisselen
        </Text>
      </View>
    </View>
  );
}

type TileProps = {
  name: string;
  meta: string;
  onPress: () => void;
  variant: Mode;
};

function ModeTile({ name, meta, onPress, variant }: TileProps) {
  const isNacht = variant === 'nacht';
  const currentMode = useMode();

  // Only the nacht tile carries a border. In nacht context it's a dark
  // hairline (noir3); in dag context it softens to a near-invisible
  // outline so the dark slab doesn't read as a button-with-stroke.
  const borderColor = isNacht
    ? currentMode === 'dag'
      ? 'rgba(0,0,0,0.08)'
      : palette.noir3
    : 'transparent';
  const borderWidth = isNacht ? 1.5 : 0;
  const fg = isNacht ? palette.ink : palette.soil;

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.tile,
        {
          backgroundColor: isNacht ? palette.noir : palette.paper,
          borderColor,
          borderWidth,
        },
      ]}
    >
      <View style={styles.glyph}>
        {isNacht ? <NachtGlyph /> : <DagGlyph />}
      </View>
      <View>
        <Text style={[styles.tileName, { color: fg }]}>{name}</Text>
        <Text style={[styles.tileMeta, { color: fg }]}>{meta}</Text>
      </View>
    </Pressable>
  );
}

/** Half-moon: full circle with the right half filled in acid (inset shadow). */
function NachtGlyph() {
  return (
    <View style={glyph.disc}>
      <View style={glyph.moonHalf} />
    </View>
  );
}

/** Filled red dot inside a faint red ring. */
function DagGlyph() {
  return (
    <View style={glyph.disc}>
      <View style={glyph.dagRing} />
      <View style={glyph.dagDot} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 24, paddingTop: 56 },
  kicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 38,
    lineHeight: 38 * 0.95,
    letterSpacing: -1.3,
    marginTop: 10,
    marginBottom: 8,
  },
  titleEm: {
    fontFamily: fontFamily.body,
    fontWeight: '400',
  },
  sub: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 10,
    maxWidth: '92%',
  },
  tiles: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 28,
  },
  tile: {
    flex: 1,
    height: 190,
    borderRadius: 18,
    padding: 16,
    justifyContent: 'space-between',
  },
  tileName: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    letterSpacing: -1.05,
    lineHeight: 30 * 0.9,
    textTransform: 'uppercase',
  },
  tileMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginTop: 6,
    opacity: 0.65,
  },
  glyph: { width: 36, height: 36 },
  footWrap: { marginTop: 'auto', paddingTop: 18, alignItems: 'center' },
  foot: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
});

const glyph = StyleSheet.create({
  disc: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
  },
  moonHalf: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: 10,
    backgroundColor: palette.acid,
  },
  dagRing: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 18,
    borderWidth: 2.5,
    borderColor: palette.red,
    opacity: 0.35,
  },
  dagDot: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    bottom: 6,
    borderRadius: 12,
    backgroundColor: palette.red,
  },
});
