import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Cross } from '@/components/Cross';
import { EventListRow } from '@/components/EventListRow';
import type { ApiEventInviteRecord, ApiPublicUser } from '@/lib/api';
import { useSession } from '@/lib/authClient';
import { CATEGORY_TICK, formatTime } from '@/lib/eventDisplay';
import {
  useEvent,
  useFriends,
  useOutgoingFriendRequests,
  useSendInvites,
} from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export default function InviteModal() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const eventId = rawId ?? '';
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';

  const { data: event } = useEvent(eventId);
  const { data: friends } = useFriends();
  const { data: outgoing } = useOutgoingFriendRequests();
  const { data: session } = useSession();
  const sendInvites = useSendInvites();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  // Lijst combineert geaccepteerde vrienden + uitstaande verzoeken.
  // Pending-rijen zijn zichtbaar (zodat je ze kan terugvinden) maar
  // niet aanvinkbaar — je kan pas iemand uitnodigen als jullie écht
  // bevriend zijn (server-side check).
  const rows = useMemo(() => {
    type Row = {
      user: ApiPublicUser;
      friendshipPending: boolean;
    };
    const list: Row[] = [];
    for (const f of friends ?? []) {
      list.push({ user: f, friendshipPending: false });
    }
    for (const o of outgoing ?? []) {
      list.push({ user: o, friendshipPending: true });
    }
    return list.sort((a, b) => {
      // Geaccepteerde vrienden bovenaan, pending eronder, dan op naam.
      if (a.friendshipPending !== b.friendshipPending) {
        return a.friendshipPending ? 1 : -1;
      }
      return a.user.name.localeCompare(b.user.name);
    });
  }, [friends, outgoing]);

  // Map van vriend-id → bestaande invite-status. Pending/accepted/declined
  // betekent: deze persoon is al bekend met dit event, niet nogmaals
  // versturen.
  const inviteByUser = useMemo(() => {
    const map = new Map<string, ApiEventInviteRecord>();
    for (const inv of event?.myInvites ?? []) {
      map.set(inv.to.id, inv);
    }
    return map;
  }, [event?.myInvites]);

  const pendingFriendIds = useMemo(
    () => new Set((outgoing ?? []).map((o) => o.id)),
    [outgoing]
  );

  // Vrienden die je nu daadwerkelijk kan uitnodigen (geaccepteerd én
  // nog niet eerder voor dit event uitgenodigd). Als dit 0 is komt er
  // geen dock/bericht-veld maar een "vriend zoeken" call-to-action.
  const hasSelectable = useMemo(
    () =>
      rows.some(
        (r) => !r.friendshipPending && !inviteByUser.has(r.user.id)
      ),
    [rows, inviteByUser]
  );

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

  const onShareLink = async () => {
    if (!event) return;
    const refQs = session?.user?.id
      ? `?ref=${encodeURIComponent(session.user.id)}`
      : '';
    const url = `https://andreas.amsterdam/e/${encodeURIComponent(event.id)}${refQs}`;
    const messageBody = `Ik ga naar ${event.title} via Andreas. Wil je mee?\n${url}`;
    try {
      await Share.share(
        Platform.OS === 'ios'
          ? { url, message: messageBody }
          : { message: messageBody }
      );
      Haptics.selectionAsync();
    } catch {
      // User cancelled or share failed — geen actie nodig.
    }
  };

  const onSend = async () => {
    if (selected.size === 0 || !eventId) return;
    try {
      await sendInvites.mutateAsync({
        eventId,
        toUserIds: Array.from(selected),
        message: message.trim() || undefined,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSent(true);
      setTimeout(() => router.back(), 700);
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: roles.bg }]}
    >
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
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={[
            styles.closeBtn,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        >
          <Cross size={14} thickness={2.6} color={roles.fg} />
        </Pressable>
        <Text style={[styles.topTitle, { color: roles.fg }]}>Uitnodigen</Text>
        <View style={styles.topBarSpacer} />
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // Scroll de focused input automatisch boven het keyboard +
        // dock — anders verdwijnt 'ie achter de absolute dock-balk.
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: hasSelectable
            ? insets.bottom + 180
            : insets.bottom + 24,
        }}
      >
        {event && (
          <EventListRow
            time={formatTime(event.startsAt)}
            duration={event.category.toLowerCase()}
            thumb={event.imageUrl ?? ''}
            title={event.title}
            venue={event.venue.name}
            tags={[
              { label: event.category, tone: CATEGORY_TICK[event.category] },
            ]}
            tick={CATEGORY_TICK[event.category]}
          />
        )}

        <Text style={[styles.sectionTitle, { color: roles.fg }]}>
          Nodig iemand uit
        </Text>

        {/* Universele share-row — werkt voor vrienden in de app, vrienden
            zonder Andreas, en mensen buiten je netwerk. Open de native
            share-sheet zodat de afzender zelf het kanaal kiest. */}
        <Pressable
          onPress={onShareLink}
          style={[
            styles.shareRow,
            {
              borderTopColor: roles.bgChip,
              borderBottomColor: roles.bgChip,
            },
          ]}
        >
          <View
            style={[
              styles.shareIcon,
              { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Ionicons
              name="share-outline"
              size={18}
              color={roles.fg}
            />
          </View>
          <View style={styles.shareBody}>
            <Text style={[styles.shareTitle, { color: roles.fg }]}>
              Stuur via bericht
            </Text>
            <Text style={[styles.shareSub, { color: roles.fgMuted }]}>
              Werkt ook voor wie nog geen Andreas heeft
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={roles.fgPlaceholder}
          />
        </Pressable>

        {rows.map((r) => (
          <FriendCheckRow
            key={r.user.id}
            friend={r.user}
            checked={selected.has(r.user.id)}
            existingStatus={inviteByUser.get(r.user.id)?.status}
            friendshipPending={r.friendshipPending}
            onPress={() => toggle(r.user.id)}
          />
        ))}

        {!hasSelectable && (
          <View style={styles.emptyWrap}>
            <Text style={[styles.empty, { color: roles.fgMuted }]}>
              {rows.length === 0
                ? 'Je hebt nog geen vrienden op Andreas. Voeg er eerst eentje toe.'
                : 'Iedereen die je kent is al uitgenodigd of staat in de wachtkamer. Voeg een nieuwe vriend toe om mee te vragen.'}
            </Text>
            <Pressable
              onPress={() => {
                router.back();
                router.push('/add-friend' as never);
              }}
              style={[styles.emptyAction, { borderColor: roles.fgMuted }]}
            >
              <Ionicons name="person-add-outline" size={14} color={roles.fg} />
              <Text style={[styles.emptyActionText, { color: roles.fg }]}>
                Vriend zoeken
              </Text>
            </Pressable>
          </View>
        )}

        {hasSelectable && (
          <View style={styles.fieldGroup}>
            <Text style={[styles.label, { color: roles.fgMuted }]}>
              BERICHT (optioneel)
            </Text>
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
                placeholder="bv. ik haal je om 19:30 op"
                placeholderTextColor={roles.fgPlaceholder}
                multiline
                maxLength={280}
                style={[styles.input, { color: roles.fg }]}
              />
            </View>
          </View>
        )}
      </ScrollView>

      {hasSelectable && (
      <View
        style={[
          styles.dock,
          {
            paddingBottom: Math.max(insets.bottom, 12),
            backgroundColor: roles.bg,
            borderTopColor: roles.bgChip,
          },
        ]}
      >
        <Text style={[styles.count, { color: roles.fgMuted }]}>
          {selected.size === 0
            ? 'Selecteer iemand'
            : selected.size === 1
              ? '1 vriend gekozen'
              : `${selected.size} vrienden gekozen`}
        </Text>
        <Pressable
          onPress={onSend}
          disabled={selected.size === 0 || sendInvites.isPending || sent}
          style={[
            styles.cta,
            {
              backgroundColor: isNacht ? palette.acid : palette.red,
              opacity:
                selected.size === 0 || sendInvites.isPending ? 0.5 : 1,
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
              ? 'Verstuurd'
              : sendInvites.isPending
                ? 'Versturen…'
                : 'Stuur uitnodiging'}
          </Text>
        </Pressable>
      </View>
      )}
    </KeyboardAvoidingView>
  );
}

function FriendCheckRow({
  friend,
  checked,
  existingStatus,
  friendshipPending,
  onPress,
}: {
  friend: ApiPublicUser;
  checked: boolean;
  existingStatus?: ApiEventInviteRecord['status'];
  friendshipPending?: boolean;
  onPress: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
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
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[styles.rowName, { color: roles.fg }]}>
          {friend.name}
        </Text>
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
            Wacht op acceptatie
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

function InviteStatusBadge({
  status,
}: {
  status: ApiEventInviteRecord['status'];
}) {
  const roles = useRoles();
  const label =
    status === 'accepted'
      ? 'Gaat mee'
      : status === 'declined'
        ? 'Afgewezen'
        : 'Verstuurd';
  const textTone =
    status === 'accepted'
      ? roles.accent
      : status === 'declined'
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
  topBarSpacer: { width: 36, height: 36 },

  sectionTitle: {
    fontFamily: fontFamily.display,
    fontSize: 22,
    lineHeight: 22,
    letterSpacing: -0.5,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 10,
  },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  shareIcon: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareBody: { flex: 1, minWidth: 0 },
  shareTitle: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  shareSub: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    marginTop: 4,
  },

  emptyWrap: {
    paddingHorizontal: 22,
    paddingTop: 4,
    paddingBottom: 16,
    gap: 12,
    alignItems: 'flex-start',
  },
  empty: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
  },
  emptyAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  emptyActionText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.07,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
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

  fieldGroup: { gap: 6, paddingHorizontal: 22, paddingTop: 18 },
  label: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
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
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 22,
    paddingTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  count: {
    flex: 1,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 999,
  },
  ctaText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.07,
  },
});
