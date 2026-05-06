import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import { BackButton } from '@/components/BackButton';
import { Cross } from '@/components/Cross';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiFriendRequest, ApiInvite } from '@/lib/api';
import { DOW_NL_MIXED, formatTime } from '@/lib/eventDisplay';
import {
  useAcceptFriendRequest,
  useAcceptInvite,
  useDeclineFriendRequest,
  useDeclineInvite,
  useFriendRequests,
  useInvites,
} from '@/lib/queries';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/**
 * Inbox — alle openstaande verzoeken en uitnodigingen op één plek.
 * Wordt bereikt via de bel rechtsboven in de AppHeader. Drag-to-refresh
 * en push-driven invalidation houden 'm vers.
 */
export default function Inbox() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();

  const { data: requests, isLoading: loadingReq } = useFriendRequests();
  const { data: invites, isLoading: loadingInv } = useInvites();
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
      ]);
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) await new Promise((r) => setTimeout(r, 700 - elapsed));
      setRefreshing(false);
    }
  }, [qc]);

  const isLoading = loadingReq || loadingInv;
  const totalCount = (requests?.length ?? 0) + (invites?.length ?? 0);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BackButton />
        <Text style={[styles.title, { color: roles.fg }]}>Inbox</Text>
        <View style={styles.topRight} />
      </View>

      <RefreshBanner visible={refreshing} topOffset={insets.top + 56} />

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={roles.accent}
            colors={[roles.accent]}
          />
        }
      >
        {isLoading ? (
          <View style={styles.loadingWrap}>
            <SpinningCross size={28} thickness={5} color={roles.fgPlaceholder} />
          </View>
        ) : totalCount === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={[styles.emptyTitle, { color: roles.fg }]}>
              Niets openstaand
            </Text>
            <Text style={[styles.emptyBody, { color: roles.fgMuted }]}>
              Hier verschijnen vriend-aanvragen en uitnodigingen die op je
              wachten. Trek omlaag om te verversen.
            </Text>
          </View>
        ) : (
          <>
            {invites && invites.length > 0 && (
              <>
                <SectionHead label="Uitnodigingen" count={invites.length} />
                {invites.map((inv) => (
                  <InviteRow
                    key={inv.id}
                    invite={inv}
                    onAccept={() => acceptInv.mutate(inv.id)}
                    onDecline={() => declineInv.mutate(inv.id)}
                    busy={acceptInv.isPending || declineInv.isPending}
                  />
                ))}
              </>
            )}
            {requests && requests.length > 0 && (
              <>
                <SectionHead label="Verzoeken" count={requests.length} />
                {requests.map((r) => (
                  <RequestRow
                    key={r.id}
                    request={r}
                    onAccept={() => acceptReq.mutate(r.id)}
                    onDecline={() => declineReq.mutate(r.id)}
                    busy={acceptReq.isPending || declineReq.isPending}
                  />
                ))}
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function SectionHead({ label, count }: { label: string; count: number }) {
  const roles = useRoles();
  return (
    <View style={styles.sectionHead}>
      <Text style={[styles.sectionLabel, { color: roles.fgMuted }]}>
        {label}
        <Text style={[styles.sectionCount, { color: roles.fgPlaceholder }]}>
          {' · '}
          {count}
        </Text>
      </Text>
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
          <Text style={[styles.inviteName, { color: roles.fg }]}>
            {invite.from.name}
          </Text>
          {' vraagt je mee naar '}
          <Text style={[styles.inviteEvent, { color: roles.fg }]}>
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

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 8,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 20,
    letterSpacing: -0.4,
  },
  topRight: { width: 40 },

  loadingWrap: {
    paddingVertical: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyWrap: {
    paddingHorizontal: 22,
    paddingTop: 60,
    paddingBottom: 32,
    gap: 8,
  },
  emptyTitle: {
    fontFamily: fontFamily.display,
    fontSize: 22,
    letterSpacing: -0.5,
  },
  emptyBody: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
  },

  sectionHead: {
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
  inviteName: { fontFamily: fontFamily.bold },
  inviteEvent: { fontFamily: fontFamily.bold },
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
});
