import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentType } from 'react';
import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
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
  TabIconMeer,
} from '@/components/icons/TabIcons';
import { useSession } from '@/lib/authClient';
import { tinyTap } from '@/lib/haptics';
import { useNewArrivalsSince, useSocialBadgeCount } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { useNewFilters } from '@/store/newFilters';
import { useNewBadgeSince } from '@/store/sessionTimestamps';
import { fontFamily, palette } from '@/theme/tokens';

type IconCmp = ComponentType<{ color: string }>;

// Kaart en Venues hebben `href: null` in de tabs-config, maar
// verschijnen nog wel in `state.routes`. Door ze hier weg te laten
// vallen ze via de `if (!Icon) return null;` automatisch uit de bar.
// `jij` is sinds de IA-shift géén tab meer — bereikbaar via de
// avatar-knop rechtsboven in de AppHeader.
//
// Drie tabs, en de derde is een verzamelbak. De homepage droeg eerder
// elf uitgangen; die staan nu achter Meer zodat Vandaag over vanavond
// gaat in plaats van over navigatie. Vrienden stond hier ook nog los,
// maar zit al in Meer — dus weg uit de bar, en z'n teller telt op bij
// die van Meer.
const TAB_ICONS: Record<string, IconCmp> = {
  avond: TabIconAvond,
  agenda: TabIconAgenda,
  meer: TabIconMeer,
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
  // Meer draagt twee tellers samen: wat er te beoordelen staat op /new
  // (ná je baan-voorkeur) plus je openstaande vriend-verzoeken en
  // uitnodigingen. Eén getal op de bar, uitgesplitst per rij zodra je
  // Meer opent — anders weet je wel dát er iets is maar niet wát.
  const newSince = useNewBadgeSince();
  const activeLanes = useNewFilters((s) => s.activeLanes);
  const { data: arrivals } = useNewArrivalsSince(newSince, {
    enabled: isAuthed,
    lanes: activeLanes,
  });
  const meerBadge = (arrivals?.total ?? 0) + useSocialBadgeCount(isAuthed);

  // Op Android leverde expo-blur weinig effect, dus tint extra
  // opaque om de pill nog leesbaar te houden boven scrollende content.
  const tint =
    Platform.OS === 'android'
      ? mode === 'nacht'
        ? 'rgba(23,23,26,0.92)'
        : 'rgba(235,230,216,0.94)'
      : mode === 'nacht'
        ? 'rgba(23,23,26,0.65)'
        : 'rgba(235,230,216,0.7)';
  const border = mode === 'nacht' ? '#2a2a2d' : palette.paper;
  const idle = mode === 'nacht' ? '#6a6a68' : '#8a7e6b';
  // iOS: -16 corrigeert tegen de home-indicator-zone die toch al
  // diapublisher-vrij is. Android: insets.bottom is óf ~0 (gesture
  // nav, edge-to-edge) óf de hoogte van de 3-knops nav-bar (~48dp) —
  // beide gevallen willen we de pill ér boven plaatsen, niet erop,
  // dus geen -16 correctie. +4 voor ademruimte tussen pill en nav.
  const bottom =
    Platform.OS === 'android'
      ? insets.bottom + 4
      : Math.max(insets.bottom - 16, 4);

  // Filter naar alleen zichtbare tabs (kaart heeft href:null, valt af).
  const visible = state.routes.filter((r) => TAB_ICONS[r.name]);
  const currentRoute = state.routes[state.index];
  // Kaart en Venues hebben allebei een sluit-knop in hun header en
  // gedragen zich als een gepushte pagina onder Meer, niet als tab —
  // dus daar valt de balk weg. Anders zou je twee manieren terug
  // hebben die verschillende dingen doen.
  const onHiddenRoute = currentRoute
    ? !TAB_ICONS[currentRoute.name]
    : false;
  const hidesBar = onHiddenRoute;
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

  // Pas ná álle hooks early-returnen — anders schendt de
  // hook-volgorde tussen renders en gooit React "rendered fewer
  // hooks than expected" wanneer je van een zichtbare tab naar
  // /kaart navigeert.
  if (hidesBar) return null;

  // Verloop-blur áchter de pill — start vlak onder de pill-top en
  // loopt verder naar beneden tot het schermrand. Vangt taps op zodat
  // je niet per ongeluk op content tikt die zomaar onder de pill ligt.
  // Vroegere variant zat ver boven de pill en gaf 'n zware bovenrand;
  // nu compact zodat content erboven helder blijft.
  const fadeHeight = insets.bottom + 65;
  const tintNacht = 'rgba(10,10,11,0.8)';
  const tintDag = 'rgba(245,241,232,0.88)';
  const fadeTint = mode === 'nacht' ? tintNacht : tintDag;

  return (
    <>
      <View
        style={[styles.fade, { height: fadeHeight }]}
        pointerEvents="auto"
      >
        {Platform.OS === 'android' ? (
          <LinearGradient
            colors={['transparent', fadeTint, fadeTint]}
            locations={[0, 0.6, 1]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        ) : (
          <MaskedView
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
            maskElement={
              <LinearGradient
                colors={['transparent', '#000', '#000']}
                locations={[0, 0.6, 1]}
                style={StyleSheet.absoluteFill}
              />
            }
          >
            <BlurView
              intensity={32}
              tint={mode === 'nacht' ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          </MaskedView>
        )}
      </View>
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
        // Meer draagt de teller van /new: die zat eerder op een banner op
        // de homepage, en die banners zijn weg. Zonder dit zie je nergens
        // meer dát er iets te beoordelen is, en dat is precies waar de
        // dagelijkse lus op draait.
        const showBadge = route.name === 'meer' && meerBadge > 0 && !focused;
        const badgeLabel = meerBadge > 9 ? '9+' : String(meerBadge);
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
    </>
  );
}

const styles = StyleSheet.create({
  // Verloop-vlak áchter de pill — absoluut onderaan over de volle
  // breedte, fade van transparent (boven) naar getinte blur (onder).
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
  },
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
    // Vrij van het icoon geplaatst. Was -6/-10, wat prima werkte op de
    // smalle ring van Social maar op het bredere Meer-icoon (drie
    // stippen) bovenop de rechter stip landde.
    top: -8,
    right: -13,
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
