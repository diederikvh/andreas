import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { router } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
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
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { RefreshBanner } from '@/components/RefreshBanner';
import type {
  ApiFriend,
  ApiFriendRequest,
  ApiGroupSummary,
  ApiInvitation,
} from '@/lib/api';
import { useSession, useIsRegistered } from '@/lib/authClient';
import {
  dowMixed,
  monthShort,
  rowTimeLabel,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import {
  useAcceptFriendRequest,
  useDeclineFriendRequest,
  useFriendRequests,
  useFriends,
  useGroups,
  useInvitations,
  useOutgoingFriendRequests,
  useRemoveFriend,
} from '@/lib/queries';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/**
 * Social-tab — bundelt alles wat met andere mensen te maken heeft:
 * openstaande friend-aanvragen + uitnodigingen bovenaan, daaronder de
 * vrienden-lijst en aangevraagde verzoeken.
 *
 * De badge op de tab in de TabBar telt openstaande aanvragen + invites
 * — zodat je vanaf elk scherm ziet dat er iets op je wacht.
 *
 * De "Planning"-lijst die vroeger als sub-tab hier woonde is verhuisd
 * naar /going (homepage-shortcut "Friends").
 */
export default function Social() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const qc = useQueryClient();

  const { data: session } = useSession();
  // Anonieme sessie telt niet: dit scherm gaat over andere mensen.
  const authed = useIsRegistered();

  const { data: requests } = useFriendRequests({ enabled: authed });
  const { data: invitations } = useInvitations({ enabled: authed });
  // Toon ALLE non-revoked invitations zolang het event nog niet voorbij
  // is (server filtert al op `endsAt > now`). Sortering: invitations
  // die nog actie van mij vragen (incoming pending) bovenaan, daarna
  // de rest op event-datum (eerstvolgende eerst). Zo zie je direct
  // waar je nog op moet reageren.
  const invites = invitations?.slice().sort((a, b) => {
    const aAction = !a.isOutgoing && a.myStatus === 'pending' ? 0 : 1;
    const bAction = !b.isOutgoing && b.myStatus === 'pending' ? 0 : 1;
    if (aAction !== bAction) return aAction - bAction;
    return (
      new Date(a.occurrence.startsAt).getTime() -
      new Date(b.occurrence.startsAt).getTime()
    );
  });
  const { data: friends } = useFriends({ enabled: authed });
  const { data: groups } = useGroups({ enabled: authed });
  const { data: outgoing } = useOutgoingFriendRequests({ enabled: authed });

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
      ]);
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) await new Promise((r) => setTimeout(r, 700 - elapsed));
      setRefreshing(false);
    }
  }, [qc]);

  const topInset = insets.top + HEADER_HEIGHT;
  const bottomInset = insets.bottom + 96;

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
      </ScrollView>
      <AppHeader title={t('Friends', 'Friends')} />
    </View>
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
      {invites && invites.length > 0 && (
        <>
          <SectionHead label={t('Uitnodigingen', 'Invitations')} />
          {invites.map((inv) => (
            <InviteRow key={inv.id} invite={inv} />
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

// ─── Rij-componenten ────────────────────────────────────────────────

/**
 * Avatar met optionele accent-dot rechtsboven — voor rijen die actie
 * van de gebruiker vragen (incoming pending invitations + binnenkomende
 * friend-requests). De dot lift visueel boven de avatar uit door
 * `borderColor` te matchen met de pagina-achtergrond.
 */
function AvatarWithDot({
  avatarUrl,
  name,
  showDot,
}: {
  avatarUrl: string | null;
  name: string;
  showDot: boolean;
}) {
  const roles = useRoles();
  return (
    <View style={{ position: 'relative' }}>
      <ProfileAvatar avatarUrl={avatarUrl} name={name} size={36} />
      {showDot && (
        <View
          style={[
            styles.actionDot,
            { backgroundColor: roles.accent, borderColor: roles.bg },
          ]}
        />
      )}
    </View>
  );
}

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
  const t = useT();
  return (
    <View
      style={[
        styles.row,
        styles.rowPending,
        {
          borderColor: roles.bgChip,
          // Zachte accent-tint over de hele rij zodat de pending-state
          // niet weg te scrollen is.
          backgroundColor: `${roles.accent}14`,
        },
      ]}
    >
      <View
        pointerEvents="none"
        style={[styles.rowAccentBar, { backgroundColor: roles.accent }]}
      />
      <AvatarWithDot
        avatarUrl={request.avatarUrl}
        name={request.name}
        showDot
      />
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[styles.rowName, { color: roles.fg }]}>
          {request.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.rowMeta, { color: roles.accent }]}
        >
          {t('Wil bevriend worden', 'Wants to connect')}
          {request.handle ? ` · @${request.handle}` : ''}
        </Text>
      </View>
      <View style={styles.twin}>
        <Pressable
          onPress={onDecline}
          disabled={busy}
          style={[styles.declineGhost, { borderColor: roles.fgPlaceholder }]}
        >
          <Cross size={14} thickness={3} color={roles.fgMuted} />
        </Pressable>
        <Pressable
          onPress={onAccept}
          disabled={busy}
          style={[
            styles.acceptCta,
            { backgroundColor: roles.accent },
            busy && { opacity: 0.5 },
          ]}
        >
          <Ionicons name="checkmark" size={16} color={roles.onAccent} />
          <Text style={[styles.acceptCtaLabel, { color: roles.onAccent }]}>
            {t('Accepteer', 'Accept')}
          </Text>
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
  const needsAction = !invite.isOutgoing && invite.myStatus === 'pending';
  return (
    <Pressable
      onPress={() =>
        router.push(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          target as any
        )
      }
      style={[
        styles.row,
        needsAction && styles.rowPending,
        {
          borderColor: roles.bgChip,
          alignItems: 'flex-start',
          backgroundColor: needsAction ? `${roles.accent}14` : 'transparent',
        },
      ]}
    >
      {needsAction && (
        <View
          pointerEvents="none"
          style={[styles.rowAccentBar, { backgroundColor: roles.accent }]}
        />
      )}
      <AvatarWithDot
        avatarUrl={invite.from.avatarUrl}
        name={invite.from.name}
        showDot={needsAction}
      />
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
      {needsAction && (
        <View style={[styles.respondCta, { backgroundColor: roles.accent }]}>
          <Text style={[styles.respondCtaLabel, { color: roles.onAccent }]}>
            {t('Reageer', 'Respond')}
          </Text>
          <Ionicons name="chevron-forward" size={14} color={roles.onAccent} />
        </View>
      )}
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

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1 },

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
  // Notification-dot rechtsboven op de avatar voor rijen die actie van
  // mij vragen (incoming pending invitation / friend-request).
  actionDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 2,
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

  twin: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  twinBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Pending state-styling die op zowel Friend-request als incoming
  // invite rows wordt toegepast. Subtiele tint + verticale accent-bar
  // links zodat de rij visueel uit de lijst springt als "nog te doen".
  rowPending: {
    position: 'relative',
    paddingLeft: 22 + 6,
  },
  rowAccentBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  // Decline: klein, ghost, geen label — secondary.
  declineGhost: {
    width: 36,
    height: 36,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Accept: gevulde accent-CTA met icoon + label — primary.
  acceptCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  acceptCtaLabel: {
    fontFamily: fontFamily.displayBold,
    fontSize: 13,
    letterSpacing: -0.2,
  },
  // Voor InviteRow: rechts-aligned mini-CTA zodat duidelijk is dat de
  // hele rij naar een actie-scherm leidt. Niet de hele actie hier
  // (accept/decline kan complex zijn — multi-occ, group) maar wel een
  // ondubbelzinnig "reageer hier" signaal.
  respondCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 30,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: 999,
    alignSelf: 'center',
  },
  respondCtaLabel: {
    fontFamily: fontFamily.displayBold,
    fontSize: 12,
    letterSpacing: -0.2,
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
