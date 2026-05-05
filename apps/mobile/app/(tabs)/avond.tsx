import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useMemo, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  DOW_NL_UPPER,
  expandToOccurrenceRows,
  formatTime,
  isNachtHour,
  type OccurrenceRow,
  socialWindow,
} from '@/lib/eventDisplay';
import { useEvents } from '@/lib/queries';
import { FEED } from '@/mocks/feed';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

function formatMetaForRow(row: OccurrenceRow): string {
  const d = new Date(row.occurrence.startsAt);
  const dow = DOW_NL_UPPER[d.getDay()];
  const cents = row.occurrence.priceCents;
  const price =
    cents == null ? null : cents === 0 ? 'gratis' : `€${(cents / 100).toFixed(0)}`;
  return [dow, formatTime(row.occurrence.startsAt), row.event.venue.name.toUpperCase(), price]
    .filter(Boolean)
    .join(' · ');
}


const DOW_NL_LOWER = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'] as const;
const MONTHS_NL_LONG = [
  'jan', 'feb', 'mrt', 'apr', 'mei', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
] as const;

type Hero = {
  kicker: string;
  titleBefore: string;
  titleEm: string;
  titleAfter: string;
};

/**
 * Hero-copy hangt af van de mode (vanavond vs overdag), de grootte
 * van de gecureerde lijst, en of we naar morgen zijn verschoven
 * (alleen in dag-mode na 17:00).
 */
function buildHero(
  mode: 'nacht' | 'dag',
  count: number,
  refDate: Date,
  shifted: boolean
): Hero {
  const dow = DOW_NL_LOWER[refDate.getDay()];
  const day = refDate.getDate();
  const month = MONTHS_NL_LONG[refDate.getMonth()];
  const datePart = `${dow} ${day} ${month}`;

  if (mode === 'nacht') {
    const kicker = `Vanavond · ${datePart}`;
    if (count === 0) {
      return { kicker, titleBefore: '', titleEm: 'Niets', titleAfter: '\nvoor vanavond.' };
    }
    if (count === 1) {
      return {
        kicker,
        titleBefore: 'Eén ding die\n',
        titleEm: 'vanavond',
        titleAfter: ' telt.',
      };
    }
    return {
      kicker,
      titleBefore: `${count} dingen\ndie `,
      titleEm: 'vanavond',
      titleAfter: ' tellen.',
    };
  }

  // Dag-mode: bij shifted (na 17:00) lopen we naar morgen.
  const dayLabel = shifted ? 'Morgen' : 'Vandaag';
  const planEm = shifted ? 'morgen' : 'overdag';
  const kicker = `${dayLabel} · ${datePart}`;
  if (count === 0) {
    return {
      kicker,
      titleBefore: '',
      titleEm: 'Niets',
      titleAfter: shifted ? '\nvoor morgen overdag.' : '\nvoor overdag.',
    };
  }
  if (count === 1) {
    return {
      kicker,
      titleBefore: 'Eén ding om\n',
      titleEm: planEm,
      titleAfter: ' te plannen.',
    };
  }
  return {
    kicker,
    titleBefore: `${count} dingen om\n`,
    titleEm: planEm,
    titleAfter: ' te plannen.',
  };
}

export default function Avond() {
  const roles = useRoles();
  const mode = useMode();
  const insets = useSafeAreaInsets();
  const data = FEED[mode];
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  const window = useMemo(() => socialWindow(mode), [mode]);
  // Avond toont *alles* binnen het 3-daagse venster, gesplitst op
  // tijd-van-dag. De featured-flag dient alleen om één event als
  // hoofd-artikel boven uit te lichten — niet om de lijst eronder te
  // filteren.
  const { data: events, isLoading, error } = useEvents({
    from: window.from,
    to: window.to,
  });
  // Spread events naar één rij per moment in het venster, dan filter op
  // dag/nacht-uur. Een 3-daags festival verschijnt zo per avond op het
  // juiste tijdslot; een wekelijks feest dat morgen óók is komt op
  // beide avonden.
  const filtered = useMemo<OccurrenceRow[]>(() => {
    if (!events) return [];
    return expandToOccurrenceRows(events).filter((row) => {
      const hour = new Date(row.occurrence.startsAt).getHours();
      return mode === 'nacht' ? isNachtHour(hour) : !isNachtHour(hour);
    });
  }, [events, mode]);

  // Hoofd-artikel: featured event uit de split. Geen featured? Eerste rij.
  const lead = useMemo(() => {
    if (filtered.length === 0) return undefined;
    const featuredRows = filtered.filter((r) => r.event.featured);
    if (featuredRows.length === 0) return filtered[0];
    return featuredRows[Math.floor(Math.random() * featuredRows.length)];
  }, [filtered]);

  // Rest: alle andere occurrence-rows. Skippen we de lead's row, plus
  // dedupliceer per event-id zodat het lead-event niet ook nog
  // los onder verschijnt (het kan andere occurrences in het venster
  // hebben — maar de lead toont dezelfde "show" al).
  const rest = useMemo(() => {
    if (!lead) return filtered;
    const seenEvents = new Set<string>([lead.event.id]);
    const out: OccurrenceRow[] = [];
    for (const row of filtered) {
      if (seenEvents.has(row.event.id)) continue;
      seenEvents.add(row.event.id);
      out.push(row);
    }
    return out;
  }, [filtered, lead]);

  const followedRest = useMemo(
    () => rest.filter((r) => r.event.venueFollowed),
    [rest]
  );
  const otherRest = useMemo(
    () => rest.filter((r) => !r.event.venueFollowed),
    [rest]
  );

  const hero = buildHero(mode, filtered.length, window.refDate, window.shifted);

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
            {hero.kicker}
          </Text>
          <Text style={[styles.heroTitle, { color: roles.fg }]}>
            {hero.titleBefore}
            <Text style={[styles.heroEm, { color: roles.accent }]}>
              {hero.titleEm}
            </Text>
            {hero.titleAfter}
          </Text>
        </View>

        {/* Cat-tabs zijn shortcuts naar de Agenda met categorie voorgefilterd.
            Avond filtert nooit op categorie zelf — die rol heeft Agenda. */}
        <CategoryTabs />

        {/* Hoofd-artikel: eerste featured event als grote kaart bovenaan.
            Tot we een dedicated lead-flag hebben pakken we de eerstvolgende
            featured-pick. */}
        {lead && (
          <Pressable
            onPress={() =>
              router.push(eventPathFor(lead) as never)
            }
          >
            <FeaturedCard
              kicker={data.featured.kicker}
              title={lead.event.title}
              meta={formatMetaForRow(lead)}
              photo={lead.event.imageUrl ?? data.featured.photo}
            />
          </Pressable>
        )}

        {isLoading && (
          <View style={styles.loadingWrap}>
            <SpinningCross size={28} thickness={5} color={roles.fgPlaceholder} />
          </View>
        )}
        {error && <ListState text="Kon events niet laden." tone="error" />}
        {!isLoading && !error && (
          <Animated.View entering={FadeIn.duration(220)}>
            {filtered.length === 0 && events && (
              <ListState
                text={
                  mode === 'nacht'
                    ? 'Vanavond niets gepland.'
                    : window.shifted
                      ? 'Morgen overdag niets gepland.'
                      : 'Overdag niets gepland.'
                }
              />
            )}
            {followedRest.length > 0 && (
              <>
                <SectionTitle
                  title="Venues die je volgt"
                  meta="Alles →"
                  onMetaPress={() => router.push('/agenda')}
                />
                {followedRest.map((row) => (
                  <ApiEventRow key={row.id} row={row} />
                ))}
              </>
            )}
            {otherRest.length > 0 && (
              <>
                <SectionTitle
                  title={
                    followedRest.length > 0
                      ? 'Ook interessant'
                      : mode === 'nacht'
                        ? 'Vanavond'
                        : window.shifted
                          ? 'Morgen overdag'
                          : 'Overdag'
                  }
                  meta="Alles →"
                  onMetaPress={() => router.push('/agenda')}
                />
                {otherRest.map((row) => (
                  <ApiEventRow key={row.id} row={row} />
                ))}
              </>
            )}
            {(followedRest.length > 0 || otherRest.length > 0) && (
              <KaartBanner />
            )}
          </Animated.View>
        )}
      </ScrollView>
      <AppHeader />
    </View>
  );
}

function CategoryTabs() {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const homeLabel = isNacht ? 'Vanavond' : 'Overdag';
  const cats: { label: string; cat: ApiEvent['category'] | null }[] = [
    { label: homeLabel, cat: null },
    { label: 'Muziek', cat: 'Muziek' },
    { label: 'Theater', cat: 'Theater' },
    { label: 'Literatuur', cat: 'Literatuur' },
    { label: 'Film', cat: 'Film' },
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.catTabs}
    >
      {cats.map(({ label, cat }) => {
        // Eerste chip is de "current view"-indicator: Vanavond/Overdag
        // staat altijd actief op Avond. Tappen doet niets — andere chips
        // springen naar Agenda met de filter voorgeselecteerd.
        const active = cat === null;
        return (
          <Pressable
            key={label}
            onPress={
              active
                ? undefined
                : () =>
                    router.push({
                      pathname: '/agenda',
                      params: { cat: cat as string },
                    })
            }
            style={[
              styles.catTab,
              {
                borderColor: active
                  ? roles.fg
                  : isNacht
                    ? '#2a2a2d'
                    : palette.paper,
                backgroundColor: active
                  ? roles.fg
                  : isNacht
                    ? palette.noir2
                    : palette.paper2,
              },
            ]}
          >
            <Text
              style={[
                styles.catTabText,
                { color: active ? roles.bg : roles.fgMuted },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * Pad naar event-detail. Voor occurrences die uit de API komen (echte
 * id) hangen we `?o=` aan zodat de detail-page weet welk specifiek
 * moment was aangetapt; voor synthetische rijen (`evt::next`) blijft
 * het pad puur op event-id.
 */
function eventPathFor(row: OccurrenceRow): string {
  if (row.occurrence.id.endsWith('::next')) {
    return `/event/${row.event.id}`;
  }
  return `/event/${row.event.id}?o=${row.occurrence.id}`;
}

function ApiEventRow({ row }: { row: OccurrenceRow }) {
  const { event, occurrence } = row;
  const friends = event.friendsSaved?.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  return (
    <EventListRow
      thumb={event.imageUrl ?? ''}
      title={event.title}
      venue={formatMetaForRow(row)}
      tags={[{ label: event.category, tone: CATEGORY_TICK[event.category] }]}
      seriesLabel={event.series?.[0]?.name}
      genreLabel={event.genres?.[0]}
      friends={friends && friends.length > 0 ? friends : undefined}
      tick={CATEGORY_TICK[event.category]}
      onPress={() => router.push(eventPathFor(row) as never)}
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

function SectionTitle({
  title,
  meta,
  onMetaPress,
}: {
  title: string;
  meta: string;
  onMetaPress?: () => void;
}) {
  const roles = useRoles();
  if (onMetaPress) {
    return (
      <View style={styles.sectionTitle}>
        <Text style={[styles.sectionTitleText, { color: roles.fg }]}>
          {title}
        </Text>
        <Pressable onPress={onMetaPress} hitSlop={8}>
          <Text style={[styles.sectionTitleText, { color: roles.accent }]}>
            {meta}
          </Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.sectionTitle}>
      <Text style={[styles.sectionTitleText, { color: roles.fg }]}>{title}</Text>
      <Text style={[styles.sectionTitleText, { color: roles.fgMuted }]}>{meta}</Text>
    </View>
  );
}

function KaartBanner() {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  return (
    <Pressable
      onPress={() => router.push('/kaart' as never)}
      style={[
        styles.kaartBanner,
        {
          borderColor: isNacht ? '#232327' : palette.paper,
          backgroundColor: isNacht ? '#101012' : palette.paper2,
        },
      ]}
    >
      {/* Accent-tinted icon-tile + accent-icoon: brand-pop zonder de
          rest van de banner te overstemmen. */}
      <View
        style={[
          styles.kaartIconWrap,
          { backgroundColor: `${roles.accent}26` },
        ]}
      >
        <Ionicons name="map-outline" size={22} color={roles.accent} />
      </View>
      <View style={styles.kaartBody}>
        <Text style={[styles.kaartKicker, { color: roles.accent }]}>
          Op de kaart
        </Text>
        <Text style={[styles.kaartTitle, { color: roles.fg }]}>
          Zie wat er nu speelt in de buurt.
        </Text>
      </View>
      <Ionicons
        name="chevron-forward"
        size={18}
        color={roles.fgPlaceholder}
      />
    </Pressable>
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

  // Category tabs (Avond) — navigate to Agenda met filter
  catTabs: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 18,
    paddingTop: 4,
    paddingBottom: 14,
  },
  catTab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  catTabText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    letterSpacing: -0.06,
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
  loadingWrap: {
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Kaart-banner — prominent CTA onder de events-lijst die naar
  // /kaart pusht (Kaart heeft geen eigen tab meer).
  kaartBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 22,
    marginTop: 22,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  kaartIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kaartBody: { flex: 1, minWidth: 0 },
  kaartKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  kaartTitle: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    lineHeight: 19,
    letterSpacing: -0.14,
  },
});
