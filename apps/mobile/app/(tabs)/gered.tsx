import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { router } from 'expo-router';
import { useMemo, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent } from '@/lib/api';
import { useSession } from '@/lib/authClient';
import {
  CATEGORY_TICK,
  type EventGroup,
  formatTime,
  groupEventsByDay,
} from '@/lib/eventDisplay';
import { useMySaves } from '@/lib/queries';
import { useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export default function Gered() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const { data: saves, isLoading, error } = useMySaves({ enabled: authed });

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

  const topInset = insets.top + HEADER_HEIGHT;
  const bottomInset = insets.bottom + 96;

  // Eén empty-state voor twee situaties: niet-ingelogd én ingelogd
  // zonder saves. De inlog-prompt staat niet meer voorop — pas wanneer
  // je op een hartje tikt kom je vanzelf bij de Jij-tab terecht. Dat
  // voelt minder confronterend dan een schermvullende inlog-CTA voordat
  // je überhaupt iets hebt geprobeerd.
  const hasNoSaves =
    (!authed && !isLoading) ||
    (authed && !isLoading && !error && (saves?.length ?? 0) === 0);

  if (hasNoSaves) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        <View
          style={[
            styles.emptyCenter,
            { paddingTop: topInset, paddingBottom: bottomInset },
          ]}
        >
          <Ionicons
            name="heart-outline"
            size={48}
            color={roles.fgMuted}
          />
          <Text style={[styles.emptyTitle, { color: roles.fg }]}>
            Nog niks opgeslagen.
          </Text>
          <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
            Hier komt je planning te staan — alle feestjes, voorstellingen
            en tentoonstellingen waar je naartoe wil. Tik bij een event
            op het hartje om hem op te slaan.
          </Text>
        </View>
        <AppHeader />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        ref={scrollRef}
        style={styles.page}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: topInset,
          paddingBottom: bottomInset,
        }}
      >
        <View style={styles.head}>
          <Text style={[styles.headKicker, { color: roles.accent }]}>
            Planning
          </Text>
          <Text style={[styles.headTitle, { color: roles.fg }]}>
            Wat je gaat doen.
          </Text>
        </View>

        {isLoading && (
          <View style={styles.loadingWrap}>
            <SpinningCross size={28} thickness={5} color={roles.fgPlaceholder} />
          </View>
        )}
        {error && <ListState text="Kon je saves niet laden." tone="error" />}

        {!isLoading && !error && (
          <Animated.View entering={FadeIn.duration(220)}>
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
        )}
      </ScrollView>
      <AppHeader />
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

function SavedRow({
  event,
  dim = false,
}: {
  event: ApiEvent;
  dim?: boolean;
}) {
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

function ListState({
  text,
  tone = 'muted',
}: {
  text: string;
  tone?: 'muted' | 'error';
}) {
  const roles = useRoles();
  return (
    <View style={styles.listState}>
      <Text
        style={[
          styles.listStateText,
          { color: tone === 'error' ? '#c9453a' : roles.fgMuted },
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1 },

  emptyBody: {
    flex: 1,
    paddingHorizontal: 22,
    gap: 14,
  },
  kicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  lead: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 19,
    marginBottom: 4,
  },
  cta: {
    alignSelf: 'flex-start',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
  },
  ctaText: {
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.07,
  },

  head: {
    paddingHorizontal: 22,
    paddingTop: 4,
    paddingBottom: 12,
  },
  headKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  headTitle: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    letterSpacing: -0.9,
    lineHeight: 30,
    marginTop: 6,
  },

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

  // Centered empty state — heart icon + title + sub
  emptyCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
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

  listState: { paddingHorizontal: 22, paddingVertical: 14 },
  loadingWrap: {
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listStateText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
  },
});
