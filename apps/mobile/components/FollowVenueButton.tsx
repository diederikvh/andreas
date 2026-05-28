/**
 * Venue-follow-knop met action-sheet voor de drie staten:
 * volgen / niet-volgen / blokkeren. Gebruikt zowel op de venue-detail
 * page als op event-cards in /clubs, /live, /theater.
 *
 * Het server-truth is `VenueFollowState`; vanuit een lean events-respons
 * krijg je alleen een boolean (`venueFollowed`). De caller mapt die
 * boolean naar 'volgen' / 'normaal' — geblokkeerde venues komen sowieso
 * niet in de events-feed terug.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Cross } from '@/components/Cross';
import type { VenueFollowState } from '@/lib/api';
import { useSession } from '@/lib/authClient';
import { useT } from '@/lib/i18n';
import { useSetVenueFollow } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export function FollowVenueButton({
  venueId,
  name,
  state,
  size = 40,
  style,
}: {
  venueId: string;
  name: string;
  state: VenueFollowState;
  /** Diameter van de ronde knop. Default 40 (matcht venue-detail). */
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const mode = useMode();
  const roles = useRoles();
  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const setFollow = useSetVenueFollow();
  const [sheetOpen, setSheetOpen] = useState(false);

  const iconName: keyof typeof Ionicons.glyphMap =
    state === 'volgen'
      ? 'bookmark'
      : state === 'blokken'
        ? 'ban-outline'
        : 'bookmark-outline';
  const iconColor =
    state === 'volgen'
      ? mode === 'nacht'
        ? palette.acid
        : palette.red
      : state === 'blokken'
        ? roles.fg
        : roles.fg;

  const onPick = (next: VenueFollowState) => {
    setSheetOpen(false);
    if (next === state) return;
    Haptics.selectionAsync();
    setFollow.mutate({ venueId, state: next });
  };

  const onTap = () => {
    if (!authed) {
      router.push('/jij' as never);
      return;
    }
    setSheetOpen(true);
  };

  return (
    <>
      <Pressable
        onPress={onTap}
        hitSlop={6}
        style={[
          styles.btn,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor:
              mode === 'nacht' ? palette.noir2 : palette.paper2,
          },
          style,
        ]}
      >
        <Ionicons name={iconName} size={Math.round(size * 0.5)} color={iconColor} />
      </Pressable>
      <Modal
        visible={sheetOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSheetOpen(false)}
      >
        <FollowVenueSheet
          name={name}
          current={state}
          onPick={onPick}
          onClose={() => setSheetOpen(false)}
        />
      </Modal>
    </>
  );
}

function FollowVenueSheet({
  name,
  current,
  onPick,
  onClose,
}: {
  name: string;
  current: VenueFollowState;
  onPick: (next: VenueFollowState) => void;
  onClose: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();

  const options: {
    state: VenueFollowState;
    title: string;
    sub: string;
    icon: keyof typeof Ionicons.glyphMap;
  }[] = [
    {
      state: 'volgen',
      title: t('Volgen', 'Follow'),
      sub: t(
        'Events van deze venue komen prominent in je feed.',
        'Events from this venue appear prominently in your feed.'
      ),
      icon: 'bookmark',
    },
    {
      state: 'normaal',
      title: t('Niet volgen', 'Don’t follow'),
      sub: t(
        'Standaard. Events worden gewoon getoond, geen voorkeur.',
        'Default. Events show as usual, no preference.'
      ),
      icon: 'bookmark-outline',
    },
    {
      state: 'blokken',
      title: t('Blokkeren', 'Block'),
      sub: t(
        'Events van deze venue verschijnen nergens meer in de app.',
        'Events from this venue won’t appear anywhere in the app.'
      ),
      icon: 'ban-outline',
    },
  ];

  return (
    <View style={[sheetStyles.root, { backgroundColor: roles.bg }]}>
      <View style={sheetStyles.handleWrap}>
        <View
          style={[sheetStyles.handle, { backgroundColor: roles.fgPlaceholder }]}
        />
      </View>
      {Platform.OS !== 'ios' && (
        <Pressable
          onPress={onClose}
          hitSlop={8}
          style={[
            sheetStyles.closeBtn,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        >
          <Cross size={14} thickness={2.6} color={roles.fg} />
        </Pressable>
      )}
      <View style={sheetStyles.body}>
        <Text style={[sheetStyles.title, { color: roles.fg }]}>{name}</Text>
        <Text style={[sheetStyles.lead, { color: roles.fgMuted }]}>
          {t('Hoe wil je deze venue zien?', 'How do you want to see this venue?')}
        </Text>
        <View style={sheetStyles.options}>
          {options.map((opt) => {
            const active = opt.state === current;
            const accent =
              opt.state === 'blokken'
                ? '#c9453a'
                : isNacht
                  ? palette.acid
                  : palette.red;
            return (
              <Pressable
                key={opt.state}
                onPress={() => onPick(opt.state)}
                style={[
                  sheetStyles.option,
                  {
                    borderColor: active ? accent : roles.bgChip,
                    backgroundColor: active ? `${accent}14` : 'transparent',
                  },
                ]}
              >
                <Ionicons
                  name={opt.icon}
                  size={22}
                  color={active ? accent : roles.fgMuted}
                />
                <View style={sheetStyles.optionBody}>
                  <Text
                    style={[
                      sheetStyles.optionTitle,
                      { color: active ? accent : roles.fg },
                    ]}
                  >
                    {opt.title}
                  </Text>
                  <Text style={[sheetStyles.optionSub, { color: roles.fgMuted }]}>
                    {opt.sub}
                  </Text>
                </View>
                {active && (
                  <Ionicons name="checkmark" size={20} color={accent} />
                )}
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

const sheetStyles = StyleSheet.create({
  root: { flex: 1 },
  handleWrap: { alignItems: 'center', paddingTop: 8, paddingBottom: 8 },
  handle: { width: 44, height: 5, borderRadius: 2.5, opacity: 0.6 },
  closeBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, paddingHorizontal: 22, paddingTop: 24 },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 24,
    lineHeight: 24 * 1.05,
    letterSpacing: -0.6,
  },
  lead: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
    marginBottom: 22,
  },
  options: { gap: 10 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  optionBody: { flex: 1, minWidth: 0 },
  optionTitle: {
    fontFamily: fontFamily.medium,
    fontSize: 15,
    letterSpacing: -0.15,
  },
  optionSub: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
});
