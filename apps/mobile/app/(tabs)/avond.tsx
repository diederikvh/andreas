import { useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useMemo, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  DOW_NL_UPPER,
  formatTime,
} from '@/lib/eventDisplay';
import { useEvents } from '@/lib/queries';
import type { PhotoCard } from '@/mocks/feed';
import { FEED } from '@/mocks/feed';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

function formatMeta(event: ApiEvent): string {
  const d = new Date(event.startsAt);
  const dow = DOW_NL_UPPER[d.getDay()];
  const price =
    event.priceCents == null
      ? null
      : event.priceCents === 0
        ? 'gratis'
        : `€${(event.priceCents / 100).toFixed(0)}`;
  return [dow, formatTime(event.startsAt), event.venue.name.toUpperCase(), price]
    .filter(Boolean)
    .join(' · ');
}

// Avond toont een gecureerde subset: featured-events binnen de
// komende 3 dagen vanaf vandaag (lokale dag-grens, geen "nu" zodat
// nacht- en dag-modus ook 's morgens nog vanavond's items tonen).
const HOME_WINDOW_DAYS = 3;

/** Vanaf welk uur een event als "avond" geldt (anders: "overdag"). */
const NACHT_HOUR_THRESHOLD = 17;

function homeWindow(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + HOME_WINDOW_DAYS);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function Avond() {
  const roles = useRoles();
  const mode = useMode();
  const insets = useSafeAreaInsets();
  const data = FEED[mode];
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  const window = useMemo(() => homeWindow(), []);
  // Editorial-pick events in de komende 3 dagen — Avond is altijd de
  // gecureerde view, niet alle data uit de DB.
  const { data: events, isLoading, error } = useEvents({
    featured: true,
    from: window.from,
    to: window.to,
  });
  // Splits op tijd-van-dag: nacht-mode toont avond-events (>= 17:00),
  // dag-mode toont overdag-events (< 17:00).
  const filtered = useMemo(() => {
    if (!events) return [];
    return events.filter((e) => {
      const hour = new Date(e.startsAt).getHours();
      return mode === 'nacht'
        ? hour >= NACHT_HOUR_THRESHOLD
        : hour < NACHT_HOUR_THRESHOLD;
    });
  }, [events, mode]);
  const lead = filtered[0];
  const rest = filtered.slice(1);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT,
          paddingBottom: insets.bottom + 96,
        }}
      >
        <View style={styles.hero}>
          <Text style={[styles.heroKicker, { color: roles.accent }]}>
            {data.hero.kicker}
          </Text>
          <Text style={[styles.heroTitle, { color: roles.fg }]}>
            {data.hero.titleBefore}
            <Text style={[styles.heroEm, { color: roles.accent }]}>
              {data.hero.titleEm}
            </Text>
            {data.hero.titleAfter}
          </Text>
        </View>

        {/* Hoofd-artikel: eerste featured event als grote kaart bovenaan.
            Tot we een dedicated lead-flag hebben pakken we de eerstvolgende
            featured-pick. */}
        {lead && (
          <Pressable onPress={() => router.push(`/event/${lead.id}`)}>
            <FeaturedCard
              kicker={data.featured.kicker}
              title={lead.title}
              meta={formatMeta(lead)}
              photo={lead.imageUrl ?? data.featured.photo}
            />
          </Pressable>
        )}

        <SectionTitle
          title="Redactiekeuze"
          meta={
            rest.length > 0 ? `${rest.length} meer` : data.smallRooms.sectionMeta
          }
        />
        {isLoading && <ListState text="Laden…" />}
        {error && (
          <ListState text="Kon redactiekeuze niet laden." tone="error" />
        )}
        {!isLoading && !error && filtered.length === 0 && events && (
          <ListState
            text={
              mode === 'nacht'
                ? 'Niets aanbevolen voor de komende avonden.'
                : 'Niets aanbevolen voor overdag de komende dagen.'
            }
          />
        )}
        {rest.map((e) => <ApiEventRow key={e.id} event={e} />)}

        <View style={{ height: 28 }} />
        <SectionTitle
          title={data.photoBand.sectionTitle}
          meta={data.photoBand.sectionMeta}
        />
        <PhotoBand cards={data.photoBand.cards} />
      </ScrollView>
      <AppHeader />
    </View>
  );
}

function ApiEventRow({ event }: { event: ApiEvent }) {
  return (
    <EventListRow
      thumb={event.imageUrl ?? ''}
      title={event.title}
      venue={formatMeta(event)}
      tags={[{ label: event.category, tone: CATEGORY_TICK[event.category] }]}
      tick={CATEGORY_TICK[event.category]}
      onPress={() => router.push(`/event/${event.id}`)}
    />
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

function FeaturedCard({
  kicker,
  title,
  meta,
  photo,
}: {
  kicker: string;
  title: string;
  meta: string;
  photo: string;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';

  return (
    <View style={styles.featuredWrap}>
      <View
        style={[
          styles.featured,
          { backgroundColor: isNacht ? palette.noir2 : roles.accent },
        ]}
      >
      <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} contentFit="cover" />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: isNacht
              ? 'rgba(10,10,11,0.55)'
              : 'rgba(201,69,58,0.55)',
          },
        ]}
      />
      <View style={styles.featuredInner}>
        <Text style={[styles.featuredKicker, { color: isNacht ? palette.acid : palette.paper3 }]}>
          {kicker}
        </Text>
        <View>
          <Text style={[styles.featuredTitle, { color: isNacht ? palette.ink : palette.paper3 }]}>
            {title}
          </Text>
          <Text style={[styles.featuredMeta, { color: isNacht ? 'rgba(242,242,239,0.85)' : 'rgba(245,241,232,0.95)' }]}>
            {meta}
          </Text>
        </View>
      </View>
      </View>
    </View>
  );
}

function SectionTitle({ title, meta }: { title: string; meta: string }) {
  const roles = useRoles();
  return (
    <View style={styles.sectionTitle}>
      <Text style={[styles.sectionTitleText, { color: roles.fg }]}>{title}</Text>
      <Text style={[styles.sectionTitleText, { color: roles.fgMuted }]}>{meta}</Text>
    </View>
  );
}

function PhotoBand({ cards }: { cards: PhotoCard[] }) {
  return (
    <View style={styles.photoBand}>
      {cards.map((c) => (
        <View key={c.id} style={styles.photoCard}>
          <Image
            source={{ uri: c.photo }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: 'rgba(0,0,0,0.35)' },
            ]}
          />
          <View style={styles.photoCardContent}>
            <Text style={styles.pcKicker}>{c.kicker}</Text>
            <Text style={styles.pcTitle}>{c.title}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Hero
  hero: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12 },
  heroKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  heroTitle: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    lineHeight: 30 * 0.95,
    letterSpacing: -1,
    marginTop: 6,
  },
  heroEm: {
    fontFamily: fontFamily.body,
    fontStyle: 'italic',
  },

  // Featured — same horizontal inset as the rest of the feed
  featuredWrap: {
    paddingHorizontal: 18,
    marginBottom: 20,
  },
  featured: {
    aspectRatio: 1 / 1.2,
    borderRadius: 18,
    overflow: 'hidden',
    padding: 16,
    justifyContent: 'space-between',
  },
  featuredInner: { flex: 1, justifyContent: 'space-between' },
  featuredKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  featuredTitle: {
    fontFamily: fontFamily.display,
    fontSize: 34,
    lineHeight: 34 * 0.92,
    letterSpacing: -1.4,
  },
  featuredMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 10,
  },

  // Section title
  sectionTitle: {
    paddingHorizontal: 18,
    paddingBottom: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  sectionTitleText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // List loading / error
  listState: {
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  listStateText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
  },

  // Photo band
  photoBand: {
    paddingHorizontal: 18,
    paddingBottom: 20,
    flexDirection: 'row',
    gap: 10,
  },
  photoCard: {
    flex: 1,
    aspectRatio: 3 / 4,
    borderRadius: 14,
    overflow: 'hidden',
  },
  photoCardContent: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 10,
  },
  pcKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: palette.ink,
    marginBottom: 4,
  },
  pcTitle: {
    fontFamily: fontFamily.display,
    fontSize: 17,
    lineHeight: 17 * 0.95,
    letterSpacing: -0.42,
    color: palette.ink,
  },
});
