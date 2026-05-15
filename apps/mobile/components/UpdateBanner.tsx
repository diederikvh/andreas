import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/lib/i18n';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/**
 * Floating pill die verschijnt zodra een EAS Update klaarstaat. Tap →
 * Updates.reloadAsync() past 'm direct toe — anders moet de gebruiker
 * de app sluiten en opnieuw openen om de nieuwe bundle te activeren.
 *
 * Rendert niets in dev / Expo Go (Updates.isEnabled = false).
 */
export function UpdateBanner() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { isUpdatePending } = Updates.useUpdates();
  const [restarting, setRestarting] = useState(false);

  const visible = Updates.isEnabled && isUpdatePending && !restarting;

  const opacity = useSharedValue(0);
  const translateY = useSharedValue(40);

  useEffect(() => {
    opacity.value = withTiming(visible ? 1 : 0, {
      duration: 240,
      easing: Easing.bezier(0.65, 0, 0.35, 1),
    });
    translateY.value = withTiming(visible ? 0 : 40, {
      duration: 320,
      easing: Easing.bezier(0.65, 0, 0.35, 1),
    });
  }, [visible, opacity, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  if (!Updates.isEnabled) return null;

  const onPress = async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      await Updates.reloadAsync();
    } catch {
      setRestarting(false);
    }
  };

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.wrap, { bottom: insets.bottom + 72 }, animatedStyle]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(
          'Herlaad app voor nieuwe versie',
          'Reload app for new version'
        )}
        onPress={onPress}
        style={[styles.pill, { backgroundColor: roles.accent }]}
      >
        <Text style={[styles.text, { color: roles.onAccent }]}>
          {t(
            'Nieuwe versie · Tik om te herladen',
            'New version · Tap to reload'
          )}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  pill: {
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 6,
  },
  text: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    letterSpacing: -0.1,
  },
});
