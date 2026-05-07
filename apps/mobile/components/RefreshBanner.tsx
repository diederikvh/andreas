import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { SpinningCross } from '@/components/SpinningCross';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Drijvende refresh-indicator boven de content. Zichtbaar tijdens
 * `refreshing === true`. Bedoeld als visuele bevestiging dat een
 * pull-to-refresh of focus-driven refetch loopt — naast de native
 * RefreshControl-spinner die op iOS subtiel achter de blur-header
 * verstopt kan zitten.
 *
 * Positie: absolute top, geanimeerde slide-in vanaf -32px.
 */
export function RefreshBanner({
  visible,
  topOffset,
}: {
  visible: boolean;
  topOffset: number;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(-12);

  useEffect(() => {
    if (visible) {
      opacity.value = withTiming(1, { duration: 180 });
      translateY.value = withTiming(0, { duration: 220 });
    } else {
      opacity.value = withTiming(0, { duration: 160 });
      translateY.value = withTiming(-12, { duration: 200 });
    }
  }, [visible, opacity, translateY]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { top: topOffset }, animStyle]}
    >
      <View
        style={[
          styles.pill,
          {
            // Mode-tint: donker (noir2) in nacht-mode, licht (paper2)
            // in dag-mode. Border neutraal — geen accent — want de
            // banner is een passieve melding, geen call-to-action.
            backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            borderColor: roles.bgChip,
          },
        ]}
      >
        <SpinningCross size={14} color={roles.fg} />
        <Text style={[styles.text, { color: roles.fg }]}>Vernieuwen…</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 100,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
  },
  text: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.13,
  },
});
