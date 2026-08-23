import { useFocusEffect } from '@react-navigation/native';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Cross } from '@/components/Cross';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { tinyTap } from '@/lib/haptics';
import { useIsRegistered } from '@/lib/authClient';
import { useMe } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export const HEADER_HEIGHT = 36;

type AppHeaderProps = {
  /**
   * Optional extra row(s) under the logo+switch — e.g. Agenda's
   * day-strip. The whole wrap (header row + children) sits inside one
   * BlurView so it reads as a single floating bar.
   */
  children?: ReactNode;
  /**
   * Steviger leesbaar maken — extra tinted overlay over de blur. Aan
   * voor schermen met sticky controls die rust nodig hebben (Agenda's
   * day-strip + chip-row); standaard uit zodat de blur het werk doet.
   */
  solid?: boolean;
  /**
   * Optionele scherm-naam die naast het logo wordt getoond, bv.
   * "VANDAAG", "AGENDA". Lichter weight + muted-kleur zodat de
   * Andreas-wordmark de primaire identiteit blijft.
   */
  title?: string;
  /**
   * Verbergt de avatar-knop rechtsboven. Default false. Aan zetten op
   * /jij zelf zodat 'r geen "avatar → /jij → zelfde avatar → /jij"-
   * loop ontstaat.
   */
  hideAvatar?: boolean;
  /**
   * Overschrijft de standaard-inhoud van het rechter-blok (Content-
   * mode-switch + avatar) door custom JSX. Gebruikt op de Kaart-tab
   * om een sluit-knop op de avatar-plek te zetten in plaats van de
   * standaard navigatie-affordance.
   */
  rightSlot?: ReactNode;
};

/**
 * Shared header for the main tab screens — Andreas wordmark + cross
 * left, day/night switch right. The blur fades out at the bottom edge
 * so scroll content reads cleanly underneath.
 *
 * Mount once at the bottom of a screen with `position: absolute`; the
 * screen's ScrollView gets `paddingTop = insets.top + HEADER_HEIGHT`
 * (plus whatever children add).
 */
export function AppHeader({
  children,
  solid = false,
  title,
  hideAvatar = false,
  rightSlot,
}: AppHeaderProps = {}) {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();

  // Focus-key bumpt bij élk focus-event op de host-screen — behalve de
  // eerste mount, want daar speelt de Animated.Text z'n entering al
  // vanzelf. Zo speelt de title-animatie óók wanneer je terugkeert naar
  // een tab die al gemount is (tabs blijven default mounted in
  // expo-router, dus zonder dit zou de animatie alleen op de aller-
  // eerste bezoek vuren).
  const [focusKey, setFocusKey] = useState(0);
  const isFirstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (isFirstFocus.current) {
        isFirstFocus.current = false;
        return;
      }
      setFocusKey((k) => k + 1);
    }, [])
  );

  return (
    // pointerEvents="box-none" laat de header zelf geen touches vangen,
    // zodat scroll-gestures (en pull-to-refresh!) op de scrollview
    // eronder blijven werken — zelfs als je vanaf de top van het
    // scherm trekt door de header heen. Alleen de Pressable kinderen
    // (logo, DnSwitch, children) blijven tappable.
    <View
      style={[styles.wrap, { paddingTop: insets.top }]}
      pointerEvents="box-none"
    >
      {solid ? (
        // Solid header: blur + tint, géén fade — harde rand onderaan.
        // Past bij schermen die een sticky-controls strip nodig
        // hebben (Agenda chip-row, Kaart map-view). Op Android levert
        // expo-blur in praktijk weinig effect, dus we drijven daar op
        // een hogere tint-alpha zodat de strip leesbaar blijft over
        // scrollende content.
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {Platform.OS === 'ios' && (
            <BlurView
              intensity={40}
              tint={mode === 'nacht' ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          )}
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor:
                  Platform.OS === 'android'
                    ? mode === 'nacht'
                      ? 'rgba(10,10,11,0.92)'
                      : 'rgba(255,255,255,0.95)'
                    : mode === 'nacht'
                      ? 'rgba(10,10,11,0.78)'
                      : 'rgba(255,255,255,0.82)',
              },
            ]}
          />
        </View>
      ) : Platform.OS === 'android' ? (
        // Android-fallback voor de gemaskte BlurView: een verticale
        // gradient van semi-opaque tint → transparent. Mimics de
        // 'blur fade onder de header'-look zonder dat we afhangen van
        // expo-blur (die op Android tot net-zichtbare ruis verbleekt).
        <LinearGradient
          colors={
            mode === 'nacht'
              ? ['rgba(10,10,11,0.92)', 'rgba(10,10,11,0.88)', 'transparent']
              : ['rgba(255,255,255,0.94)', 'rgba(255,255,255,0.9)', 'transparent']
          }
          locations={[0, 0.7, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : (
        // iOS: transparante header met echte blur die naar onderen
        // wegvaagt — standaard treatment voor schermen waar content
        // er onder doorscrollt.
        <MaskedView
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
          maskElement={
            <LinearGradient
              colors={['#000', '#000', 'transparent']}
              locations={[0, 0.7, 1]}
              style={StyleSheet.absoluteFill}
            />
          }
        >
          <BlurView
            intensity={40}
            tint={mode === 'nacht' ? 'dark' : 'light'}
            style={StyleSheet.absoluteFill}
          />
        </MaskedView>
      )}
      <View style={styles.header} pointerEvents="box-none">
        <View style={styles.logoLockup} pointerEvents="none">
          <Text style={[styles.wordmark, { color: roles.fg }]}>Andreas</Text>
          <View style={styles.logoCross}>
            <Cross size={16} thickness={4} color={roles.accent} />
          </View>
          {title && (
            // key combineert title + focusKey: title-wijziging triggert
            // remount (en dus entering), en bij terugkeer naar een al
            // gemounte tab bumpt useFocusEffect de focusKey waardoor de
            // animatie ook dan opnieuw vuurt.
            <Animated.Text
              key={`${title}-${focusKey}`}
              entering={FadeInDown.duration(260)}
              style={[styles.title, { color: roles.fg }]}
              numberOfLines={1}
            >
              {title}
            </Animated.Text>
          )}
        </View>
        <View style={styles.headerRight}>
          {rightSlot ? rightSlot : !hideAvatar && <AvatarButton />}
        </View>
      </View>
      {children}
    </View>
  );
}

function AvatarButton() {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const { data: me } = useMe();
  const registered = useIsRegistered();

  const onPress = () => {
    tinyTap();
    router.push('/jij' as never);
  };

  // Niet-ingelogd: een rustige stip (4px) — minimale hint dat hier
  // 'iets met jou' zit, zonder de visuele zwaarte van een
  // avatar-bolletje. Pas na log-in wordt 't een echte avatar.
  //
  // Anoniem valt hier ook onder. De plugin geeft zulke users de naam
  // "Anonymous", en daar een 'A' van maken suggereert een persoon die
  // er niet is. De knop zélf blijft staan: /jij is de enige route naar
  // je instellingen, en die heb je anoniem net zo goed nodig.
  if (!me || !registered) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Profiel"
        onPress={onPress}
        hitSlop={6}
        style={[
          styles.avatarDotWrap,
          {
            backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            borderColor: isNacht ? '#2a2a2d' : palette.paper,
          },
        ]}
      >
        <View
          style={[
            styles.avatarDot,
            { backgroundColor: roles.fgPlaceholder },
          ]}
        />
      </Pressable>
    );
  }
  const displayName =
    me.name && !me.name.startsWith('+') ? me.name : me.handle ?? '?';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Profiel — ${displayName}`}
      onPress={onPress}
      hitSlop={6}
    >
      <ProfileAvatar avatarUrl={me.avatarUrl ?? null} name={displayName} size={28} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    // Extra ruimte tussen de laatste controle-rij en de fade-edge
    // van de blur — anders eindigt de fade te abrupt onder de
    // tabbar/switch.
    paddingBottom: 4,
  },
  header: {
    height: HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  logoLockup: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  // Optical centring against the Archivo Black caps — uppercase has no
  // descenders so the text's visual centre sits above the row centre.
  logoCross: { transform: [{ translateY: -1 }] },
  wordmark: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.18,
    textTransform: 'uppercase',
    lineHeight: 18,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.18,
    textTransform: 'uppercase',
    lineHeight: 18,
    flexShrink: 1,
  },

  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  avatarBtn: {
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Wrap voor de niet-ingelogd-stip — zelfde 28×28 cirkel met bg +
  // border als de content-switch ernaast, zodat de drie elementen
  // rechtsboven (switch + avatar-stip) visueel als familie ogen.
  avatarDotWrap: {
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarDot: {
    width: 4,
    height: 4,
    borderRadius: 999,
  },
});
