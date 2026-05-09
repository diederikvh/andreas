import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import type { ComponentType } from 'react';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
  TabIconJij,
  TabIconSocial,
  TabIconVenues,
} from '@/components/icons/TabIcons';
import { useSession } from '@/lib/authClient';
import { tinyTap } from '@/lib/haptics';
import { useFriendRequests, useInvites } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

type IconCmp = ComponentType<{ color: string }>;

// Kaart heeft `href: null` in de tabs-config, maar verschijnt nog wel
// in `state.routes`. Door 'm hier weg te laten valt 'ie via de
// `if (!Icon) return null;` automatisch uit de tab-bar.
const TAB_ICONS: Record<string, IconCmp> = {
  avond: TabIconAvond,
  agenda: TabIconAgenda,
  venues: TabIconVenues,
  social: TabIconSocial,
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

  // Social-tab badge — som van openstaande friend-requests + invites.
  // Queries blijven cold-disabled tot er een sessie is om 401's tijdens
  // de welkom-flow te vermijden.
  const { data: session } = useSession();
  const isAuthed = Boolean(session?.user?.id);
  const { data: requests } = useFriendRequests({ enabled: isAuthed });
  const { data: invites } = useInvites({ enabled: isAuthed });
  const socialBadge = isAuthed
    ? (requests?.length ?? 0) + (invites?.length ?? 0)
    : 0;

  const tint = mode === 'nacht' ? 'rgba(23,23,26,0.65)' : 'rgba(235,230,216,0.7)';
  const border = mode === 'nacht' ? '#2a2a2d' : palette.paper;
  const idle = mode === 'nacht' ? '#6a6a68' : '#8a7e6b';
  const bottom = Math.max(insets.bottom - 16, 4);

  // Filter naar alleen zichtbare tabs (kaart heeft href:null, valt af).
  const visible = state.routes.filter((r) => TAB_ICONS[r.name]);
  const currentRoute = state.routes[state.index];
  // Op een verborgen tab (zoals /kaart) zit de huidige route niet in
  // `visible` — dan markeren we geen tab als actief, zodat de
  // gebruiker visueel ziet dat de huidige pagina buiten het tab-stelsel
  // valt en geen van de hoofdsecties is.
  const onHiddenRoute = currentRoute
    ? !TAB_ICONS[currentRoute.name]
    : false;
  const focusedVisibleIndex = onHiddenRoute
    ? -1
    : visible.findIndex((r) => r.key === currentRoute?.key);
  const N = visible.length;

  // Geanimeerde "blob" achter de actieve tab. Progress blijft staan op
  // de laatst-actieve tab als je naar een verborgen route gaat (kaart),
  // en de opacity faadt de blob uit/in. Zodra je terug op een tab tikt
  // springt-ie weer aan op de juiste positie.
  const lastActive = Math.max(0, focusedVisibleIndex);
  const progress = useSharedValue(lastActive);
  useEffect(() => {
    if (focusedVisibleIndex >= 0) {
      progress.value = withTiming(focusedVisibleIndex, {
        duration: 280,
        easing: Easing.bezier(0.65, 0, 0.35, 1),
      });
    }
  }, [focusedVisibleIndex, progress]);

  const opacity = useSharedValue(onHiddenRoute ? 0 : 1);
  useEffect(() => {
    opacity.value = withTiming(onHiddenRoute ? 0 : 1, { duration: 200 });
  }, [onHiddenRoute, opacity]);

  const blobStyle = useAnimatedStyle(() => ({
    width: `${100 / N}%`,
    transform: [{ translateX: `${progress.value * 100}%` }],
    opacity: opacity.value,
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
        // Op verborgen routes (kaart) markeren we niemand als actief.
        const focused = !onHiddenRoute && state.index === index;
        const onPress = () => {
          tinyTap();
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name as never);
          }
        };
        // Geen badge op de actieve tab — je bent er al, count is dubbelop.
        const showBadge =
          route.name === 'social' && socialBadge > 0 && !focused;
        const badgeLabel = socialBadge > 9 ? '9+' : String(socialBadge);
        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : {}}
            onPress={onPress}
            style={styles.button}
          >
            <View>
              <Icon color={focused ? roles.onAccent : idle} />
              {showBadge && (
                <View
                  style={[
                    styles.badge,
                    { backgroundColor: roles.accent },
                  ]}
                >
                  <Text
                    style={[styles.badgeText, { color: roles.onAccent }]}
                    numberOfLines={1}
                  >
                    {badgeLabel}
                  </Text>
                </View>
              )}
            </View>
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
  badge: {
    position: 'absolute',
    top: -6,
    right: -10,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: -0.1,
    lineHeight: 13,
  },
});
