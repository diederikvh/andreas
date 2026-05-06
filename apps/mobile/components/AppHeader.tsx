import { Ionicons } from '@expo/vector-icons';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Cross } from '@/components/Cross';
import { useModeSwitch } from '@/components/ModeCurtain';
import { useSession } from '@/lib/authClient';
import { useFriendRequests, useInvites } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export const HEADER_HEIGHT = 46;

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
export function AppHeader({ children, solid = false }: AppHeaderProps = {}) {
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
        </View>
        <View style={styles.rightCluster}>
          <InboxBell />
          <DnSwitch />
        </View>
      </View>
      {children}
    </View>
  );
}

function InboxBell() {
  const roles = useRoles();
  const { data: session } = useSession();
  const isAuthed = Boolean(session?.user?.id);
  // Queries blijven cold-disabled tot er een sessie is — anders krijgen
  // we 401's bij anonieme schermen (welkom-flow).
  const { data: requests } = useFriendRequests({ enabled: isAuthed });
  const { data: invites } = useInvites({ enabled: isAuthed });
  if (!isAuthed) return null;

  const count = (requests?.length ?? 0) + (invites?.length ?? 0);
  const showBadge = count > 0;
  const label = count > 9 ? '9+' : String(count);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        showBadge
          ? `Inbox, ${count} ${count === 1 ? 'item' : 'items'} openstaand`
          : 'Inbox'
      }
      onPress={() => router.push('/inbox')}
      hitSlop={6}
      style={styles.bellWrap}
    >
      <Ionicons
        name="notifications-outline"
        size={22}
        color={showBadge ? roles.fg : roles.fgPlaceholder}
      />
      {showBadge && (
        <View
          style={[
            styles.bellBadge,
            { backgroundColor: roles.accent, borderColor: roles.bg },
          ]}
        >
          <Text
            style={[styles.bellBadgeText, { color: roles.onAccent }]}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function DnSwitch() {
  const mode = useMode();
  const roles = useRoles();
  const switchMode = useModeSwitch();
  const isNacht = mode === 'nacht';

  const trackBg = isNacht ? 'rgba(31,31,35,0.7)' : 'rgba(235,230,216,0.7)';
  const trackBorder = isNacht ? '#2a2a2d' : palette.paper;
  const idle = roles.fgPlaceholder;

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: isNacht }}
      onPress={switchMode}
      hitSlop={8}
      style={[
        styles.dnTrack,
        { backgroundColor: trackBg, borderColor: trackBorder },
      ]}
    >
      <View style={[styles.dnGlyph, styles.dnSun, { backgroundColor: idle }]} />
      <Ionicons
        name="moon"
        size={12}
        color={idle}
        style={styles.dnMoonIcon}
      />
      <View
        style={[
          styles.dnThumb,
          {
            backgroundColor: roles.accent,
            left: isNacht ? undefined : 2,
            right: isNacht ? 2 : undefined,
          },
        ]}
      />
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
  logoLockup: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rightCluster: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  bellWrap: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadge: {
    position: 'absolute',
    top: -2,
    right: -4,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 999,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadgeText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.2,
    fontWeight: '600',
    lineHeight: 11,
  },
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

  // Day/night switch (52×28 pill, thumb 22)
  dnTrack: {
    width: 52,
    height: 28,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
  },
  dnGlyph: {
    position: 'absolute',
    top: '50%',
    marginTop: -5, // -height/2
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  dnSun: { left: 8 },
  dnMoonIcon: {
    position: 'absolute',
    top: '50%',
    right: 7,
    marginTop: -6, // -size/2
  },
  dnThumb: {
    position: 'absolute',
    top: '50%',
    marginTop: -11, // -height/2
    width: 22,
    height: 22,
    borderRadius: 999,
  },
});
