import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useIsRegistered } from '@/lib/authClient';
import { AccountWall } from '@/components/AccountWall';
import { Cross } from '@/components/Cross';
import { EventListRow } from '@/components/EventListRow';
import type { ApiEventInviteRecord, ApiGroupSummary, ApiPublicUser } from '@/lib/api';
import {
  eventImageUrl,
  CATEGORY_TICK,
  dowMixed,
  rowTimeLabel,
  monthShort,
  translateCategory,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { safeBack } from '@/lib/navigation';
import {
  useEvent,
  useFriends,
  useGroups,
  useOutgoingFriendRequests,
  useSendInvitations,
} from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export default function InviteModal() {
  const { id: rawId, o: rawOcc } = useLocalSearchParams<{
    id: string;
    o?: string;
  }>();
  const eventId = rawId ?? '';
  const targetOccurrenceId = typeof rawOcc === 'string' ? rawOcc : null;
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  // Track exact keyboard-height en gebruik 'm om de dock op `bottom:
  // keyboardHeight` te pinnen. KAV en automaticallyAdjustKeyboardInsets
  // bleken in praktijk te onbetrouwbaar binnen een modal-context op
  // iOS — handmatige tracking levert pixel-perfect positionering.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subShow = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    });
    const subHide = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);
  const keyboardOpen = keyboardHeight > 0;
  const dockBottomPadding = keyboardOpen ? 12 : Math.max(insets.bottom, 12);
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();

  const { data: event } = useEvent(eventId);
  const registered = useIsRegistered();
  const { data: friends } = useFriends({ enabled: registered });
  const { data: groups } = useGroups();
  const { data: outgoing } = useOutgoingFriendRequests();
  const sendInvites = useSendInvitations();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  // Resolve het invite-target: als er een ?o= query is gebruiken we die
  // (Agenda/Avond duwen 'm mee bij tap op een specifieke avond).
  // Anders pakken we de eerstvolgende occurrence van het event.
  const resolvedOccurrence = (() => {
    if (!event?.occurrences) return null;
    if (targetOccurrenceId) {
      const match = event.occurrences.find((o) => o.id === targetOccurrenceId);
      if (match) return match;
    }
    return event.occurrences[0] ?? null;
  })();
  const resolvedOccurrenceId = resolvedOccurrence?.id ?? null;

  // Lijst combineert geaccepteerde vrienden + uitstaande verzoeken.
  // Pending-rijen zijn zichtbaar (zodat je ze kan terugvinden) maar
  // niet aanvinkbaar — je kan pas iemand uitnodigen als jullie écht
  // bevriend zijn (server-side check).
  const rows = useMemo(() => {
    type Row = {
      user: ApiPublicUser;
      friendshipPending: boolean;
      favorite: boolean;
    };
    const list: Row[] = [];
    for (const f of friends ?? []) {
      list.push({
        user: f,
        friendshipPending: false,
        favorite: Boolean(f.favorite),
      });
    }
    for (const o of outgoing ?? []) {
      list.push({ user: o, friendshipPending: true, favorite: false });
    }
    return list.sort((a, b) => {
      // Bevriend vóór pending; binnen bevriend: favorieten eerst; daarna
      // alfabetisch op naam.
      if (a.friendshipPending !== b.friendshipPending) {
        return a.friendshipPending ? 1 : -1;
      }
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.user.name.localeCompare(b.user.name);
    });
  }, [friends, outgoing]);

  // Map van vriend-id → bestaande invite voor déze specifieke occurrence.
  // De DB-uniqueness is (from, to, occurrenceId), dus dezelfde vriend
  // kan voor verschillende avonden van een wekelijks feest of theater-
  // residency wél opnieuw uitgenodigd worden — de huidige filter zorgt
  // ervoor dat we alleen "al verstuurd voor deze avond" markeren.
  const inviteByUser = useMemo(() => {
    const map = new Map<string, ApiEventInviteRecord>();
    if (!resolvedOccurrenceId) return map;
    for (const inv of event?.myInvites ?? []) {
      if (inv.occurrenceId === resolvedOccurrenceId) {
        map.set(inv.to.id, inv);
      }
    }
    return map;
  }, [event?.myInvites, resolvedOccurrenceId]);

  const pendingFriendIds = useMemo(
    () => new Set((outgoing ?? []).map((o) => o.id)),
    [outgoing]
  );

  // Iets selecteerbaars? Vrienden waar je nog niemand voor gaf óf
  // minstens één groep. Als dit false is verschijnt geen dock maar een
  // CTA om vrienden toe te voegen of groep aan te maken.
  const hasSelectableFriends = useMemo(
    () =>
      rows.some(
        (r) => !r.friendshipPending && !inviteByUser.has(r.user.id)
      ),
    [rows, inviteByUser]
  );
  const hasSelectable = hasSelectableFriends || (groups?.length ?? 0) > 0;

  const toggle = (id: string) => {
    if (inviteByUser.has(id) || pendingFriendIds.has(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    Haptics.selectionAsync();
  };

  const toggleGroup = (id: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    Haptics.selectionAsync();
  };

  const totalSelected = selected.size + selectedGroups.size;

  const onSend = async () => {
    if (totalSelected === 0 || !eventId || !resolvedOccurrenceId) return;
    try {
      await sendInvites.mutateAsync({
        occurrenceId: resolvedOccurrenceId,
        eventId,
        userIds: selected.size > 0 ? Array.from(selected) : undefined,
        groupIds:
          selectedGroups.size > 0 ? Array.from(selectedGroups) : undefined,
        message: message.trim() || undefined,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSent(true);
      setTimeout(() => safeBack(), 700);
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <View
        style={[
          styles.topBar,
          {
            // iOS modals presenteren als sheet (begint onder status-bar) →
            // safe-area-inset is dubbel. Android krijgt 'm wel.
            paddingTop: Platform.OS === 'ios' ? 12 : insets.top + 6,
            borderBottomColor: roles.bgChip,
          },
        ]}
      >
        {Platform.OS === 'ios' ? (
          // iOS pageSheet: enkel een visuele drag-handle bovenaan;
          // swipe-down dismist sheet native.
          <View style={styles.dragHandleRow}>
            <View
              style={[styles.dragHandle, { backgroundColor: roles.bgChip }]}
            />
          </View>
        ) : (
          <Pressable
            onPress={() => safeBack()}
            hitSlop={8}
            style={[
              styles.closeBtn,
              { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Cross size={14} thickness={2.6} color={roles.fg} />
          </Pressable>
        )}
      </View>

      {!registered ? (
        // Uitnodigen gaat per definitie over iemand anders, dus hier stopt
        // anoniem. De muur staat op het scherm zelf en niet op de knop
        // ernaartoe: dan zie je nog wél voor welk event je 't wilde doen.
        <View style={{ flex: 1, paddingBottom: insets.bottom + 24 }}>
          <AccountWall
            icon="person-add-outline"
            title={t('Vraag iemand mee', 'Bring someone along')}
            body={t(
              'Nodig vrienden uit voor wat jij gevonden hebt en zie wie er meegaat.',
              'Invite friends to what you found and see who’s coming along.'
            )}
          />
        </View>
      ) : (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: hasSelectable
            ? insets.bottom + 260 + keyboardHeight
            : insets.bottom + 24,
        }}
      >
        {event && resolvedOccurrence && (
          <EventListRow
            time={rowTimeLabel(resolvedOccurrence.startsAt, resolvedOccurrence.endsAt, locale)}
            thumb={eventImageUrl(event) ?? ''}
            thumbSize={96}
            title={event.title}
            venue={resolvedOccurrence.venue?.name ?? event.venue.name}
            tags={[
              {
                label: translateCategory(event.category, locale),
                tone: CATEGORY_TICK[event.category],
              },
            ]}
            tick={CATEGORY_TICK[event.category]}
          />
        )}

        {/* Voor multi-occurrence events expliciet markeren welke avond
            we aan het uitnodigen zijn — anders snapt de gebruiker niet
            of hij voor maandag of vrijdag aan het uitnodigen is. */}
        {event &&
          resolvedOccurrence &&
          event.occurrences &&
          event.occurrences.length > 1 && (
            <View style={[styles.targetBanner, { backgroundColor: roles.bgTag }]}>
              <Text style={[styles.targetLabel, { color: roles.fgMuted }]}>
                {t('JE NODIGT UIT VOOR', 'YOU’RE INVITING FOR')}
              </Text>
              <Text style={[styles.targetValue, { color: roles.fg }]}>
                {formatTargetDate(resolvedOccurrence.startsAt, resolvedOccurrence.endsAt, locale)}
                {resolvedOccurrence.room ? ` · ${resolvedOccurrence.room}` : ''}
              </Text>
            </View>
          )}

        <Text style={[styles.sectionTitle, { color: roles.fg }]}>
          {t('Nodig iemand uit', 'Invite someone')}
        </Text>

        {/* Gecombineerde lijst: groepen, favorieten, andere vrienden —
            zelfde patroon als de Sociaal-tab. Geen aparte sectiekoppen,
            alle rijen delen één 56px avatar-cel zodat namen op één
            verticale lijn beginnen. `rows` is al gesorteerd op
            favoriete-vrienden eerst, daarna alfabetisch. */}
        {(groups ?? []).map((g) => (
          <GroupCheckRow
            key={g.id}
            group={g}
            checked={selectedGroups.has(g.id)}
            onPress={() => toggleGroup(g.id)}
          />
        ))}
        {rows.map((r) => (
          <FriendCheckRow
            key={r.user.id}
            friend={r.user}
            favorite={r.favorite}
            checked={selected.has(r.user.id)}
            existingStatus={inviteByUser.get(r.user.id)?.status}
            friendshipPending={r.friendshipPending}
            onPress={() => toggle(r.user.id)}
          />
        ))}

        {!hasSelectable && (
          <>
            <View
              style={[styles.divider, { backgroundColor: roles.bgChip }]}
            />
            <Text style={[styles.emptyHeading, { color: roles.fg }]}>
              {rows.length === 0
                ? t('Voeg eerst een vriend toe', 'Add a friend first')
                : t('Iemand anders erbij?', 'Someone else along?')}
            </Text>
            <View style={styles.emptyWrap}>
            <Text style={[styles.empty, { color: roles.fgMuted }]}>
              {rows.length === 0
                ? t(
                    'Je hebt nog geen vrienden op Andreas. Voeg er eentje toe om iemand mee te kunnen vragen.',
                    'You don’t have any friends on Andreas yet. Add one to invite them along.'
                  )
                : t(
                    'De beste avonden zijn die waar je achteraf iemand over kunt bellen met ‘zag je dat ook?’. Voeg iemand toe die er ook op gaat staan.',
                    'The best nights are the ones you can call someone about afterwards with ‘did you see that too?’. Add someone else who’ll also be there.'
                  )}
            </Text>
            <Pressable
              onPress={() => {
                safeBack();
                router.push('/add-friend' as never);
              }}
              style={[styles.emptyAction, { borderColor: roles.bgChip }]}
            >
              <Ionicons name="person-add-outline" size={16} color={roles.fgMuted} />
              <Text style={[styles.emptyActionText, { color: roles.fgMuted }]}>
                {t('Vriend zoeken', 'Find friends')}
              </Text>
            </Pressable>
            </View>
          </>
        )}

      </ScrollView>
      )}

      {hasSelectable && (
      <View
        style={[
          styles.dock,
          {
            bottom: keyboardHeight,
            paddingBottom: dockBottomPadding,
            backgroundColor: roles.bg,
            borderTopColor: roles.bgChip,
          },
        ]}
      >
        <View
          style={[
            styles.field,
            {
              borderColor: isNacht ? '#2a2a2d' : palette.paper,
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            },
          ]}
        >
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder={t(
              'bericht (optioneel)',
              'message (optional)'
            )}
            placeholderTextColor={roles.fgPlaceholder}
            multiline
            maxLength={280}
            style={[styles.input, { color: roles.fg }]}
          />
        </View>
        <Pressable
          onPress={onSend}
          disabled={totalSelected === 0 || sendInvites.isPending || sent}
          style={[
            styles.cta,
            {
              backgroundColor: isNacht ? palette.acid : palette.red,
              opacity:
                totalSelected === 0 || sendInvites.isPending ? 0.5 : 1,
            },
          ]}
        >
          <Ionicons
            name={sent ? 'checkmark' : 'paper-plane'}
            size={16}
            color={isNacht ? palette.noir : palette.paper3}
          />
          <Text
            style={[
              styles.ctaText,
              { color: isNacht ? palette.noir : palette.paper3 },
            ]}
          >
            {sent
              ? t('Verstuurd', 'Sent')
              : sendInvites.isPending
                ? t('Versturen…', 'Sending…')
                : t('Stuur uitnodiging', 'Send invitation')}
          </Text>
        </Pressable>
      </View>
      )}
    </View>
  );
}

function formatTargetDate(
  iso: string,
  endIso: string | null | undefined,
  locale: import('@/lib/i18n').Locale
): string {
  const d = new Date(iso);
  const dow = dowMixed(d.getDay(), locale);
  const day = d.getDate();
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  const time = rowTimeLabel(iso, endIso, locale);
  return `${dow} ${day} ${month} · ${time}`;
}

function FriendCheckRow({
  friend,
  favorite,
  checked,
  existingStatus,
  friendshipPending,
  onPress,
}: {
  friend: ApiPublicUser;
  favorite?: boolean;
  checked: boolean;
  existingStatus?: ApiEventInviteRecord['status'];
  friendshipPending?: boolean;
  onPress: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const disabled = Boolean(existingStatus) || Boolean(friendshipPending);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.row,
        { borderColor: roles.bgChip, opacity: disabled ? 0.55 : 1 },
      ]}
    >
      <View style={styles.avatarSlot}>
        {friend.avatarUrl ? (
          <Image
            source={{ uri: friend.avatarUrl }}
            style={styles.rowAvatar}
            contentFit="cover"
          />
        ) : (
          <View
            style={[
              styles.rowAvatar,
              styles.rowAvatarFallback,
              { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Text style={[styles.rowAvatarInitial, { color: roles.fgMuted }]}>
              {(friend.name.trim()[0] ?? '?').toUpperCase()}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.rowBody}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <Text
            numberOfLines={1}
            style={[styles.rowName, { color: roles.fg, flexShrink: 1 }]}
          >
            {friend.name}
          </Text>
          {favorite ? (
            <Ionicons name="star" size={13} color={roles.accent} />
          ) : null}
        </View>
        {friend.handle && (
          <Text
            numberOfLines={1}
            style={[styles.rowHandle, { color: roles.fgMuted }]}
          >
            @{friend.handle}
          </Text>
        )}
      </View>
      {existingStatus ? (
        <InviteStatusBadge status={existingStatus} />
      ) : friendshipPending ? (
        <View
          style={[styles.statusPill, { borderColor: `${roles.fgMuted}80` }]}
        >
          <Text style={[styles.statusText, { color: roles.fgMuted }]}>
            {t('Wacht op acceptatie', 'Awaiting acceptance')}
          </Text>
        </View>
      ) : (
        <View
          style={[
            styles.checkBox,
            checked
              ? { backgroundColor: roles.accent, borderColor: roles.accent }
              : { borderColor: roles.fgPlaceholder },
          ]}
        >
          {checked && (
            <Ionicons name="checkmark" size={16} color={roles.onAccent} />
          )}
        </View>
      )}
    </Pressable>
  );
}

function GroupCheckRow({
  group,
  checked,
  onPress,
}: {
  group: ApiGroupSummary;
  checked: boolean;
  onPress: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const memberCount = group.members.length;
  // Avatar-stack: 28px tiles met 14px offset zodat max 3 tiles in dezelfde
  // 56px-cel passen als de FriendCheckRow-avatar — namen lijnen daardoor
  // op één verticale lijn op.
  const visible = group.members.slice(0, 3);
  const overflow = Math.max(0, memberCount - visible.length);
  const totalTiles = visible.length + (overflow > 0 ? 1 : 0);
  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, { borderColor: roles.bgChip }]}
    >
      <View style={styles.avatarSlot}>
        {visible.map((m, i) => (
          <View
            key={m.id}
            style={[
              groupStyles.tile,
              {
                left: i * 14,
                zIndex: totalTiles - i,
                borderColor: roles.bg,
                backgroundColor: isNacht ? palette.noir2 : palette.paper2,
              },
            ]}
          >
            {m.avatarUrl ? (
              <Image
                source={{ uri: m.avatarUrl }}
                style={groupStyles.tileImage}
                contentFit="cover"
              />
            ) : (
              <Text style={[groupStyles.tileInitial, { color: roles.fgMuted }]}>
                {(m.name.trim()[0] ?? '?').toUpperCase()}
              </Text>
            )}
          </View>
        ))}
        {overflow > 0 && (
          <View
            style={[
              groupStyles.tile,
              {
                left: visible.length * 14,
                borderColor: roles.bg,
                backgroundColor: roles.bgChip,
              },
            ]}
          >
            <Text style={[groupStyles.tileInitial, { color: roles.fgMuted }]}>
              +{overflow}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.rowBody}>
        <Text
          numberOfLines={1}
          style={[styles.rowName, { color: roles.fg, flexShrink: 1 }]}
        >
          {group.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.rowHandle, { color: roles.fgMuted }]}
        >
          {memberCount === 1
            ? t('1 lid', '1 member')
            : t(`${memberCount} leden`, `${memberCount} members`)}
        </Text>
      </View>
      <View
        style={[
          styles.checkBox,
          checked
            ? { backgroundColor: roles.accent, borderColor: roles.accent }
            : { borderColor: roles.fgPlaceholder },
        ]}
      >
        {checked && (
          <Ionicons name="checkmark" size={16} color={roles.onAccent} />
        )}
      </View>
    </Pressable>
  );
}

const groupStyles = StyleSheet.create({
  tile: {
    position: 'absolute',
    top: 4,
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tileImage: { width: '100%', height: '100%' },
  tileInitial: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: -0.1,
  },
});

function InviteStatusBadge({
  status,
}: {
  status: ApiEventInviteRecord['status'];
}) {
  const roles = useRoles();
  const t = useT();
  const label =
    status === 'going'
      ? t('Gaat', 'Going')
      : status === 'maybe'
        ? t('Misschien', 'Maybe')
        : status === 'not_going'
          ? t('Afgezegd', 'Not coming')
          : t('Verstuurd', 'Sent');
  const textTone =
    status === 'going'
      ? roles.accent
      : status === 'not_going'
        ? roles.fgPlaceholder
        : roles.fgMuted;
  return (
    <View style={[styles.statusPill, { borderColor: `${textTone}80` }]}>
      <Text style={[styles.statusText, { color: textTone }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
    textAlign: 'center',
  },
  dragHandleRow: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dragHandle: {
    width: 44,
    height: 5,
    borderRadius: 2.5,
    opacity: 0.7,
  },
  topBarSpacer: { width: 36, height: 36 },

  targetBanner: {
    marginHorizontal: 22,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    gap: 4,
  },
  targetLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
  },
  targetValue: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },

  sectionTitle: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    lineHeight: 18,
    letterSpacing: -0.36,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 10,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 22,
    marginTop: 18,
    marginBottom: 18,
  },
  emptyHeading: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    lineHeight: 18,
    letterSpacing: -0.36,
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
  emptyWrap: {
    paddingHorizontal: 22,
    paddingTop: 4,
    paddingBottom: 16,
    gap: 12,
    alignItems: 'stretch',
  },
  empty: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 18,
  },
  emptyAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 999,
    borderWidth: 1,
  },
  emptyActionText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // Gedeelde 56px-cel voor zowel single avatars (vriend) als 3-tile
  // group-stacks. Houdt naam-start op één verticale lijn over alle
  // rij-types.
  avatarSlot: {
    width: 56,
    height: 36,
    position: 'relative',
    justifyContent: 'center',
  },
  rowAvatar: { width: 36, height: 36, borderRadius: 999 },
  rowAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  rowAvatarInitial: {
    fontFamily: fontFamily.display,
    fontSize: 16,
    letterSpacing: -0.4,
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  rowHandle: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  checkBox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusPill: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 9,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },

  field: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 12,
    minHeight: 80,
  },
  input: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    padding: 0,
    minHeight: 56,
    textAlignVertical: 'top',
  },

  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 22,
    paddingTop: 14,
    flexDirection: 'column',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 14,
    alignSelf: 'stretch',
  },
  ctaText: {
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.07,
  },
});
