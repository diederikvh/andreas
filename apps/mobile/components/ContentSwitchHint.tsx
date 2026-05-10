import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HEADER_HEIGHT } from '@/components/AppHeader';
import { Cross } from '@/components/Cross';
import { tinyTap } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import {
  useDismissContentSwitchHint,
  useHasSeenContentSwitchHint,
  useMode,
  useRoles,
} from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Eerste-bezoek hint die naar de Uit/Expo content-switch in de
 * AppHeader wijst. Een kleine kaart met pijltje omhoog, kort label,
 * en een sluitkruis. Auto-verbergt zodra de gebruiker 'm tikt of
 * (impliciet) de switch zelf gebruikt.
 *
 * Render dit op Vandaag/Agenda — de twee schermen waar de switch
 * zichtbaar is. De flag wordt persistent opgeslagen in de mode-store.
 */
export function ContentSwitchHint() {
  const insets = useSafeAreaInsets();
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const hasSeen = useHasSeenContentSwitchHint();
  const dismiss = useDismissContentSwitchHint();

  if (hasSeen) return null;

  const onTap = () => {
    tinyTap();
    dismiss();
  };

  // Pijltje wijst omhoog naar de switch in de AppHeader. Y-positie
  // ligt net onder de header; X-positie is aan-de-rechterkant zodat
  // de pijl onder de switch valt.
  const top = insets.top + HEADER_HEIGHT + 4;

  return (
    <Animated.View
      pointerEvents="box-none"
      entering={FadeIn.duration(420).delay(700)}
      exiting={FadeOut.duration(180)}
      style={[styles.layer, { top }]}
    >
      {/* Pijltje omhoog. Twee gedraaide vlakjes maken een driehoek
          zonder SVG nodig — past bij Andreas-style view-primitives. */}
      <View style={styles.arrowWrap}>
        <View
          style={[
            styles.arrow,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('Sluit hint', 'Dismiss hint')}
        onPress={onTap}
        style={[
          styles.card,
          {
            backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            borderColor: isNacht ? '#2a2a2d' : palette.paper,
          },
        ]}
      >
        <View style={styles.cardBody}>
          <Text style={[styles.cardTitle, { color: roles.fg }]}>
            {t('Uitgaan of expo?', 'Going out or expo?')}
          </Text>
          <Text style={[styles.cardSub, { color: roles.fgRead }]}>
            {t(
              'Tik hierboven om te wisselen tussen uitgaan-content (clubs, podia, theater, film) en kunst & expo. Het bepaalt wat je hier ziet.',
              'Tap above to switch between going-out content (clubs, stages, theatre, film) and art & expo. It changes what you see here.'
            )}
          </Text>
        </View>
        <View style={styles.closeBtn}>
          <Cross size={10} thickness={2} color={roles.fgMuted} />
        </View>
      </Pressable>
    </Animated.View>
  );
}

// Layout-keuzes:
// - layer: full-width absolute positioning, zIndex boven de scroll
//   content maar onder de AppHeader (header zit op zIndex 10).
// - card: rechtuitgelijnd zodat 'ie onder de switch valt; max-width
//   zodat 'ie niet over de hele breedte loopt.
// - arrow: 14×14 vierkant 45° gedraaid, half boven de card-rand
//   geclipt door de cardWrap; geeft een schone driehoek-illusie.
const styles = StyleSheet.create({
  // Layer beslaat de volle breedte minus 18 aan beide kanten zodat de
  // card content-driven kan groeien tot maximaal 280px en daar rechts
  // tegenaan landt. Zonder linker-extent zou het body-blok inklappen.
  layer: {
    position: 'absolute',
    left: 18,
    right: 18,
    zIndex: 9,
    alignItems: 'flex-end',
  },
  arrowWrap: {
    height: 8,
    overflow: 'hidden',
    alignItems: 'flex-end',
    paddingRight: 30,
    alignSelf: 'stretch',
  },
  arrow: {
    width: 14,
    height: 14,
    transform: [{ rotate: '45deg' }, { translateY: 8 }],
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    width: 280,
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  cardTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
  },
  cardSub: {
    fontFamily: fontFamily.body,
    fontSize: 12.5,
    lineHeight: 17,
  },
  closeBtn: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
