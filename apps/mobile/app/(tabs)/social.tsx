import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { Cross } from '@/components/Cross';
import { EventListRow } from '@/components/EventListRow';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SpinningCross } from '@/components/SpinningCross';
import type {
  ApiEvent,
  ApiFriend,
  ApiFriendRequest,
  ApiInvite,
} from '@/lib/api';
import { useSession } from '@/lib/authClient';
import {
  CATEGORY_TICK,
  DOW_NL_MIXED,
  type EventGroup,
  formatTime,
  groupEventsByDay,
} from '@/lib/eventDisplay';
import {
  useAcceptFriendRequest,
  useAcceptInvite,
  useDeclineFriendRequest,
  useDeclineInvite,
  useFriendRequests,
  useFriends,
  useInvites,
  useMySaves,
  useOutgoingFriendRequests,
  useRemoveFriend,
} from '@/lib/queries';
import { useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const SUB_TAB_HEIGHT = 44;

type Sub = 'vrienden' | 'planning';

/**
 * Social-tab — bundelt alles wat met andere mensen te maken heeft:
 *
 *  - **Vrienden**: openstaande aanvragen + uitnodigingen bovenaan,
 *    daaronder de vrienden-lijst en aangevraagde verzoeken.
 *  - **Planning**: jouw opgeslagen events, gegroepeerd per dag.
 *
 * De badge op de tab in de TabBar telt openstaande aanvragen + invites
 * — zodat je vanaf elk scherm ziet dat er iets op je wacht.
 */
export default function Social() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const qc = useQueryClient();

  const [sub, setSub] = useState<Sub>('vrienden');

  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);

  const { data: requests } = useFriendRequests({ enabled: authed });
  const { data: invites } = useInvites({ enabled: authed });
  const { data: friends } = useFriends({ enabled: authed });
  const { data: outgoing } = useOutgoingFriendRequests({ enabled: authed });
  const { data: saves, isLoading: savesLoading, error: savesError } =
    useMySaves({ enabled: authed });

  const acceptReq = useAcceptFriendRequest();
  const declineReq = useDeclineFriendRequest();
  const acceptInv = useAcceptInvite();
  const declineInv = useDeclineInvite();

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['friend-requests'] }),
        qc.invalidateQueries({ queryKey: ['invites'] }),
        qc.invalidateQueries({ queryKey: ['friends'] }),
        qc.invalidateQueries({ queryKey: ['outgoing-friend-requests'] }),
        qc.invalidateQueries({ queryKey: ['saves'] }),
      ]);
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) await new Promise((r) => setTimeout(r, 700 - elapsed));
      setRefreshing(false);
    }
  }, [qc]);

  const topInset = insets.top + HEADER_HEIGHT + SUB_TAB_HEIGHT;
  const bottomInset = insets.bottom + 96;

  const inboxCount = (requests?.length ?? 0) + (invites?.length ?? 0);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner visible={refreshing} topOffset={topInset + 8} />
      <ScrollView
        ref={scrollRef}
        style={styles.page}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: topInset, paddingBottom: bottomInset }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={roles.accent}
            colors={[roles.accent]}
            progressViewOffset={topInset}
          />
        }
      >
        {sub === 'vrienden' ? (
          <FriendsPanel
            authed={authed}
            requests={requests}
            invites={invites}
            friends={friends}
            outgoing={outgoing}
            onAcceptReq={(id) => acceptReq.mutate(id)}
            onDeclineReq={(id) => declineReq.mutate(id)}
            onAcceptInv={(id) => acceptInv.mutate(id)}
            onDeclineInv={(id) => declineInv.mutate(id)}
            busyReq={acceptReq.isPending || declineReq.isPending}
            busyInv={acceptInv.isPending || declineInv.isPending}
          />
        ) : (
          <PlanningPanel
            authed={authed}
            saves={saves}
            isLoading={savesLoading}
            error={savesError}
          />
        )}
      </ScrollView>
      <AppHeader solid>
        <SubTabs sub={sub} onChange={setSub} inboxCount={inboxCount} />
      </AppHeader>
    </View>
  );
}

function SubTabs({
  sub,
  onChange,
  inboxCount,
}: {
  sub: Sub;
  onChange: (s: Sub) => void;
  inboxCount: number;
}) {
  const roles = useRoles();
  return (
    <View style={styles.subTabsWrap}>
      <SubTab
        label="Vrienden"
        active={sub === 'vrienden'}
        badge={inboxCount}
        onPress={() => onChange('vrienden')}
      />
      <SubTab
        label="Planning"
        active={sub === 'planning'}
        onPress={() => onChange('planning')}
      />
    </View>
  );
}

function SubTab({
  label,
  active,
  badge = 0,
  onPress,
}: {
  label: string;
  active: boolean;
  badge?: number;
  onPress: () => void;
}) {
  const roles = useRoles();
  return (
    <Pressable onPress={onPress} hitSlop={6} style={styles.subTab}>
      <Text
        style={[
          styles.subTabLabel,
          { color: active ? roles.fg : roles.fgMuted },
        ]}
      >
        {label}
      </Text>
      {badge > 0 && (
        <View style={[styles.subTabBadge, { backgroundColor: roles.accent }]}>
          <Text style={[styles.subTabBadgeText, { color: roles.onAccent }]}>
            {badge > 9 ? '9+' : badge}
          </Text>
        </View>
      )}
      <View
        style={[
          styles.subTabUnderline,
          { backgroundColor: active ? roles.fg : 'transparent' },
        ]}
      />
    </Pressable>
  );
}

// ─── Vrienden-panel ─────────────────────────────────────────────────

function FriendsPanel({
  authed,
  requests,
  invites,
  friends,
  outgoing,
  onAcceptReq,
  onDeclineReq,
  onAcceptInv,
  onDeclineInv,
  busyReq,
  busyInv,
}: {
  authed: boolean;
  requests: ApiFriendRequest[] | undefined;
  invites: ApiInvite[] | undefined;
  friends: ApiFriend[] | undefined;
  outgoing: ApiFriendRequest[] | undefined;
  onAcceptReq: (id: string) => void;
  onDeclineReq: (id: string) => void;
  onAcceptInv: (id: string) => void;
  onDeclineInv: (id: string) => void;
  busyReq: boolean;
  busyInv: boolean;
}) {
  const roles = useRoles();

  if (!authed) {
    return (
      <View style={styles.emptyCenter}>
        <Ionicons name="people-outline" size={48} color={roles.fgMuted} />
        <Text style={[styles.emptyTitle, { color: roles.fg }]}>
          Log in om je vrienden te zien
        </Text>
        <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
          Vrienden delen wat ze hebben gepland — log in via Jij om jullie
          netwerk te zien.
        </Text>
      </View>
    );
  }

  const hasInbox =
    (invites && invites.length > 0) || (requests && requests.length > 0);
  const hasFriends = friends && friends.length > 0;
  const hasOutgoing = outgoing && outgoing.length > 0;

  if (!hasInbox && !hasFriends && !hasOutgoing) {
    return (
      <View style={styles.emptyCenter}>
        <Ionicons name="people-outline" size={48} color={roles.fgMuted} />
        <Text style={[styles.emptyTitle, { color: roles.fg }]}>
          Nog geen vrienden
        </Text>
        <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
          Voeg iemand toe via @handle of QR-code. Hun gereeplande events
          komen hier terug.
        </Text>
        <Pressable
          onPress={() => router.push('/add-friend')}
          style={[styles.emptyCta, { backgroundColor: roles.accent }]}
        >
          <Text style={[styles.emptyCtaText, { color: roles.onAccent }]}>
            Vriend toevoegen
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(180)}>
      {invites && invites.length > 0 && (
        <>
          <SectionHead label="Uitnodigingen" count={invites.length} />
          {invites.map((inv) => (
            <InviteRow
              key={inv.id}
              invite={inv}
              onAccept={() => onAcceptInv(inv.id)}
              onDecline={() => onDeclineInv(inv.id)}
              busy={busyInv}
            />
          ))}
        </>
      )}
      {requests && requests.length > 0 && (
        <>
          <SectionHead label="Aanvragen" count={requests.length} />
          {requests.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              onAccept={() => onAcceptReq(r.id)}
              onDecline={() => onDeclineReq(r.id)}
              busy={busyReq}
            />
          ))}
        </>
      )}
      {hasFriends && (
        <>
          <SectionHead
            label="Vrienden"
            count={friends?.length}
            action="Toevoegen"
            onAction={() => router.push('/add-friend')}
          />
          {friends?.map((f) => <FriendRow key={f.id} friend={f} />)}
        </>
      )}
      {hasOutgoing && (
        <>
          <SectionHead label="Aangevraagd" count={outgoing?.length} />
          {outgoing?.map((o) => <PendingRow key={o.id} user={o} />)}
        </>
      )}
    </Animated.View>
  );
}

// ─── Planning-panel ─────────────────────────────────────────────────

function PlanningPanel({
  authed,
  saves,
  isLoading,
  error,
}: {
  authed: boolean;
  saves: ApiEvent[] | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  const roles = useRoles();

  const upcoming = useMemo(() => {
    if (!saves) return [];
    const now = Date.now();
    return saves.filter(
      (s) => new Date(s.endsAt ?? s.startsAt).getTime() >= now
    );
  }, [saves]);
  const past = useMemo(() => {
    if (!saves) return [];
    const now = Date.now();
    return saves
      .filter((s) => new Date(s.endsAt ?? s.startsAt).getTime() < now)
      .sort(
        (a, b) =>
          new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime()
      );
  }, [saves]);

  const upcomingDays: EventGroup[] = useMemo(
    () => groupEventsByDay(upcoming),
    [upcoming]
  );
  const pastDays: EventGroup[] = useMemo(
    () => groupEventsByDay(past).reverse(),
    [past]
  );

  const noSaves =
    (!authed && !isLoading) ||
    (authed && !isLoading && !error && (saves?.length ?? 0) === 0);

  if (noSaves) {
    return (
      <View style={styles.emptyCenter}>
        <Ionicons name="heart-outline" size={48} color={roles.fgMuted} />
        <Text style={[styles.emptyTitle, { color: roles.fg }]}>
          Nog niks opgeslagen.
        </Text>
        <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
          Hier komt je planning te staan — alle feestjes, voorstellingen
          en tentoonstellingen waar je naartoe wil. Tik bij een event op
          het hartje om hem op te slaan.
        </Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.loadingWrap}>
        <SpinningCross size={28} thickness={5} color={roles.fgPlaceholder} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.listState}>
        <Text style={[styles.listStateText, { color: '#c9453a' }]}>
          Kon je saves niet laden.
        </Text>
      </View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(180)}>
      {upcomingDays.map((day) => (
        <View key={`up-${day.id}`}>
          <DateAnchor group={day} />
          {day.events.map((e) => (
            <SavedRow key={e.id} event={e} />
          ))}
        </View>
      ))}
      {pastDays.length > 0 && (
        <>
          <PastAnchor count={past.length} />
          {pastDays.map((day) => (
            <View key={`past-${day.id}`}>
              <DateAnchor group={day} dim />
              {day.events.map((e) => (
                <SavedRow key={e.id} event={e} dim />
              ))}
            </View>
          ))}
        </>
      )}
    </Animated.View>
  );
}

// ─── Rij-componenten ────────────────────────────────────────────────

function SectionHead({
  label,
  count,
  action,
  onAction,
}: {
  label: string;
  count?: number;
  action?: string;
  onAction?: () => void;
}) {
  const roles = useRoles();
  return (
    <View style={styles.sectionHead}>
      <Text style={[styles.sectionLabel, { color: roles.fgMuted }]}>
        {label}
        {count !== undefined && (
          <Text style={[styles.sectionCount, { color: roles.fgPlaceholder }]}>
            {' · '}
            {count}
          </Text>
        )}
      </Text>
      {action && (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={[styles.sectionAction, { color: roles.accent }]}>
            {action}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function RequestRow({
  request,
  onAccept,
  onDecline,
  busy,
}: {
  request: ApiFriendRequest;
  onAccept: () => void;
  onDecline: () => void;
  busy: boolean;
}) {
  const roles = useRoles();
  return (
    <View style={[styles.row, { borderColor: roles.bgChip }]}>
      <ProfileAvatar avatarUrl={request.avatarUrl} name={request.name} size={36} />
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[styles.rowName, { color: roles.fg }]}>
          {request.name}
        </Text>
        {request.handle && (
          <Text
            numberOfLines={1}
            style={[styles.rowMeta, { color: roles.fgMuted }]}
          >
            @{request.handle}
          </Text>
        )}
      </View>
      <View style={styles.twin}>
        <Pressable
          onPress={onDecline}
          disabled={busy}
          style={[styles.twinBtn, { borderColor: roles.fgPlaceholder }]}
        >
          <Cross size={16} thickness={3.2} color={roles.fgMuted} />
        </Pressable>
        <Pressable
          onPress={onAccept}
          disabled={busy}
          style={[
            styles.twinBtn,
            { backgroundColor: roles.accent, borderColor: roles.accent },
          ]}
        >
          <Ionicons name="checkmark" size={18} color={roles.onAccent} />
        </Pressable>
      </View>
    </View>
  );
}

function InviteRow({
  invite,
  onAccept,
  onDecline,
  busy,
}: {
  invite: ApiInvite;
  onAccept: () => void;
  onDecline: () => void;
  busy: boolean;
}) {
  const roles = useRoles();
  const d = new Date(invite.occurrence.startsAt);
  const dateLabel = `${DOW_NL_MIXED[d.getDay()]} · ${formatTime(invite.occurrence.startsAt)}`;
  return (
    <Pressable
      onPress={() =>
        router.push(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          `/event/${invite.event.id}?o=${invite.occurrence.id}` as any
        )
      }
      style={[styles.row, { borderColor: roles.bgChip, alignItems: 'flex-start' }]}
    >
      <ProfileAvatar avatarUrl={invite.from.avatarUrl} name={invite.from.name} size={36} />
      <View style={styles.rowBody}>
        <Text
          numberOfLines={2}
          style={[styles.inviteLine, { color: roles.fgRead }]}
        >
          <Text style={[styles.inviteEm, { color: roles.fg }]}>
            {invite.from.name}
          </Text>
          {' vraagt je mee naar '}
          <Text style={[styles.inviteEm, { color: roles.fg }]}>
            {invite.event.title}
          </Text>
          .
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.rowMeta, { color: roles.fgMuted }]}
        >
          {dateLabel} · {invite.event.venueName}
        </Text>
        {invite.message && (
          <Text
            numberOfLines={2}
            style={[styles.inviteMessage, { color: roles.fgMuted }]}
          >
            “{invite.message}”
          </Text>
        )}
      </View>
      <View style={styles.twin}>
        <Pressable
          onPress={onDecline}
          disabled={busy}
          hitSlop={6}
          style={[styles.twinBtn, { borderColor: roles.fgPlaceholder }]}
        >
          <Cross size={16} thickness={3.2} color={roles.fgMuted} />
        </Pressable>
        <Pressable
          onPress={onAccept}
          disabled={busy}
          hitSlop={6}
          style={[
            styles.twinBtn,
            { backgroundColor: roles.accent, borderColor: roles.accent },
          ]}
        >
          <Ionicons name="checkmark" size={18} color={roles.onAccent} />
        </Pressable>
      </View>
    </Pressable>
  );
}

function FriendRow({ friend }: { friend: ApiFriend }) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={() => router.push(`/friend/${friend.id}` as never)}
      style={[styles.row, { borderColor: roles.bgChip }]}
    >
      <ProfileAvatar avatarUrl={friend.avatarUrl} name={friend.name} size={36} />
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[styles.rowName, { color: roles.fg }]}>
          {friend.name}
        </Text>
        {friend.handle && (
          <Text
            numberOfLines={1}
            style={[styles.rowMeta, { color: roles.fgMuted }]}
          >
            @{friend.handle}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function PendingRow({ user }: { user: ApiFriendRequest }) {
  const roles = useRoles();
  const removeFriend = useRemoveFriend();
  const onCancel = () => {
    const firstName = user.name.split(' ')[0] || `@${user.handle ?? ''}`;
    Alert.alert(
      'Verzoek terugtrekken?',
      `${firstName} krijgt geen melding hierover.`,
      [
        { text: 'Annuleer', style: 'cancel' },
        {
          text: 'Terugtrekken',
          style: 'destructive',
          onPress: () => removeFriend.mutate(user.id),
        },
      ]
    );
  };
  return (
    <View style={[styles.row, { borderColor: roles.bgChip }]}>
      <ProfileAvatar avatarUrl={user.avatarUrl} name={user.name} size={36} />
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[styles.rowName, { color: roles.fg }]}>
          {user.name}
        </Text>
        {user.handle && (
          <Text
            numberOfLines={1}
            style={[styles.rowMeta, { color: roles.fgMuted }]}
          >
            @{user.handle}
          </Text>
        )}
      </View>
      <View style={[styles.pendingPill, { borderColor: `${roles.fgMuted}80` }]}>
        <Text style={[styles.pendingPillText, { color: roles.fgMuted }]}>
          Wacht
        </Text>
      </View>
      <Pressable
        onPress={onCancel}
        disabled={removeFriend.isPending}
        hitSlop={6}
        style={[
          styles.twinBtn,
          {
            borderColor: roles.bgChip,
            opacity: removeFriend.isPending ? 0.5 : 1,
          },
        ]}
      >
        <Cross size={14} thickness={2.6} color={roles.fgMuted} />
      </Pressable>
    </View>
  );
}

function DateAnchor({
  group,
  dim = false,
}: {
  group: EventGroup;
  dim?: boolean;
}) {
  const roles = useRoles();
  const fg = dim ? roles.fgMuted : roles.fg;
  const meta = dim ? roles.fgPlaceholder : roles.fgMuted;
  return (
    <View style={styles.anchor}>
      <View style={styles.anchorLeft}>
        <Text style={[styles.anchorDow, { color: fg }]}>
          {group.dow} {group.num}
        </Text>
        <Text style={[styles.anchorMonth, { color: meta }]}>
          {group.month}
        </Text>
      </View>
      <Text style={[styles.anchorCount, { color: roles.fgPlaceholder }]}>
        {group.count} {group.count === 1 ? 'plan' : 'plannen'}
      </Text>
    </View>
  );
}

function PastAnchor({ count }: { count: number }) {
  const roles = useRoles();
  return (
    <View style={[styles.anchor, styles.pastAnchor]}>
      <Text style={[styles.pastLabel, { color: roles.fgMuted }]}>Geweest</Text>
      <Text style={[styles.anchorCount, { color: roles.fgPlaceholder }]}>
        {count} {count === 1 ? 'plan' : 'plannen'}
      </Text>
    </View>
  );
}

function SavedRow({ event, dim = false }: { event: ApiEvent; dim?: boolean }) {
  const tone = CATEGORY_TICK[event.category];
  const friends = event.friendsSaved?.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  return (
    <View style={dim ? styles.rowDim : undefined}>
      <EventListRow
        time={formatTime(event.startsAt)}
        thumb={event.imageUrl ?? ''}
        title={event.title}
        venue={event.venue.name}
        tags={[{ label: event.category, tone }]}
        seriesLabel={event.series?.[0]?.name}
        genreLabel={event.genres?.[0]}
        friends={friends && friends.length > 0 ? friends : undefined}
        tick={tone}
        onPress={() => router.push(`/event/${event.id}`)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1 },

  // Sub-tabs (in AppHeader children-slot)
  subTabsWrap: {
    height: SUB_TAB_HEIGHT,
    flexDirection: 'row',
    paddingHorizontal: 22,
    gap: 24,
  },
  subTab: {
    paddingTop: 10,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  subTabLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.14,
  },
  subTabBadge: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subTabBadgeText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.2,
    fontWeight: '600',
    lineHeight: 11,
  },
  subTabUnderline: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    borderRadius: 2,
  },

  // Empty / loading / error
  emptyCenter: {
    paddingHorizontal: 32,
    paddingVertical: 60,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyTitle: {
    fontFamily: fontFamily.display,
    fontSize: 22,
    letterSpacing: -0.55,
    textAlign: 'center',
  },
  emptySub: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 19,
    textAlign: 'center',
  },
  emptyCta: {
    marginTop: 12,
    paddingHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 999,
  },
  emptyCtaText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  loadingWrap: {
    paddingVertical: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listState: { paddingHorizontal: 22, paddingVertical: 14 },
  listStateText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
  },

  // Section heads
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 10,
  },
  sectionLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  sectionCount: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.4,
  },
  sectionAction: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    letterSpacing: -0.12,
  },

  // Rows (request / invite / friend / pending)
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowName: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
  },
  rowMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  inviteLine: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 19,
  },
  inviteEm: { fontFamily: fontFamily.bold },
  inviteMessage: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
    fontStyle: 'italic',
  },

  twin: { flexDirection: 'row', gap: 8 },
  twinBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingPill: {
    paddingHorizontal: 10,
    height: 22,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingPillText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },

  // Planning anchors / dim
  anchor: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 22,
    paddingTop: 14,
    paddingBottom: 6,
    gap: 10,
  },
  anchorLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  anchorDow: {
    fontFamily: fontFamily.display,
    fontSize: 22,
    letterSpacing: -0.44,
  },
  anchorMonth: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  anchorCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  pastAnchor: { marginTop: 22 },
  pastLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  rowDim: { opacity: 0.55 },
});
