import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { router } from 'expo-router';
import { useMemo, useRef } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import type { ApiEvent } from '@/lib/api';
import { useSession } from '@/lib/authClient';
import {
  CATEGORY_TICK,
  type EventGroup,
  formatTime,
  groupEventsByDay,
} from '@/lib/eventDisplay';
import { useMySaves } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export default function Gered() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
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

  if (!authed) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        <View
          style={[
            styles.emptyBody,
            { paddingTop: topInset + 24, paddingBottom: bottomInset },
          ]}
        >
          <Text style={[styles.kicker, { color: roles.accent }]}>Gered</Text>
          <Text style={[styles.headTitle, { color: roles.fg }]}>Op uit.</Text>
          <Text style={[styles.lead, { color: roles.fgRead }]}>
            Tik op het hart bij een event om hem hier op te slaan. Inloggen
            doe je via de Jij-tab.
          </Text>
          <Pressable
            onPress={() => router.push('/jij')}
            style={[
              styles.cta,
              { backgroundColor: isNacht ? palette.acid : palette.red },
            ]}
          >
            <Text
              style={[
                styles.ctaText,
                { color: isNacht ? palette.noir : palette.paper3 },
              ]}
            >
              Naar inloggen
            </Text>
          </Pressable>
        </View>
        <AppHeader />
      </View>
    );
  }

  if (!isLoading && !error && saves && saves.length === 0) {
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
            Tik op een hart bij een event om hem hier op te slaan.
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
            Zin in
          </Text>
          <Text style={[styles.headTitle, { color: roles.fg }]}>Op uit.</Text>
        </View>

        {isLoading && <ListState text="Laden…" />}
        {error && <ListState text="Kon je saves niet laden." tone="error" />}

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
  return (
    <View style={dim ? styles.rowDim : undefined}>
      <EventListRow
        time={formatTime(event.startsAt)}
        duration={event.category.toLowerCase()}
        thumb={event.imageUrl ?? ''}
        title={event.title}
        venue={event.venue.name}
        tags={[{ label: event.category, tone }]}
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
    fontSize: 13,
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
    fontSize: 13,
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
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },

  listState: { paddingHorizontal: 22, paddingVertical: 14 },
  listStateText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
  },
});
