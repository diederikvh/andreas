import { StyleSheet, View } from 'react-native';

import { Cross } from '@/components/Cross';

/**
 * Five tab-bar icons, mirroring the SVGs in `app.html` line 1421-1454.
 * 22×22 box (= the rendered size in the mock), no SVG dep — all
 * shapes built from <View> + transforms.
 */

type IconProps = { color: string };

const BOX = 22;
const STROKE = 3.3; // mock stroke 3.6 on 24-grid → 3.3 on 22-grid

export function TabIconAvond({ color }: IconProps) {
  return (
    <View style={styles.box}>
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

export function TabIconAgenda({ color }: IconProps) {
  return (
    <View style={styles.box}>
      <View style={[styles.tick, { backgroundColor: color, top: 5, width: 13 }]} />
      <View style={[styles.tick, { backgroundColor: color, top: 10, width: 13 }]} />
      <View style={[styles.tick, { backgroundColor: color, top: 15, width: 7 }]} />
    </View>
  );
}

/**
 * Wiebertje — geometric brand-element (geërfd van het oude Kaart-
 * icoon). Wordt nu gebruikt voor de Venues-tab; Kaart is verplaatst
 * naar een banner op Avond en heeft geen eigen tab-icoon meer.
 */
export function TabIconVenues({ color }: IconProps) {
  return (
    <View style={styles.box}>
      <View style={[styles.diamond, { backgroundColor: color }]} />
    </View>
  );
}

export function TabIconGered({ color }: IconProps) {
  return (
    <View style={styles.box}>
      <Cross size={18} thickness={STROKE} color={color} />
    </View>
  );
}

/**
 * Social-tab — twee gestapelde rondjes (overlappende cirkels) als
 * "people"-glyph. Géén Cross — het kruis blijft de wordmark-merk-indicator
 * voor het hele app-icoon en moet niet verwarrend op tab-niveau opduiken.
 */
export function TabIconSocial({ color }: IconProps) {
  return (
    <View style={styles.box}>
      <View
        style={[
          styles.socialDot,
          { backgroundColor: color, left: 3, top: 4 },
        ]}
      />
      <View
        style={[
          styles.socialDot,
          { backgroundColor: color, right: 3, top: 8 },
        ]}
      />
    </View>
  );
}

export function TabIconJij({ color }: IconProps) {
  return (
    <View style={styles.box}>
      <View style={[styles.ring, { borderColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: BOX,
    height: BOX,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  tick: {
    position: 'absolute',
    height: STROKE,
    left: 5,
  },
  diamond: {
    width: 12,
    height: 12,
    transform: [{ rotate: '45deg' }],
  },
  ring: {
    width: 15,
    height: 15,
    borderRadius: 999,
    borderWidth: STROKE,
  },
  socialDot: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 999,
  },
});
