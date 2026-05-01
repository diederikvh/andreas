import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackButton } from '@/components/BackButton';
import { EventListRow } from '@/components/EventListRow';
import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  type EventGroup,
  formatTime,
  groupEventsByDay,
} from '@/lib/eventDisplay';
import { useFriend, useRemoveFriend } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export default function FriendDetail() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ?? '';
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';

  const { data, isLoading, error } = useFriend(id);
  const removeFriend = useRemoveFriend();

  const onUnfollow = () => {
    if (!data) return;
    const name = data.user.name || (data.user.handle ? `@${data.user.handle}` : 'deze vriend');
    Alert.alert(
      'Ontvolgen',
      `${name} verwijderen uit je vrienden?`,
      [
        { text: 'Annuleren', style: 'cancel' },
        {
          text: 'Ontvolgen',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeFriend.mutateAsync(id);
              router.back();
            } catch {
              Alert.alert('Mislukt', 'Kon niet ontvolgen — probeer opnieuw.');
            }
          },
        },
      ]
    );
  };

  if (isLoading) {
    return (
      <View
        style={[
          styles.root,
          styles.center,
          { backgroundColor: roles.bg, paddingTop: insets.top + 32 },
        ]}
      >
        <ActivityIndicator color={roles.fgMuted} />
      </View>
    );
  }
  if (error || !data) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
          <BackButton />
        </View>
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: '#c9453a' }]}>
            Profiel niet beschikbaar.
          </Text>
        </View>
      </View>
    );
  }

  const { user, events } = data;
  const upcoming = events.filter(
    (e) => new Date(e.endsAt ?? e.startsAt).getTime() >= Date.now()
  );
  const upcomingDays: EventGroup[] = groupEventsByDay(upcoming);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + 32,
        }}
      >
        <View style={styles.topBar}>
          <BackButton />
        </View>

        <View style={styles.head}>
          {user.avatarUrl ? (
            <Image
              source={{ uri: user.avatarUrl }}
              style={[styles.avatar, { borderColor: roles.bgChip }]}
              contentFit="cover"
            />
          ) : (
            <View
              style={[
                styles.avatar,
                styles.avatarFallback,
                {
                  borderColor: roles.bgChip,
                  backgroundColor: isNacht ? palette.noir2 : palette.paper2,
                },
              ]}
            >
              <Text style={[styles.avatarInitial, { color: roles.fgMuted }]}>
                {(user.name.trim()[0] ?? '?').toUpperCase()}
              </Text>
            </View>
          )}
          <Text style={[styles.name, { color: roles.fg }]}>{user.name}</Text>
          {user.handle && (
            <Text style={[styles.handle, { color: roles.fgMuted }]}>
              @{user.handle}
            </Text>
          )}
          <Pressable
            onPress={onUnfollow}
            disabled={removeFriend.isPending}
            style={[
              styles.unfollowBtn,
              {
                borderColor: roles.fgMuted,
                opacity: removeFriend.isPending ? 0.5 : 1,
              },
            ]}
          >
            <Text style={[styles.unfollowText, { color: roles.fgMuted }]}>
              {removeFriend.isPending ? 'Bezig…' : 'Ontvolgen'}
            </Text>
          </Pressable>
        </View>

        {upcomingDays.length === 0 && (
          <Text style={[styles.empty, { color: roles.fgMuted }]}>
            Niks aankomends opgeslagen.
          </Text>
        )}
        {upcomingDays.map((day) => (
          <View key={`up-${day.id}`}>
            <DateAnchor group={day} />
            {day.events.map((e) => (
              <FriendSavedRow key={e.id} event={e} />
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function DateAnchor({ group }: { group: EventGroup }) {
  const roles = useRoles();
  return (
    <View style={styles.anchor}>
      <View style={styles.anchorLeft}>
        <Text style={[styles.anchorDow, { color: roles.fg }]}>
          {group.dow} {group.num}
        </Text>
        <Text style={[styles.anchorMonth, { color: roles.fgMuted }]}>
          {group.month}
        </Text>
      </View>
    </View>
  );
}

function FriendSavedRow({ event }: { event: ApiEvent }) {
  return (
    <EventListRow
      time={formatTime(event.startsAt)}
      duration={event.category.toLowerCase()}
      thumb={event.imageUrl ?? ''}
      title={event.title}
      venue={event.venue.name}
      tags={[{ label: event.category, tone: CATEGORY_TICK[event.category] }]}
      tick={CATEGORY_TICK[event.category]}
      onPress={() => router.push(`/event/${event.id}`)}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.5,
  },

  topBar: {
    paddingHorizontal: 18,
    paddingBottom: 8,
  },

  head: {
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingTop: 8,
    paddingBottom: 24,
    gap: 8,
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 999,
    borderWidth: 2,
  },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: {
    fontFamily: fontFamily.display,
    fontSize: 40,
    letterSpacing: -1,
  },
  name: {
    fontFamily: fontFamily.display,
    fontSize: 26,
    letterSpacing: -0.65,
    lineHeight: 26 * 1.02,
    marginTop: 4,
    textAlign: 'center',
  },
  handle: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  unfollowBtn: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  unfollowText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },

  empty: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },

  anchor: {
    flexDirection: 'row',
    paddingHorizontal: 22,
    paddingTop: 14,
    paddingBottom: 6,
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
});
