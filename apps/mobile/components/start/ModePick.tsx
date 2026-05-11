import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/lib/i18n';
import { useSetContentMode } from '@/store/contentMode';
import { useMode, useModeStore, useRoles } from '@/store/mode';
import { fontFamily, palette, type Mode } from '@/theme/tokens';

type Props = {
  onPicked: (mode: Mode) => void;
};

export function ModePick({ onPicked }: Props) {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const setMode = useModeStore((s) => s.setMode);
  const setContentMode = useSetContentMode();
  const t = useT();

  const pick = (mode: Mode) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Visuele én content-mode tegelijk flippen — anders zit de
    // gebruiker straks in nacht-mode (donker) terwijl Vandaag nog
    // expo-content (musea/literatuur) toont. Koppeling: nacht→uit,
    // dag→expo. Zelfde mapping als de ContentModeSwitch in de header.
    setMode(mode);
    setContentMode(mode === 'nacht' ? 'uit' : 'expo');
    onPicked(mode);
  };

  return (
    <View
      style={[
        styles.root,
        {
          // Math.max guards devices without a notch / home-indicator
          // (older iPhones, parts of the Android lineup) so we still get
          // a visible breathing strip when insets are small or zero.
          paddingTop: Math.max(insets.top + 24, 56),
          paddingBottom: Math.max(insets.bottom + 8, 24),
        },
      ]}
    >
      <Text style={[styles.kicker, { color: roles.accent }]}>
        {t('Dag of nacht', 'Day or night')}
      </Text>

      <Text style={[styles.title, { color: roles.fg }]}>
        {t('Wat zoek je?', 'What are you after?')}
      </Text>

      <Text style={[styles.sub, { color: roles.fgRead }]}>
        {t(
          "Twee agenda's. Twee ritmes. Eentje voor wat overdag in de stad gebeurt, eentje voor wat 's avonds en 's nachts losgaat. Begin waar je nu zin in hebt.",
          'Two agendas. Two rhythms. One for what happens in the city by day, one for what kicks off in the evening and at night. Start with whatever you’re into right now.'
        )}
      </Text>

      <View style={styles.tiles}>
        <ModeTile
          name={t('Nacht', 'Night')}
          meta={t('feesten, concerten, films', 'parties, concerts, films')}
          onPress={() => pick('nacht')}
          variant="nacht"
        />
        <ModeTile
          name={t('Dag', 'Day')}
          meta={t(
            'exposities, matinees, openings',
            'exhibitions, matinees, openings'
          )}
          onPress={() => pick('dag')}
          variant="dag"
        />
      </View>

      <View style={styles.footWrap}>
        <Text style={[styles.foot, { color: roles.fgMuted }]}>
          {t('Wisselen kan altijd', 'You can switch any time')}
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
          // noir2 ipv noir: in nacht-mode is roles.bg ook noir, dus
          // noir verdween in de achtergrond. noir2 (#17171a) is net
          // wat lichter en blijft visueel los staan in beide modi.
          backgroundColor: isNacht ? palette.noir2 : palette.paper,
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

/** Filled crescent — zelfde Ionicons-maan als de ContentModeSwitch in
 *  de AppHeader, zodat de keuze hier visueel doorloopt naar de toggle
 *  die de gebruiker later gebruikt om te switchen. */
function NachtGlyph() {
  return (
    <View style={glyph.disc}>
      <Ionicons name="moon" size={26} color={palette.acid} />
    </View>
  );
}

/** Platte cirkel — exact dezelfde minimalistische zon-glyph als de
 *  ContentModeSwitch (bewust géén Ionicons.sunny met stralen). */
function DagGlyph() {
  return (
    <View style={glyph.disc}>
      <View style={glyph.dagDot} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 24 },
  kicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 38,
    lineHeight: 38 * 0.95,
    letterSpacing: -1.3,
    marginTop: 10,
    marginBottom: 8,
    textAlign: 'center',
  },
  titleEm: {
    fontFamily: fontFamily.body,
    fontWeight: '400',
  },
  sub: {
    fontFamily: fontFamily.body,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
    textAlign: 'center',
    alignSelf: 'center',
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
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  tileName: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    letterSpacing: -1.05,
    lineHeight: 30 * 0.9,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  tileMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginTop: 6,
    opacity: 0.65,
    textAlign: 'center',
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  dagDot: {
    // Matched op de visuele grootte van de Ionicons-maan (size 26).
    // Een filled cirkel heeft geen icon-font-padding, dus ~22px geeft
    // ongeveer hetzelfde optisch volume.
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: palette.red,
  },
});
