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
 */
export function SpinningCross({
  size = 24,
  thickness = 4,
  color,
  durationMs = 900,
}: {
  size?: number;
  thickness?: number;
  color: string;
  durationMs?: number;
}) {
  const rot = useSharedValue(0);

  useEffect(() => {
    rot.value = withRepeat(
      withTiming(1, {
        duration: durationMs,
        easing: Easing.linear,
      }),
      -1,
      false
    );
  }, [rot, durationMs]);

  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rot.value * 360}deg` }],
  }));

  return (
    <View style={styles.wrap}>
      <Animated.View style={style}>
        <Cross size={size} thickness={thickness} color={color} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
});
