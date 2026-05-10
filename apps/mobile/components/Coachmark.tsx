import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { Cross } from '@/components/Cross';
import { tinyTap } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Eerste-bezoek hint die naar een specifieke control wijst. Een
 * kleine kaart met pijl omhoog, kort label en een sluit-kruisje.
 * Generieke versie — caller bepaalt positie + content + dismiss-
 * mechanisme. Zie ContentSwitchHint en FilterHint voor wrappers
 * die de flag-controle doen.
 */
export function Coachmark({
  top,
  arrowFromRight,
  title,
  body,
  onDismiss,
}: {
  /** Y-positie van het pijltje (boven de card). */
  top: number;
  /** Afstand van de pijl-tip tot de rechter schermrand (in px). Caller
      kiest dit zodat de tip onder de doel-control valt. */
  arrowFromRight: number;
  title: string;
  body: string;
  onDismiss: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();

  const onTap = () => {
    tinyTap();
    onDismiss();
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      entering={FadeIn.duration(420).delay(700)}
      exiting={FadeOut.duration(180)}
      style={[styles.layer, { top }]}
    >
      {/* Pijltje omhoog — caller positioneert via arrowFromRight zodat
          de tip onder de doel-control valt. */}
      <View style={[styles.arrowWrap, { paddingRight: arrowFromRight }]}>
        <View style={[styles.arrow, { backgroundColor: roles.accent }]} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('Sluit hint', 'Dismiss hint')}
        onPress={onTap}
        style={[
          styles.card,
          {
            backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            borderColor: roles.accent,
          },
        ]}
      >
        <View style={styles.cardBody}>
          <Text style={[styles.cardTitle, { color: roles.fg }]}>{title}</Text>
          <Text style={[styles.cardSub, { color: roles.fgRead }]}>{body}</Text>
        </View>
        <View style={styles.closeBtn}>
          <Cross size={10} thickness={2} color={roles.fgMuted} />
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 18,
    right: 18,
    zIndex: 9,
    alignItems: 'flex-end',
  },
  arrowWrap: {
    height: 11,
    overflow: 'hidden',
    alignItems: 'flex-end',
    alignSelf: 'stretch',
  },
  arrow: {
    width: 18,
    height: 18,
    transform: [{ rotate: '45deg' }, { translateY: 11 }],
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: 2,
    width: 320,
    // Subtiele drop-shadow zodat de hint los van de content lijkt te
    // zweven. Cross-platform: iOS gebruikt shadow*-props, Android
    // elevation.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 4,
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  cardTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 16,
    letterSpacing: -0.21,
  },
  cardSub: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 20,
  },
  closeBtn: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
