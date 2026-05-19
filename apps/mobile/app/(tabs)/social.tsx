import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
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
  ApiFeedEvent,
  ApiFriend,
  ApiFriendRequest,
  ApiGroupSummary,
  ApiInvitation,
  SavedApiEvent,
} from '@/lib/api';
import { useSession } from '@/lib/authClient';
import {
  eventImageUrl,
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  dowMixed,
  monthShort,
  type EventGroup,
  rowTimeLabel,
  groupEventsByDay,
  translateCategory,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import {
  useAcceptFriendRequest,
  useDeclineFriendRequest,
  useFriendRequests,
  useFriends,
  useGroups,
  useInvitations,
  useMySaves,
  useOutgoingFriendRequests,
  useRemoveFriend,
  useSocialFeed,
} from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

const SUB_TAB_HEIGHT = 60;

type Sub = 'vrienden' | 'feed' | 'planning';

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
  const t = useT();
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const qc = useQueryClient();

  const [sub, setSub] = useState<Sub>('vrienden');

  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);

  const { data: requests } = useFriendRequests({ enabled: authed });
  const { data: invitations } = useInvitations({ enabled: authed });
  // Toon ALLE non-revoked invitations zolang het event nog niet voorbij
  // is (server filtert al op `endsAt > now`). Pending én going én
  // andere statussen blijven dus zichtbaar — "wat gaan we samen doen"
  // is óók relevant als iedereen al ja heeft gezegd. Sortering:
  // eerstvolgende event eerst (chronologisch oplopend).
  const invites = invitations
    ?.slice()
    .sort(
      (a, b) =>
        new Date(a.occurrence.startsAt).getTime() -
        new Date(b.occurrence.startsAt).getTime()
    );
  const { data: friends } = useFriends({ enabled: authed });
  const { data: groups } = useGroups({ enabled: authed });
  const { data: outgoing } = useOutgoingFriendRequests({ enabled: authed });
  const { data: saves, isLoading: savesLoading, error: savesError } =
    useMySaves({ enabled: authed });
  const { data: feed, isLoading: feedLoading, error: feedError } =
    useSocialFeed({ enabled: authed });

  const acceptReq = useAcceptFriendRequest();
  const declineReq = useDeclineFriendRequest();

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['friend-requests'] }),
        qc.invalidateQueries({ queryKey: ['invitations'] }),
        qc.invalidateQueries({ queryKey: ['friends'] }),
        qc.invalidateQueries({ queryKey: ['groups'] }),
        qc.invalidateQueries({ queryKey: ['outgoing-friend-requests'] }),
        qc.invalidateQueries({ queryKey: ['saves'] }),
        qc.invalidateQueries({ queryKey: ['social-feed'] }),
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
        {sub === 'vrienden' && (
          <FriendsPanel
            authed={authed}
            requests={requests}
            invites={invites}
            friends={friends}
            groups={groups}
            outgoing={outgoing}
            onAcceptReq={(id) => acceptReq.mutate(id)}
            onDeclineReq={(id) => declineReq.mutate(id)}
            busyReq={acceptReq.isPending || declineReq.isPending}
          />
        )}
        {sub === 'feed' && (
          <FeedPanel
            authed={authed}
            feed={feed}
            isLoading={feedLoading}
            error={feedError}
          />
        )}
        {sub === 'planning' && (
          <PlanningPanel
            authed={authed}
            saves={saves}
            isLoading={savesLoading}
            error={savesError}
          />
        )}
      </ScrollView>
      <AppHeader title={t('Sociaal', 'Social')} showContentMode>
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
  const mode = useMode();
  const roles = useRoles();
  const t = useT();
  // Track-breedte meten zodat we de blob in pixels kunnen positioneren
  // — % laat 't 4-6px verschuiven door padding/gap-rounding.
  const [trackW, setTrackW] = useState(0);
  const activeIndex = sub === 'vrienden' ? 0 : sub === 'feed' ? 1 : 2;
  const progress = useSharedValue(activeIndex);
  useEffect(() => {
    progress.value = withTiming(activeIndex, {
      duration: 240,
      easing: Easing.bezier(0.65, 0, 0.35, 1),
    });
  }, [activeIndex, progress]);
  const blobStyle = useAnimatedStyle(() => {
    const inner = Math.max(0, trackW - 6); // padding 3 aan beide kanten
    const w = inner / 3;
    return {
      width: w,
      transform: [{ translateX: progress.value * w }],
    };
  });

  return (
    <View style={styles.subTabsAlign}>
      <View
        style={[
          styles.switchTrack,
          // Subtiele tint die matcht met de Filter-chips elders — was
          // hier eerder iets sterker, voelde donkerder dan de rest.
          { borderColor: roles.bgChip },
        ]}
        onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
      >
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
                  ? 'rgba(23,23,26,0.65)'
                  : 'rgba(235,230,216,0.7)',
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.switchBlob,
            blobStyle,
            { backgroundColor: roles.accent },
          ]}
        />
        <SwitchBtn
          label={t('Vrienden', 'Friends')}
          active={sub === 'vrienden'}
          badge={inboxCount}
          onPress={() => onChange('vrienden')}
        />
        <SwitchBtn
          label={t('Feed', 'Feed')}
          active={sub === 'feed'}
          onPress={() => onChange('feed')}
        />
        <SwitchBtn
          label={t('Planning', 'Planning')}
          active={sub === 'planning'}
          onPress={() => onChange('planning')}
        />
      </View>
    </View>
  );
}

function SwitchBtn({
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
  const tint = active ? roles.onAccent : roles.fgMuted;
  // Op actieve tab geen badge — je bent er al, dus de count is dubbelop.
  const showBadge = badge > 0 && !active;
  return (
    <Pressable onPress={onPress} style={styles.switchBtn}>
      <Text style={[styles.switchBtnText, { color: tint }]}>{label}</Text>
      {showBadge && (
        <View style={[styles.switchBadge, { backgroundColor: roles.accent }]}>
          <Text
            style={[styles.switchBadgeText, { color: roles.onAccent }]}
            numberOfLines={1}
          >
            {badge > 9 ? '9+' : badge}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

// ─── Vrienden-panel ─────────────────────────────────────────────────

function FriendsPanel({
  authed,
  requests,
  invites,
  friends,
  groups,
  outgoing,
  onAcceptReq,
  onDeclineReq,
  busyReq,
}: {
  authed: boolean;
  requests: ApiFriendRequest[] | undefined;
  invites: ApiInvitation[] | undefined;
  friends: ApiFriend[] | undefined;
  groups: ApiGroupSummary[] | undefined;
  outgoing: ApiFriendRequest[] | undefined;
  onAcceptReq: (id: string) => void;
  onDeclineReq: (id: string) => void;
  busyReq: boolean;
}) {
  const roles = useRoles();
  const t = useT();

  if (!authed) {
    return (
      <View style={styles.emptyCenter}>
        <Ionicons name="people-outline" size={48} color={roles.fgMuted} />
        <Text style={[styles.emptyTitle, { color: roles.fg }]}>
          {t('Log in om je vrienden te zien', 'Sign in to see your friends')}
        </Text>
        <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
          {t(
            'Vrienden delen wat ze hebben gepland — log in via Jij om jullie netwerk te zien.',
            'Friends share what they’ve planned — sign in via You to see your network.'
          )}
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
          {t('Nog geen vrienden', 'No friends yet')}
        </Text>
        <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
          {t(
            'Voeg iemand toe via @handle of QR-code. Hun gereeplande events komen hier terug.',
            'Add someone by @handle or QR code. Their planned events will show up here.'
          )}
        </Text>
        <Pressable
          onPress={() => router.push('/add-friend')}
          style={[styles.emptyCta, { backgroundColor: roles.accent }]}
        >
          <Text style={[styles.emptyCtaText, { color: roles.onAccent }]}>
            {t('Vriend toevoegen', 'Add friend')}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(180)}>
      {invites && invites.length > 0 && (
        <>
          <SectionHead label={t('Uitnodigingen', 'Invitations')} />
          {invites.map((inv) => (
            <InviteRow key={inv.id} invite={inv} />
          ))}
        </>
      )}
      {requests && requests.length > 0 && (
        <>
          <SectionHead label={t('Aanvragen', 'Requests')} />
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
      {(hasFriends || (groups?.length ?? 0) > 0) && (
        <>
          <SectionHead
            label={t('Vrienden', 'Friends')}
            action={t('Toevoegen', 'Add')}
            onAction={() => router.push('/add-friend')}
          />
          {/* Gecombineerde lijst, gesorteerd: groepen eerst, dan
              favorieten, dan overige vrienden. Per spec staan groep-
              en vriendrijen in dezelfde lijst zonder aparte koppen —
              groepen visueel herkenbaar aan de avatar-stack. */}
          {(groups ?? []).map((g) => (
            <GroupRow key={g.id} group={g} />
          ))}
          {(friends ?? [])
            .filter((f) => f.favorite)
            .map((f) => (
              <FriendRow key={f.id} friend={f} />
            ))}
          {(friends ?? [])
            .filter((f) => !f.favorite)
            .map((f) => (
              <FriendRow key={f.id} friend={f} />
            ))}
        </>
      )}
      {hasOutgoing && (
        <>
          <SectionHead label={t('Aangevraagd', 'Pending')} />
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
  saves: SavedApiEvent[] | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  const roles = useRoles();
  const t = useT();

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
          {t('Nog niks opgeslagen.', 'Nothing saved yet.')}
        </Text>
        <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
          {t(
            'Hier komt je planning te staan — alle feestjes, voorstellingen en tentoonstellingen waar je naartoe wil. Tik bij een event op het hartje om hem op te slaan.',
            'This is where your plans live — all the parties, performances and exhibitions you want to go to. Tap the heart on an event to save it.'
          )}
        </Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.loadingWrap}>
        <SpinningCross size={28} color={roles.fgPlaceholder} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.listState}>
        <Text style={[styles.listStateText, { color: '#c9453a' }]}>
          {t('Kon je saves niet laden.', 'Couldn’t load your saves.')}
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
  action,
  onAction,
}: {
  label: string;
  action?: string;
  onAction?: () => void;
}) {
  const roles = useRoles();
  return (
    <View style={styles.sectionHead}>
      <Text style={[styles.sectionLabel, { color: roles.fg }]}>
        {label}
      </Text>
      {action && (
        <Pressable
          onPress={onAction}
          accessibilityLabel={action}
          hitSlop={8}
          style={[
            styles.sectionActionBtn,
            { backgroundColor: roles.accent },
          ]}
        >
          <Ionicons name="add" size={20} color={roles.onAccent} />
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

function InviteRow({ invite }: { invite: ApiInvitation }) {
  const roles = useRoles();
  const t = useT();
  const locale = useLocale();
  const d = new Date(invite.occurrence.startsAt);
  const dow = dowMixed(d.getDay(), locale);
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  const time = rowTimeLabel(
    invite.occurrence.startsAt,
    invite.occurrence.endsAt,
    locale
  );
  const dateLabel = `${dow} ${d.getDate()} ${month} · ${time}`;
  const others = invite.responses.filter((r) => r.user.id !== invite.from.id);
  const goingCount = others.filter((r) => r.status === 'going').length;
  const maybeCount = others.filter((r) => r.status === 'maybe').length;
  const pendingCount = others.filter((r) => r.status === 'pending').length;
  const isGroup = Boolean(invite.group);

  // Pill-prioriteit:
  //   iedereen-going → "Iedereen gaat (N)" (primair — feel-good)
  //   outgoing + pending → "Wacht op N" (primair — vraagt actie)
  //   incoming group + counts → "3 gaan · 1 misschien" (neutraal info)
  //   anders → geen pill
  const totalGoing = invite.responses.filter(
    (r) => r.status === 'going'
  ).length;
  const totalCount = invite.responses.length;
  const everyoneGoing = totalCount > 1 && totalGoing === totalCount;
  let pillText: string | null = null;
  let pillPrimary = false;
  if (everyoneGoing) {
    pillText = t(
      `Iedereen gaat (${totalGoing})`,
      `Everyone going (${totalGoing})`
    );
    pillPrimary = true;
  } else if (invite.isOutgoing && pendingCount > 0) {
    pillText = t(`Wacht op ${pendingCount}`, `Awaiting ${pendingCount}`);
    pillPrimary = true;
  } else if (isGroup && (goingCount > 0 || maybeCount > 0)) {
    const parts: string[] = [];
    if (goingCount > 0) parts.push(t(`${goingCount} gaan`, `${goingCount} going`));
    if (maybeCount > 0)
      parts.push(t(`${maybeCount} misschien`, `${maybeCount} maybe`));
    pillText = parts.join(' · ');
  }

  // Groep-invites en eigen verstuurde invites tonen veel meer detail
  // (alle responses per status, herinner-knop, intrekken) — die routen
  // naar het detail-overzicht. 1-op-1 inkomende invites zijn simpel
  // (twee mensen, accept/decline) — die gaan direct naar het event.
  const target =
    isGroup || invite.isOutgoing
      ? `/invitation/${invite.id}`
      : `/event/${invite.event.id}?o=${invite.occurrence.id}`;
  return (
    <Pressable
      onPress={() =>
        router.push(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          target as any
        )
      }
      style={[styles.row, { borderColor: roles.bgChip, alignItems: 'flex-start' }]}
    >
      <ProfileAvatar avatarUrl={invite.from.avatarUrl} name={invite.from.name} size={36} />
      <View style={styles.rowBody}>
        <Text
          numberOfLines={1}
          style={[styles.inviteKicker, { color: roles.fg }]}
        >
          {dateLabel} · {invite.event.venueName}
        </Text>
        <Text
          numberOfLines={2}
          style={[styles.inviteTitle, { color: roles.fgRead }]}
        >
          {invite.isOutgoing ? (
            <>
              <Text style={[styles.inviteEm, { color: roles.fg }]}>
                {t('Jij', 'You')}
              </Text>
              {isGroup ? (
                <>
                  {t(' nodigt ', ' invited ')}
                  <Text style={[styles.inviteEm, { color: roles.fg }]}>
                    {invite.group?.name}
                  </Text>
                  {t(' uit voor ', ' to ')}
                </>
              ) : others.length === 1 ? (
                <>
                  {t(' nodigt ', ' invited ')}
                  <Text style={[styles.inviteEm, { color: roles.fg }]}>
                    {others[0]?.user.name ?? ''}
                  </Text>
                  {t(' uit voor ', ' to ')}
                </>
              ) : (
                t(' nodigt iemand uit voor ', ' invited someone to ')
              )}
              <Text style={[styles.inviteEm, { color: roles.fg }]}>
                {invite.event.title}
              </Text>
              .
            </>
          ) : (
            <>
              <Text style={[styles.inviteEm, { color: roles.fg }]}>
                {invite.from.name}
              </Text>
              {isGroup ? (
                <>
                  {t(' nodigt ', ' is inviting ')}
                  <Text style={[styles.inviteEm, { color: roles.fg }]}>
                    {invite.group?.name}
                  </Text>
                  {t(' uit voor ', ' to ')}
                </>
              ) : (
                t(' vraagt je mee naar ', ' is inviting you to ')
              )}
              <Text style={[styles.inviteEm, { color: roles.fg }]}>
                {invite.event.title}
              </Text>
              .
            </>
          )}
        </Text>
        {pillText && (
          <View
            style={[
              styles.invitePill,
              pillPrimary
                ? { backgroundColor: `${roles.accent}26` }
                : { backgroundColor: roles.bgTag },
            ]}
          >
            <Text
              style={[
                styles.invitePillText,
                { color: pillPrimary ? roles.accent : roles.fgMuted },
              ]}
            >
              {pillText}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

function GroupRow({ group }: { group: ApiGroupSummary }) {
  const roles = useRoles();
  const t = useT();
  const memberCount = group.members.length;
  // Compactere stack: 28px tiles met 14px offset zodat 3 tiles in
  // exact 56px breed passen — gelijk aan de friend-row avatar-cell,
  // waardoor namen op één verticale lijn beginnen.
  const visible = group.members.slice(0, 3);
  const overflow = Math.max(0, memberCount - visible.length);
  const totalTiles = visible.length + (overflow > 0 ? 1 : 0);
  return (
    <Pressable
      onPress={() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.push(`/group/${group.id}` as any)
      }
      style={[styles.row, { borderColor: roles.bgChip }]}
    >
      <View style={styles.avatarSlot}>
        {visible.map((m, i) => (
          <View
            key={m.id}
            style={[
              styles.groupStackTile,
              {
                // Rechts-aligned binnen de 56px-slot zodat de laatste
                // tile altijd op dezelfde X eindigt (en de naam dus
                // op één lijn met de friend-row begint).
                left: i * 14,
                zIndex: totalTiles - i,
                borderColor: roles.bg,
              },
            ]}
          >
            <ProfileAvatar avatarUrl={m.avatarUrl} name={m.name} size={28} />
          </View>
        ))}
        {overflow > 0 && (
          <View
            style={[
              styles.groupStackTile,
              styles.groupStackOverflow,
              {
                left: visible.length * 14,
                borderColor: roles.bg,
                backgroundColor: roles.bgChip,
              },
            ]}
          >
            <Text style={[styles.groupStackOverflowText, { color: roles.fgMuted }]}>
              +{overflow}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowNameLine}>
          <Text
            numberOfLines={1}
            style={[styles.rowName, { color: roles.fg }]}
          >
            {group.name}
          </Text>
          {group.muted ? (
            <Ionicons
              name="notifications-off-outline"
              size={13}
              color={roles.fgMuted}
            />
          ) : null}
        </View>
        <Text
          numberOfLines={1}
          style={[styles.rowMeta, { color: roles.fgMuted }]}
        >
          {memberCount === 1
            ? t('1 lid', '1 member')
            : t(`${memberCount} leden`, `${memberCount} members`)}
        </Text>
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
      <View style={styles.avatarSlot}>
        <ProfileAvatar avatarUrl={friend.avatarUrl} name={friend.name} size={36} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowNameLine}>
          <Text
            numberOfLines={1}
            style={[styles.rowName, { color: roles.fg }]}
          >
            {friend.name}
          </Text>
          {friend.favorite ? (
            <Ionicons name="star" size={13} color={roles.accent} />
          ) : null}
        </View>
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
  const t = useT();
  const removeFriend = useRemoveFriend();
  const onCancel = () => {
    const firstName = user.name.split(' ')[0] || `@${user.handle ?? ''}`;
    Alert.alert(
      t('Verzoek terugtrekken?', 'Withdraw request?'),
      t(
        `${firstName} krijgt geen melding hierover.`,
        `${firstName} won’t be notified.`
      ),
      [
        { text: t('Annuleer', 'Cancel'), style: 'cancel' },
        {
          text: t('Terugtrekken', 'Withdraw'),
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
          {t('Wacht', 'Pending')}
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
  const t = useT();
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
        {group.count}{' '}
        {group.count === 1 ? t('plan', 'plan') : t('plannen', 'plans')}
      </Text>
    </View>
  );
}

function PastAnchor({ count }: { count: number }) {
  const roles = useRoles();
  const t = useT();
  return (
    <View style={[styles.anchor, styles.pastAnchor]}>
      <Text style={[styles.pastLabel, { color: roles.fgMuted }]}>
        {t('Geweest', 'Past')}
      </Text>
      <Text style={[styles.anchorCount, { color: roles.fgPlaceholder }]}>
        {count} {count === 1 ? t('plan', 'plan') : t('plannen', 'plans')}
      </Text>
    </View>
  );
}

function SavedRow({ event, dim = false }: { event: ApiEvent; dim?: boolean }) {
  const tone = CATEGORY_TICK[event.category];
  const locale = useLocale();
  const friends = event.friendsSaved?.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  return (
    <View style={dim ? styles.rowDim : undefined}>
      <EventListRow
        time={rowTimeLabel(event.startsAt, event.endsAt, locale)}
        thumb={eventImageUrl(event) ?? ''}
        title={event.title}
        venue={event.venue.name}
        tags={[{ label: translateCategory(event.category, locale), tone }]}
        seriesLabel={event.series?.[0]?.name}
        genreLabel={event.genres?.[0]}
        friends={friends && friends.length > 0 ? friends : undefined}
        tick={tone}
        onPress={() => router.push(`/event/${event.id}?source=friend`)}
      />
    </View>
  );
}

/**
 * Compacte "X geleden"-label voor de feed-rij — past in de
 * geroteerde tijd-kolom (max ~4 chars). "net" = < 5 min, "Xu" =
 * binnen 24u, "Xd" = binnen 30 dagen, "Xw" daarna.
 */
function relativeAgo(iso: string, locale: 'nl' | 'en'): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 5 * 60_000) return locale === 'nl' ? 'net' : 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return locale === 'nl' ? `${hours}u` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return locale === 'nl' ? `${weeks}w` : `${weeks}w`;
}

function FeedRow({ entry }: { entry: ApiFeedEvent }) {
  const locale = useLocale();
  const friends = entry.friendsSaved.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  const venueType = entry.venue.type;
  const venueTone = venueType ? VENUE_TYPE_TICK[venueType] : undefined;
  const tone = CATEGORY_TICK[entry.category];
  return (
    <EventListRow
      thumb={eventImageUrl({
        imageUrl: entry.imageUrl,
        venue: { imageUrl: entry.venue.imageUrl ?? null },
      }) ?? ''}
      title={entry.title}
      venue={entry.venue.name}
      venueTone={venueTone}
      time={relativeAgo(entry.lastSavedAt, locale)}
      tags={[{ label: translateCategory(entry.category, locale), tone }]}
      seriesLabel={undefined}
      genreLabel={entry.genres[0]}
      friends={friends.length > 0 ? friends : undefined}
      tick={tone}
      onPress={() => router.push(`/event/${entry.eventId}?source=friend`)}
    />
  );
}

function FeedPanel({
  authed,
  feed,
  isLoading,
  error,
}: {
  authed: boolean;
  feed: ApiFeedEvent[] | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  const roles = useRoles();
  const t = useT();

  const noFeed =
    (!authed && !isLoading) ||
    (authed && !isLoading && !error && (feed?.length ?? 0) === 0);

  if (noFeed) {
    return (
      <View style={styles.emptyCenter}>
        <Ionicons name="people-outline" size={48} color={roles.fgMuted} />
        <Text style={[styles.emptyTitle, { color: roles.fg }]}>
          {t('Nog geen activiteit.', 'No activity yet.')}
        </Text>
        <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
          {t(
            'Hier zie je wat je vrienden hebben gered — geen algoritme, geen aanbevelingen, alleen de events waar zij naartoe gaan.',
            'See what your friends are saving — no algorithm, no recommendations, just the events they’re going to.'
          )}
        </Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.loadingWrap}>
        <SpinningCross size={28} color={roles.fgPlaceholder} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.listState}>
        <Text style={[styles.listStateText, { color: '#c9453a' }]}>
          {t('Kon de feed niet laden.', 'Couldn’t load the feed.')}
        </Text>
      </View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(180)}>
      {feed!.map((e) => (
        <FeedRow key={e.eventId} entry={e} />
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1 },

  // Sub-tabs — pill-switch met blur, zelfde stijl als de Map/List-
  // switch op de Kaart-tab. Gecentreerd in de header-children-slot.
  subTabsAlign: {
    height: SUB_TAB_HEIGHT,
    paddingTop: 4,
    paddingBottom: 4,
    paddingHorizontal: 22,
    alignItems: 'center',
  },
  switchTrack: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
    // Vol-breed binnen subTabsAlign's horizontale padding zodat de
    // Nederlandse labels (Vrienden / Planning) niet inklemmen op
    // smallere telefoons.
    alignSelf: 'stretch',
  },
  switchBlob: {
    position: 'absolute',
    top: 3,
    left: 3,
    bottom: 3,
    borderRadius: 999,
  },
  switchBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  switchBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    // Vaste lineHeight (= badge-hoogte) zorgt dat de pill-hoogte
    // niet verspringt wanneer de badge er wel/niet bij staat.
    lineHeight: 20,
    letterSpacing: -0.06,
  },
  switchBadge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchBadgeText: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: -0.1,
    lineHeight: 13,
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
  // Display-style heading — zelfde behandeling als Rail-kickers op
  // de Vandaag-pagina ("Vannacht in de clubs" enz.). Maakt de "+"
  // ernaast ook direct als CTA leesbaar.
  sectionLabel: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
  },
  // Ronde primaire knop (bv. "+") in een section-header. Accent-bg
  // zodat 'm direct als CTA leest tegen de muted-section-labels.
  sectionActionBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
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
  rowNameLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowName: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
    flexShrink: 1,
  },
  rowMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  // Gedeelde avatar-cell voor zowel FriendRow als GroupRow. 56px breed
  // accommodeert een stack van 3× 28px tiles met 14px offset, én laat
  // de single 36px friend-avatar links uitlijnen — beide rows starten
  // hun naam dus op exact dezelfde X.
  avatarSlot: {
    width: 56,
    height: 36,
    position: 'relative',
    justifyContent: 'center',
  },
  groupStackTile: {
    position: 'absolute',
    top: 4,
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: 2,
    padding: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  groupStackOverflow: {
    paddingHorizontal: 4,
    overflow: 'hidden',
  },
  groupStackOverflowText: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: -0.1,
  },
  // Kicker bovenaan invite-rij (datum + venue) — kleiner dan de titel
  // maar wel bold zodat 't direct opvalt als context-info.
  inviteKicker: {
    fontFamily: fontFamily.bold,
    fontSize: 11.5,
    letterSpacing: -0.05,
    marginBottom: 4,
  },
  // De main-zin onder de kicker — body-tekst met inline `inviteEm`-spans
  // voor namen.
  inviteTitle: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 19,
  },
  inviteEm: { fontFamily: fontFamily.bold },
  // Zelfde label-stijl als de tags op EventListRow: gevuld pill,
  // geen border, mono-uppercase tekst.
  invitePill: {
    alignSelf: 'flex-start',
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
  },
  invitePillText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },

  twin: { flexDirection: 'row', gap: 8 },
  twinBtn: {
    width: 44,
    height: 44,
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
