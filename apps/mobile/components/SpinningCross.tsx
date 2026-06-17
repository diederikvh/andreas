import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Cross } from '@/components/Cross';

/**
 * Loading-indicator in Andreas-stijl: het brand-kruis dat continu
 * roteert. Vervangt overal de tekst "Laden…". Standaard 24px,
 * fg-kleur — pas `size` en `color` aan voor varianten.
 *
 * Default thickness = size / 4 zodat de visuele lijndikte matcht met
 * het brand-kruis in het logo (zelfde ratio). Expliciete thickness
 * blijft mogelijk voor uitzonderingen.
 */
export function SpinningCross({
  size = 24,
  thickness,
  color,
  durationMs = 900,
  pulse = false,
}: {
  size?: number;
  thickness?: number;
  color: string;
  durationMs?: number;
  /** Laat het kruis ook in-/uitfaden (opacity-pulse). Maakt 'm zichtbaar
      op donkere achtergronden waar een statische muted-kleur wegvalt. */
  pulse?: boolean;
}) {
  const effectiveThickness = thickness ?? Math.round(size / 4);
  const rot = useSharedValue(0);
  const op = useSharedValue(pulse ? 0.3 : 1);

  useEffect(() => {
    rot.value = withRepeat(
      withTiming(1, {
        duration: durationMs,
        easing: Easing.linear,
      }),
      -1,
      false
    );
    if (pulse) {
      // Breathe tussen dim en vol — reverse-loop voor een soepele glow.
      op.value = withRepeat(
        withTiming(1, { duration: durationMs, easing: Easing.inOut(Easing.quad) }),
        -1,
        true
      );
    }
  }, [rot, op, durationMs, pulse]);

  const style = useAnimatedStyle(() => ({
    opacity: op.value,
    transform: [{ rotate: `${rot.value * 360}deg` }],
  }));

  return (
    <View style={styles.wrap}>
      <Animated.View style={style}>
        <Cross size={size} thickness={effectiveThickness} color={color} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
});
