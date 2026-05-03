import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import type { ComponentType } from 'react';
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  TabIconAgenda,
  TabIconAvond,
  TabIconGered,
  TabIconJij,
  TabIconVenues,
} from '@/components/icons/TabIcons';
import { useMode, useRoles } from '@/store/mode';
import { palette } from '@/theme/tokens';

type IconCmp = ComponentType<{ color: string }>;

// Kaart heeft `href: null` in de tabs-config, maar verschijnt nog wel
// in `state.routes`. Door 'm hier weg te laten valt 'ie via de
// `if (!Icon) return null;` automatisch uit de tab-bar.
const TAB_ICONS: Record<string, IconCmp> = {
  avond: TabIconAvond,
  agenda: TabIconAgenda,
  venues: TabIconVenues,
  gered: TabIconGered,
  jij: TabIconJij,
};

/**
 * Floating pill tab-bar. Translucent rgba tint sits over a BlurView
 * for an iOS-material feel. Anchored close to the home indicator.
 */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const roles = useRoles();
  const mode = useMode();
  const insets = useSafeAreaInsets();

  const tint = mode === 'nacht' ? 'rgba(23,23,26,0.65)' : 'rgba(235,230,216,0.7)';
  const border = mode === 'nacht' ? '#2a2a2d' : palette.paper;
  const idle = mode === 'nacht' ? '#6a6a68' : '#8a7e6b';
  const bottom = Math.max(insets.bottom - 16, 4);

  // Filter naar alleen zichtbare tabs (kaart heeft href:null, valt af).
  const visible = state.routes.filter((r) => TAB_ICONS[r.name]);
  const visibleIndex = Math.max(
    0,
    visible.findIndex((r) => r.key === state.routes[state.index]?.key)
  );
  const N = visible.length;

  // Geanimeerde "blob" achter de actieve tab. We animeren een gedeelde
  // value tussen 0..N-1; de transform-x is dan progress * buttonWidth.
  // Buttons hebben flex:1 binnen de row, dus we positioneren via een
  // percentage-shift: blob zit op `${(progress / N) * 100}%`.
  const progress = useSharedValue(visibleIndex);
  useEffect(() => {
    progress.value = withTiming(visibleIndex, {
      duration: 280,
      easing: Easing.bezier(0.65, 0, 0.35, 1),
    });
  }, [visibleIndex, progress]);

  const blobStyle = useAnimatedStyle(() => ({
    width: `${100 / N}%`,
    transform: [{ translateX: `${progress.value * 100}%` }],
  }));

  return (
    <View style={[styles.bar, { bottom, borderColor: border }]}>
      <BlurView
        intensity={40}
        tint={mode === 'nacht' ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      <Animated.View
        pointerEvents="none"
        style={[styles.blob, blobStyle, { backgroundColor: roles.accent }]}
      />
      {state.routes.map((route, index) => {
        const Icon = TAB_ICONS[route.name];
        if (!Icon) return null;
        const focused = state.index === index;
        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name as never);
          }
        };
        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : {}}
            onPress={onPress}
            style={styles.button}
          >
            <Icon color={focused ? roles.onAccent : idle} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 20,
    right: 20,
    padding: 6,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 2,
    overflow: 'hidden',
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  blob: {
    position: 'absolute',
    top: 6,
    left: 6,
    bottom: 6,
    borderRadius: 999,
  },
});
