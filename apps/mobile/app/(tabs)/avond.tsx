import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import { RefreshBanner } from '@/components/RefreshBanner';
import { RunningExhibitions } from '@/components/RunningExhibitions';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  DOW_NL_FULL,
  DOW_NL_UPPER,
  MONTHS_NL_FULL,
  TIME_BLOCKS,
  effectiveEndsAtMs,
  expandToOccurrenceRows,
  formatTime,
  getTimeBlock,
  type OccurrenceRow,
  type TimeBlock,
  useFocusedNow,
  useNowMinute,
} from '@/lib/eventDisplay';
import { useEvents, useFriends } from '@/lib/queries';
import { useSession } from '@/lib/authClient';
import { FEED } from '@/mocks/feed';
import { useMode, useRoles } from '@/store/mode';
import { useVandaagFilters } from '@/store/vandaagFilters';
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


// Volgorde van de cat-secties op Vandaag — zelfde als de Agenda-
// filter chips. Categorieën zonder events vandaag worden geskipt.
const CATEGORIES_ORDER: ApiEvent['category'][] = [
  'Muziek',
  'Theater',
  'Kunst',
  'Literatuur',
  'Film',
];

// Tone-mapping per mode — zelfde patroon als in EventListRow zodat de
// cat-titels op Vandaag dezelfde kleuren delen als de tag-pills op de
// rijen eronder.
const TONE: Record<
  'nacht' | 'dag',
  Record<'acid' | 'flare' | 'plum' | 'azure', string>
> = {
  nacht: {
    acid: palette.acid,
    flare: palette.flare,
    plum: palette.plum,
    azure: palette.azure,
  },
  dag: {
    acid: palette.red,
    flare: palette.forest,
    plum: palette.cobalt,
    azure: '#8a5b00',
  },
};

export default function Avond() {
  const roles = useRoles();
  const mode = useMode();
  const insets = useSafeAreaInsets();
  const data = FEED[mode];
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  // Twee tijd-tikkers met verschillende doelen:
  //
  // - `focusedNow` ververst alleen bij tab-focus en app-resume. Drijft
  //   het socialWindow + de hero-tekst aan. Tijdens scrollen blijf je
  //   dus in dezelfde "vanavond"-bubbel — ook als 17:00 of middernacht
  //   passeert. Pas wanneer je wegloopt en terugkomt wordt het venster
  //   opnieuw bepaald (bv. om 23:00 ben je nog op vanavond, om 09:00
  //   's morgens ben je terug → nieuwe dag, nieuwe lijst).
  // - `now` (continuous, 60s) drijft alleen de client-side filter op
  //   effectieve eindtijd: zo valt een lopend event waarvan de eindtijd
  //   net gepasseerd is automatisch weg, zonder een refetch te triggeren.
  const focusedNow = useFocusedNow();
  const now = useNowMinute();
  // Vandaag = 00:00 vandaag → 00:00 morgen (mode-vrij).
  const todayWindow = useMemo(() => {
    const d = new Date(focusedNow);
    d.setHours(0, 0, 0, 0);
    const from = new Date(d);
    const to = new Date(d);
    to.setDate(to.getDate() + 1);
    return { from: from.toISOString(), to: to.toISOString(), refDate: from };
  }, [focusedNow]);
  const { data: events, isLoading, error } = useEvents({
    from: todayWindow.from,
    to: todayWindow.to,
  });

  // Filter-keuze (vrienden + tijd-blokken) wordt persistent bewaard
  // tussen sessies via een Zustand-store. URL-state was onnodig — de
  // Vandaag-tab is geen deeplink-target voor filters.
  const onlyFriends = useVandaagFilters((s) => s.onlyFriends);
  const activeBlocks = useVandaagFilters((s) => s.activeBlocks);
  const setOnlyFriends = useVandaagFilters((s) => s.setOnlyFriends);
  const toggleBlock = useVandaagFilters((s) => s.toggleBlock);
  const { data: session } = useSession();
  const { data: friends } = useFriends({
    enabled: Boolean(session?.user?.id),
  });
  const showFriendsChip = (friends?.length ?? 0) > 0;
  const onToggleFriends = () => setOnlyFriends(!onlyFriends);
  const onToggleBlock = (b: TimeBlock) => toggleBlock(b);

  // Pull-to-refresh: invalideert events-cache zodat de huidige
  // window-query opnieuw fetched. Voor wanneer de gebruiker denkt
  // "klopt dit nog wel?" en wil forceren. Minimum 700ms zichtbaar
  // zodat de spinner + banner niet weg-flitsen op snelle netwerken.
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await qc.invalidateQueries({ queryKey: ['events'] });
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) {
        await new Promise((r) => setTimeout(r, 700 - elapsed));
      }
      setRefreshing(false);
    }
  }, [qc]);

  // Spread events naar één rij per moment in het venster, dan filter op
  // dag/nacht-uur. Een 3-daags festival verschijnt zo per avond op het
  // juiste tijdslot; een wekelijks feest dat morgen óók is komt op
  // beide avonden. Exhibitions filteren we eruit — die staan los in
  // de "Doorlopend te zien"-strook (alleen dag-mode); musea zijn
  // 's nachts toch dicht.
  // Hoofd-lijst: vandaag's events (geen exhibitions), gefilterd op
  // tijd-blokken en vrienden. Mode speelt geen rol meer — die is
  // puur stilistisch.
  const filtered = useMemo<OccurrenceRow[]>(() => {
    if (!events) return [];
    return expandToOccurrenceRows(events).filter((row) => {
      if (row.event.kind === 'exhibition') return false;
      if (effectiveEndsAtMs(row.occurrence) < now) return false;
      if (activeBlocks.length > 0) {
        const block = getTimeBlock(
          new Date(row.occurrence.startsAt).getHours()
        );
        if (!activeBlocks.includes(block)) return false;
      }
      if (onlyFriends && (row.event.friendsSaved?.length ?? 0) === 0) {
        return false;
      }
      return true;
    });
  }, [events, now, activeBlocks, onlyFriends]);

  // Lopende tentoonstellingen — altijd zichtbaar als losse strook,
  // ongeacht mode of filter (Diederik: "doorlopend te zien blijft
  // altijd").
  const runningExhibitions = useMemo(() => {
    if (!events) return [];
    return events.filter((e) => e.kind === 'exhibition');
  }, [events]);

  // Alle events vandaag (zonder filter) — gebruikt voor de feature en
  // voor de totaal-telling in de hero. Filter werkt alleen op de
  // cat-secties eronder.
  const allToday = useMemo<OccurrenceRow[]>(() => {
    if (!events) return [];
    return expandToOccurrenceRows(events).filter((row) => {
      if (row.event.kind === 'exhibition') return false;
      if (effectiveEndsAtMs(row.occurrence) < now) return false;
      return true;
    });
  }, [events, now]);

  // Hoofd-artikel: featured event uit alle vandaag-events (NIET
  // filter-afhankelijk). Geen featured? Eerste rij. Lead-event wordt
  // geskipt in de cat-secties zodat-ie niet dubbel verschijnt.
  const lead = useMemo(() => {
    if (allToday.length === 0) return undefined;
    const featuredRows = allToday.filter((r) => r.event.featured);
    if (featuredRows.length === 0) return allToday[0];
    return featuredRows[Math.floor(Math.random() * featuredRows.length)];
  }, [allToday]);

  // Cat-secties: groepeer rest per categorie (zelfde volgorde als
  // CATEGORIES_ORDER). Featured-events bovenaan in elke sublijst, dan
  // gewone rows op startsAt; eerste rij krijgt een ster.
  const restByCategory = useMemo(() => {
    const seenEvents = new Set<string>(lead ? [lead.event.id] : []);
    const dedupedRest: OccurrenceRow[] = [];
    for (const row of filtered) {
      if (seenEvents.has(row.event.id)) continue;
      seenEvents.add(row.event.id);
      dedupedRest.push(row);
    }
    const map = new Map<ApiEvent['category'], OccurrenceRow[]>();
    for (const row of dedupedRest) {
      const arr = map.get(row.event.category) ?? [];
      arr.push(row);
      map.set(row.event.category, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        if (a.event.featured !== b.event.featured) {
          return a.event.featured ? -1 : 1;
        }
        return (
          new Date(a.occurrence.startsAt).getTime() -
          new Date(b.occurrence.startsAt).getTime()
        );
      });
    }
    return CATEGORIES_ORDER.flatMap((category) => {
      const items = map.get(category);
      return items && items.length > 0 ? [{ category, items }] : [];
    });
  }, [filtered, lead]);

  // Hero-tekst: "woensdag 6 mei" + "X dingen vandaag op de agenda".
  // Niet filter-afhankelijk — toont totaal voor de dag.
  const heroDateLine = useMemo(() => {
    const d = todayWindow.refDate;
    return `${DOW_NL_FULL[d.getDay()].toLowerCase()} ${d.getDate()} ${MONTHS_NL_FULL[d.getMonth()]}`;
  }, [todayWindow.refDate]);
  const heroCountLine =
    allToday.length === 0
      ? 'Niets vandaag op de agenda.'
      : allToday.length === 1
        ? '1 ding vandaag op de agenda.'
        : `${allToday.length} dingen vandaag op de agenda.`;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner
        visible={refreshing}
        topOffset={insets.top + HEADER_HEIGHT + 8}
      />
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT,
          paddingBottom: insets.bottom + 96,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            // Accent-kleur voor duidelijke zichtbaarheid op donker;
            // op iOS toont de title als label onder de spinner.
            tintColor={roles.accent}
            colors={[roles.accent]}
            title={refreshing ? 'Vernieuwen…' : 'Trek om te vernieuwen'}
            titleColor={roles.fgMuted}
            progressViewOffset={insets.top + HEADER_HEIGHT}
          />
        }
      >
        {/* Hoofd-artikel: featured event uit alle vandaag-events.
            NIET filter-afhankelijk — staat bovenaan onafhankelijk
            van wat je beneden filtert. */}
        {lead && (
          <Pressable
            onPress={() => router.push(eventPathFor(lead) as never)}
          >
            <FeaturedCard
              kicker={data.featured.kicker}
              title={lead.event.title}
              meta={formatMetaForRow(lead)}
              photo={lead.event.imageUrl ?? data.featured.photo}
            />
          </Pressable>
        )}

        {/* Kaart-CTA — onafhankelijk van de filter. */}
        <KaartBanner />

        {/* Doorlopend te zien (musea/galleries) — altijd zichtbaar als
            losse strook, niet beïnvloed door de tijd-blok filter. */}
        <RunningExhibitions events={runningExhibitions} />

        {/* Hero — datum + totaal-telling, zit als header net boven de
            filter-labels en de cat-lijsten. NIET filter-afhankelijk;
            toont totaal voor de hele dag. */}
        <View style={styles.hero}>
          <Text style={[styles.heroDate, { color: roles.accent }]}>
            {heroDateLine}
          </Text>
          <Text style={[styles.heroCount, { color: roles.fg }]}>
            {heroCountLine}
          </Text>
        </View>

        {/* Filter-chips zitten direct boven de cat-secties zodat het
            visueel duidelijk is dat ze alleen op die lijsten werken.
            Vrienden-toggle (alleen bij >=1 vriend) + tijd-blokken. */}
        <FilterChips
          onlyFriends={onlyFriends}
          onToggleFriends={onToggleFriends}
          showFriendsChip={showFriendsChip}
          activeBlocks={activeBlocks}
          onToggleBlock={onToggleBlock}
        />

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
                  activeBlocks.length > 0 || onlyFriends
                    ? 'Geen events met deze filter.'
                    : 'Vandaag niets op de agenda.'
                }
              />
            )}
            {restByCategory.map(({ category, items }) => (
              <View key={category}>
                <SectionTitle
                  title={category}
                  titleColor={TONE[mode][CATEGORY_TICK[category]]}
                  meta="Meer →"
                  onMetaPress={() =>
                    router.push({
                      pathname: '/agenda',
                      params: { cat: category as string },
                    })
                  }
                />
                {items.map((row, i) => (
                  <ApiEventRow key={row.id} row={row} featured={i === 0} />
                ))}
              </View>
            ))}
          </Animated.View>
        )}
      </ScrollView>
      <AppHeader />
    </View>
  );
}

function FilterChips({
  onlyFriends,
  onToggleFriends,
  showFriendsChip,
  activeBlocks,
  onToggleBlock,
}: {
  onlyFriends: boolean;
  onToggleFriends: () => void;
  showFriendsChip: boolean;
  activeBlocks: TimeBlock[];
  onToggleBlock: (b: TimeBlock) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.catTabs}
    >
      {showFriendsChip && (
        <Pressable
          accessibilityLabel={
            onlyFriends ? 'Toon alle events' : 'Alleen events met vrienden'
          }
          onPress={onToggleFriends}
          style={[
            styles.friendsChip,
            {
              borderColor: onlyFriends
                ? roles.fg
                : isNacht
                  ? '#2a2a2d'
                  : palette.paper,
              backgroundColor: onlyFriends
                ? roles.fg
                : isNacht
                  ? palette.noir2
                  : palette.paper2,
            },
          ]}
        >
          <Ionicons
            name="people"
            size={14}
            color={onlyFriends ? roles.bg : roles.fgMuted}
          />
        </Pressable>
      )}
      {TIME_BLOCKS.map(({ id, label }) => {
        const active = activeBlocks.includes(id);
        return (
          <Pressable
            key={id}
            onPress={() => onToggleBlock(id)}
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

function ApiEventRow({
  row,
  featured = false,
}: {
  row: OccurrenceRow;
  featured?: boolean;
}) {
  const { event } = row;
  const friends = event.friendsSaved?.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  // Op Vandaag laten we de categorie-tag weg in de rij — die staat
  // al in de sectie-titel erboven. Ster + genre/series/friends
  // blijven; tick-kleur volgt nog steeds het thema.
  return (
    <EventListRow
      thumb={event.imageUrl ?? ''}
      title={event.title}
      venue={formatMetaForRow(row)}
      seriesLabel={event.series?.[0]?.name}
      genreLabel={event.genres?.[0]}
      friends={friends && friends.length > 0 ? friends : undefined}
      featured={featured}
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
  titleColor,
  meta,
  onMetaPress,
}: {
  title: string;
  titleColor?: string;
  meta: string;
  onMetaPress?: () => void;
}) {
  const roles = useRoles();
  // Match het kop-design van "Doorlopend te zien" en "Series": bold-
  // uppercase label links (in optionele thema-kleur), mono-uppercase
  // meta rechts in een rustig grijs zodat de "Meer →"-link niet de
  // aandacht steelt van het thema-label.
  return (
    <View style={styles.sectionTitle}>
      <Text
        style={[
          styles.sectionTitleLabel,
          { color: titleColor ?? roles.fg },
        ]}
      >
        {title}
      </Text>
      {onMetaPress ? (
        <Pressable onPress={onMetaPress} hitSlop={8}>
          <Text style={[styles.sectionTitleMeta, { color: roles.fgMuted }]}>
            {meta}
          </Text>
        </Pressable>
      ) : (
        <Text style={[styles.sectionTitleMeta, { color: roles.fgMuted }]}>
          {meta}
        </Text>
      )}
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

  // Hero — datum boven, telling daaronder. Geen mode-tekst meer.
  hero: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12 },
  heroDate: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  heroCount: {
    fontFamily: fontFamily.display,
    fontSize: 26,
    lineHeight: 26 * 1,
    letterSpacing: -0.8,
    marginTop: 6,
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

  // Section title — coherent met de afstand tussen sub-secties (row
  // paddingBottom 14 + sectionTitle paddingTop 14 = 28). Korte
  // paddingBottom houdt 'm strak tegen de eerste row.
  sectionTitle: {
    paddingHorizontal: 22,
    paddingTop: 14,
    paddingBottom: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  sectionTitleLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  sectionTitleMeta: {
    fontFamily: fontFamily.mono,
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
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  friendsChip: {
    width: 32,
    height: 32,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catTabText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    letterSpacing: -0.06,
    lineHeight: 14,
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

  // Kaart-banner — prominent CTA tussen FeaturedCard en de events-
  // lijst. Top-spacing wordt door FeaturedCard's marginBottom geleverd
  // (20), dus onze eigen marginBottom van 20 zorgt voor gelijkmatige
  // ruimte rondom de banner.
  kaartBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 22,
    marginBottom: 20,
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
