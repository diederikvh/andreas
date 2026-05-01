import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import type { ComponentType } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  TabIconAgenda,
  TabIconAvond,
  TabIconGered,
  TabIconJij,
  TabIconKaart,
} from '@/components/icons/TabIcons';
import { useMode, useRoles } from '@/store/mode';
import { palette } from '@/theme/tokens';

type IconCmp = ComponentType<{ color: string }>;

const TAB_ICONS: Record<string, IconCmp> = {
  avond: TabIconAvond,
  agenda: TabIconAgenda,
  kaart: TabIconKaart,
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

  return (
    <View style={[styles.bar, { bottom, borderColor: border }]}>
      <BlurView
        intensity={40}
        tint={mode === 'nacht' ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
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
            style={[
              styles.button,
              focused && { backgroundColor: roles.accent },
            ]}
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
});
