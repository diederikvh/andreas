import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { Cross } from '@/components/Cross';
import { brandEase } from '@/lib/easing';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

const ENTER_DURATION = 1100;

export function Splash() {
  const roles = useRoles();

  const crossScale = useSharedValue(0.4);
  const crossRotate = useSharedValue(-30);
  const crossOpacity = useSharedValue(0);

  const wordTranslate = useSharedValue(8);
  const wordOpacity = useSharedValue(0);

  const tagTranslate = useSharedValue(8);
  const tagOpacity = useSharedValue(0);

  useEffect(() => {
    crossScale.value = withTiming(1, { duration: ENTER_DURATION, easing: brandEase });
    crossRotate.value = withTiming(0, { duration: ENTER_DURATION, easing: brandEase });
    crossOpacity.value = withTiming(1, { duration: ENTER_DURATION, easing: brandEase });

    wordTranslate.value = withDelay(
      250,
      withTiming(0, { duration: ENTER_DURATION, easing: brandEase })
    );
    wordOpacity.value = withDelay(
      250,
      withTiming(1, { duration: ENTER_DURATION, easing: brandEase })
    );

    tagTranslate.value = withDelay(
      550,
      withTiming(0, { duration: ENTER_DURATION, easing: brandEase })
    );
    tagOpacity.value = withDelay(
      550,
      withTiming(1, { duration: ENTER_DURATION, easing: brandEase })
    );
  }, [crossOpacity, crossRotate, crossScale, tagOpacity, tagTranslate, wordOpacity, wordTranslate]);

  const crossStyle = useAnimatedStyle(() => ({
    opacity: crossOpacity.value,
    transform: [{ scale: crossScale.value }, { rotate: `${crossRotate.value}deg` }],
  }));

  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordOpacity.value,
    transform: [{ translateY: wordTranslate.value }],
  }));

  const tagStyle = useAnimatedStyle(() => ({
    opacity: tagOpacity.value,
    transform: [{ translateY: tagTranslate.value }],
  }));

  return (
    <View style={styles.root}>
      <View style={styles.center}>
        <Animated.View style={crossStyle}>
          <Cross size={96} thickness={24} color={roles.accent} />
        </Animated.View>
        <Animated.Text style={[styles.word, { color: roles.fg }, wordStyle]}>
          Andreas
        </Animated.Text>
      </View>
      <Animated.View style={[styles.tagWrap, tagStyle]}>
        <Text style={[styles.tag, { color: roles.fgMuted }]}>
          Amsterdam Culture
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 26 },
  word: {
    fontFamily: fontFamily.display,
    fontSize: 28,
    letterSpacing: -0.5,
    textTransform: 'uppercase',
  },
  tagWrap: {
    position: 'absolute',
    bottom: 64,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  tag: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
});
