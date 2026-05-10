import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ContentModeSwitch } from '@/components/ContentModeSwitch';
import { Cross } from '@/components/Cross';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { tinyTap } from '@/lib/haptics';
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
   * Toont de Uit/Expo content-mode-switch in de rechter-rij van de
   * header (tussen DnSwitch's oude plek en de avatar). Alleen aan op
   * Vandaag + Agenda — andere schermen zien 'm niet omdat de switch
   * daar niets doet.
   */
  showContentMode?: boolean;
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
  showContentMode = false,
}: AppHeaderProps = {}) {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
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
        // hebben (Agenda chip-row, Kaart map-view).
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <BlurView
            intensity={40}
            tint={mode === 'nacht' ? 'dark' : 'light'}
            style={StyleSheet.absoluteFill}
          />
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor:
                  mode === 'nacht'
                    ? 'rgba(10,10,11,0.78)'
                    : 'rgba(245,241,232,0.82)',
              },
            ]}
          />
        </View>
      ) : (
        // Transparante header met blur die naar onderen wegvaagt —
        // standaard treatment voor schermen waar content er onder
        // doorscrollt.
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
            <Text
              style={[styles.title, { color: roles.fg }]}
              numberOfLines={1}
            >
              {title}
            </Text>
          )}
        </View>
        <View style={styles.headerRight}>
          {showContentMode && <ContentModeSwitch />}
          <AvatarButton />
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

  const onPress = () => {
    tinyTap();
    router.push('/jij' as never);
  };

  // Niet-ingelogd: een rustige stip (4px) — minimale hint dat hier
  // 'iets met jou' zit, zonder de visuele zwaarte van een
  // avatar-bolletje. Pas na log-in wordt 't een echte avatar.
  if (!me) {
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
