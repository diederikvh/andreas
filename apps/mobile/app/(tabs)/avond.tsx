import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { ContentSwitchHint } from '@/components/ContentSwitchHint';
import { Cross } from '@/components/Cross';
import { Rail } from '@/components/Rail';
import { RailEventCard } from '@/components/RailEventCard';
import { VenueRailCard } from '@/components/VenueRailCard';
import { RefreshBanner } from '@/components/RefreshBanner';
import { RunningStrip } from '@/components/RunningStrip';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent, VenueType } from '@/lib/api';
import {
  eventImageUrl,
  CATEGORY_TICK,
  eventBelongsToMode,
  getVenueTypeChips,
  dowFull,
  dowUpper,
  effectiveEndsAtMs,
  expandToOccurrenceRows,
  isMultiDay,
  rowTimeLabel,
  freeLabel,
  getTimeBlock,
  monthFull,
  translateCategory,
  type OccurrenceRow,
  type TimeBlock,
  useFocusedNow,
  useNowMinute,
  useTimeBlocks,
} from '@/lib/eventDisplay';
import { softTap, tinyTap } from '@/lib/haptics';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import {
  useEventGenres,
  useEvents,
  useFriends,
  useVenues,
  useSeriesList,
} from '@/lib/queries';
import { useSession } from '@/lib/authClient';
import { useContentMode } from '@/store/contentMode';
import { useMode, useRoles } from '@/store/mode';
import { useAddSavedVandaagSearch } from '@/store/savedVandaagSearches';
import { useVandaagFilters } from '@/store/vandaagFilters';
import { fontFamily, palette } from '@/theme/tokens';

function formatMetaForRow(row: OccurrenceRow, locale: Locale): string {
  const d = new Date(row.occurrence.startsAt);
  const dow = dowUpper(d.getDay(), locale);
  const cents = row.occurrence.priceCents;
  const price =
    cents == null
      ? null
      : cents === 0
        ? freeLabel(locale)
        : `€${(cents / 100).toFixed(0)}`;
  return [
    dow,
    rowTimeLabel(row.occurrence.startsAt, row.occurrence.endsAt, locale),
    row.event.venue.name.toUpperCase(),
    price,
  ]
    .filter(Boolean)
    .join(' · ');
}


// Hoogte van de chip-row — gebruikt door de sticky-overlay om de
// fade-in threshold te bepalen (= scrollY waar de inline chip-row
// achter de AppHeader is verdwenen).
const STICKY_CHIPROW_HEIGHT = 60;

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
  Record<'acid' | 'flare' | 'plum' | 'azure' | 'saffron', string>
> = {
  nacht: {
    acid: palette.acid,
    flare: palette.flare,
    plum: palette.plum,
    azure: palette.azure,
    saffron: palette.saffron,
  },
  dag: {
    acid: palette.red,
    flare: palette.forest,
    plum: palette.cobalt,
    azure: '#8a5b00',
    saffron: '#9d6008',
  },
};

export default function Avond() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const cmode = useContentMode();
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
    return {
      from: from.toISOString(),
      toMs: to.getTime(),
      refDate: from,
    };
  }, [focusedNow]);
  // Geen `to` op de query: zo komen exhibitions die nog lopen (en
  // exhibitions die binnenkort openen) ook in de "Doorlopend te zien"
  // strook, gelijk aan wat de Agenda-tab toont. De vandaag-filter op
  // de events-lijst doen we cliënt-side via todayWindow.toMs.
  const { data: events, isLoading, error } = useEvents({
    from: todayWindow.from,
  });
  // Series + exhibitions delen één "Loopt nu"-strook bovenaan. Series
  // komen uit /series (apart endpoint), exhibitions zitten in `events`.
  const { data: seriesList } = useSeriesList();
  // Alle venues die de gebruiker volgt — onafhankelijk van wat er
  // vandaag speelt. Voor de "Jouw favorieten"-rail onder de
  // agenda-banner. Backend filtert myFollowState per venue; wij
  // selecteren 'volgen' aan de client-kant zodat we ook de venue-data
  // (imageUrl, type) direct in handen hebben.
  const { data: allVenues } = useVenues();
  // Splits de "Jouw favoriete venues"-rail op visuele modus: nacht
  // toont night/both, dag toont day/both. Venues zonder dayNight-veld
  // (`null`) blijven in beide modi staan — geen reden om verborgen te
  // houden als 't classification ontbreekt.
  const followedVenues = useMemo(() => {
    return (allVenues ?? []).filter((v) => {
      if (v.myFollowState !== 'volgen') return false;
      if (v.dayNight === null || v.dayNight === 'both') return true;
      return mode === 'nacht'
        ? v.dayNight === 'night'
        : v.dayNight === 'day';
    });
  }, [allVenues, mode]);

  // Filter-state — leeft persistent in een Zustand-store. Het zoek+
  // filter-paneel is verhuisd naar Agenda; op Vandaag respecteren we
  // de waarden alleen passief in de rail-filters (geen UI om ze te
  // zetten). De setters worden niet meer aangeroepen vanaf Vandaag.
  const query = useVandaagFilters((s) => s.query);
  const onlyFriends = useVandaagFilters((s) => s.onlyFriends);
  const onlyFavorites = useVandaagFilters((s) => s.onlyFavorites);
  const activeBlocks = useVandaagFilters((s) => s.activeBlocks);
  const activeCats = useVandaagFilters((s) => s.activeCats);
  const activeTypes = useVandaagFilters((s) => s.activeTypes);
  const activeGenres = useVandaagFilters((s) => s.activeGenres);
  const { data: session } = useSession();
  // Friends data wordt nog gebruikt door rail-filters (friendsSaved op
  // events). Geen friends-chip meer in de header — die zat in de oude
  // chip-row.
  useFriends({ enabled: Boolean(session?.user?.id) });

  // Pull-to-refresh: invalideert events-cache zodat de huidige
  // window-query opnieuw fetched. Voor wanneer de gebruiker denkt
  // "klopt dit nog wel?" en wil forceren. Minimum 700ms zichtbaar
  // zodat de spinner + banner niet weg-flitsen op snelle netwerken.
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  // Roterende seed voor de Featured-fallback wanneer er geen echte
  // featured-events zijn. Wordt verhoogd bij elke pull-to-refresh
  // zodat de hero dan een ander random item uit de rails laat zien.
  // Start op een tijd-gebaseerde waarde zodat verschillende sessies
  // niet allemaal hetzelfde item zien.
  const [featuredSeed, setFeaturedSeed] = useState(() =>
    Math.floor(Date.now() / 60_000)
  );
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setFeaturedSeed((s) => s + 1);
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
  // tijd-blokken, vrienden en favoriete venues. Mode speelt geen rol
  // meer — die is puur stilistisch.
  const filtered = useMemo<OccurrenceRow[]>(() => {
    if (!events) return [];
    const needle = query.trim().toLowerCase();
    return expandToOccurrenceRows(events).filter((row) => {
      const e = row.event;
      if (e.kind === 'exhibition') return false;
      if (effectiveEndsAtMs(row.occurrence) < now) return false;
      // Cliënt-side vandaag-filter: alleen occurrences waarvan
      // startsAt vandaag valt (= < morgen 00:00).
      if (
        new Date(row.occurrence.startsAt).getTime() >= todayWindow.toMs
      ) {
        return false;
      }
      // Content-mode-filter overschrijft de cat-filter níet: een
      // expliciete categorie-keuze blijft leidend, ook als 'ie buiten
      // de huidige mode valt. Geen expliciete cat? Dan beperken we
      // tot de mode-categorieën.
      if (activeCats.length === 0) {
        if (!eventBelongsToMode(e, cmode)) return false;
      }
      if (activeCats.length > 0 && !activeCats.includes(e.category)) {
        return false;
      }
      if (activeTypes.length > 0) {
        // Venue zonder type valt buiten de filter — bewust strict
        // zodat "alleen clubs" niet ineens venues zonder type mee­
        // sleurt.
        if (!e.venue.type || !activeTypes.includes(e.venue.type)) {
          return false;
        }
      }
      if (activeGenres.length > 0) {
        const evGenres = e.genres ?? [];
        if (!evGenres.some((g) => activeGenres.includes(g))) return false;
      }
      if (activeBlocks.length > 0) {
        const block = getTimeBlock(
          new Date(row.occurrence.startsAt).getHours()
        );
        if (!activeBlocks.includes(block)) return false;
      }
      if (onlyFriends && (e.friendsSaved?.length ?? 0) === 0) return false;
      if (onlyFavorites && !e.venueFollowed) return false;
      if (needle.length > 0) {
        const inTitle = e.title.toLowerCase().includes(needle);
        const inVenue = e.venue.name.toLowerCase().includes(needle);
        const inDesc = (e.description ?? '').toLowerCase().includes(needle);
        if (!inTitle && !inVenue && !inDesc) return false;
      }
      return true;
    });
  }, [
    events,
    now,
    todayWindow.toMs,
    activeBlocks,
    activeCats,
    activeTypes,
    activeGenres,
    onlyFriends,
    onlyFavorites,
    query,
    cmode,
  ]);

  // Pool voor de Featured-carousel: events die nu nog komen, mode-aware,
  // exhibitions weg. Vandaag's events eerst (gesorteerd op startsAt),
  // daarna upcoming dagen — zodat 't Feature ook laat op de avond niet
  // leeg slaat als 'r vandaag niets meer staat. De caller filtert dan
  // featured-eerst en pakt de juiste subset.
  const leadsPool = useMemo<OccurrenceRow[]>(() => {
    if (!events) return [];
    return expandToOccurrenceRows(events)
      .filter((row) => {
        if (row.event.kind === 'exhibition') return false;
        if (effectiveEndsAtMs(row.occurrence) < now) return false;
        if (!eventBelongsToMode(row.event, cmode)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          new Date(a.occurrence.startsAt).getTime() -
          new Date(b.occurrence.startsAt).getTime()
      );
  }, [events, now, cmode]);

  // Bredere pool voor de Featured-fallback — bevat óók exhibitions
  // (anders zou de hero in expo-mode alleen single-day events kunnen
  // tonen, terwijl de musea/galleries-rails wél exhibitions tonen).
  const featuredFallbackPool = useMemo<OccurrenceRow[]>(() => {
    if (!events) return [];
    return expandToOccurrenceRows(events)
      .filter((row) => {
        if (effectiveEndsAtMs(row.occurrence) < now) return false;
        if (!eventBelongsToMode(row.event, cmode)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          new Date(a.occurrence.startsAt).getTime() -
          new Date(b.occurrence.startsAt).getTime()
      );
  }, [events, now, cmode]);

  // Featured leads: probeer eerst vandaag's featured-events. Geen
  // featured vandaag? Pak een RANDOM item uit de rails-pool (rotert
  // elke pull-to-refresh, zodat je telkens iets anders ziet als hero
  // i.p.v. monotoom hetzelfde eerste event). Idem voor de upcoming-
  // fallback wanneer vandaag leeg is.
  const leads = useMemo<OccurrenceRow[]>(() => {
    if (leadsPool.length === 0 && featuredFallbackPool.length === 0) return [];
    const todayMs = todayWindow.toMs;
    const todayRows = leadsPool.filter(
      (r) => new Date(r.occurrence.startsAt).getTime() < todayMs
    );
    const todayFallback = featuredFallbackPool.filter(
      (r) => new Date(r.occurrence.startsAt).getTime() < todayMs
    );
    const dedupe = (rows: OccurrenceRow[]) => {
      const seen = new Set<string>();
      return rows.filter((r) => {
        if (seen.has(r.event.id)) return false;
        seen.add(r.event.id);
        return true;
      });
    };
    const pickRandom = (rows: OccurrenceRow[]) => {
      const unique = dedupe(rows);
      if (unique.length === 0) return [];
      const idx =
        ((featuredSeed % unique.length) + unique.length) % unique.length;
      return [unique[idx]];
    };
    if (todayRows.length > 0) {
      const todayFeatured = todayRows.filter((r) => r.event.featured);
      if (todayFeatured.length > 0) return dedupe(todayFeatured);
    }
    // Geen vandaag-featured maar wel vandaag-content (incl. lopende
    // exhibitions) → random pick.
    if (todayFallback.length > 0) return pickRandom(todayFallback);
    // Vandaag is leeg — kijk vooruit. Featured eerst, anders random
    // uit de upcoming-pool (incl. exhibitions).
    const upcomingFeatured = leadsPool.filter((r) => r.event.featured);
    if (upcomingFeatured.length > 0) {
      return dedupe(upcomingFeatured).slice(0, 5);
    }
    return pickRandom(featuredFallbackPool);
  }, [
    leadsPool,
    featuredFallbackPool,
    todayWindow.toMs,
    featuredSeed,
  ]);

  // Hero-tekst: "{dag} {datum} op de agenda" met de datum in
  // accent-kleur. Niet filter-afhankelijk.
  const heroParts = useMemo(() => {
    const d = todayWindow.refDate;
    return {
      day: dowFull(d.getDay(), locale).toLowerCase(),
      date: `${d.getDate()} ${monthFull(d.getMonth(), locale)}`,
    };
  }, [todayWindow.refDate, locale]);

  // Voor 'expo'-rails: events-pool die NIET op vandaag-window filtert
  // én exhibitions wel meeneemt. Exhibitions lopen weken/maanden, dus
  // "vandaag" maakt niet uit. Filtering: mode-mapping (cat ∈ expo),
  // overrule via expliciete cats, plus de generieke search/friends/
  // favorites filters die ook in 'uit'-mode actief zijn.
  const expoEvents = useMemo<ApiEvent[]>(() => {
    if (!events) return [];
    const needle = query.trim().toLowerCase();
    return events.filter((e) => {
      if (activeCats.length === 0 && !eventBelongsToMode(e, 'expo')) {
        return false;
      }
      if (activeCats.length > 0 && !activeCats.includes(e.category)) {
        return false;
      }
      if (activeGenres.length > 0) {
        const evGenres = e.genres ?? [];
        if (!evGenres.some((g) => activeGenres.includes(g))) return false;
      }
      if (onlyFriends && (e.friendsSaved?.length ?? 0) === 0) return false;
      if (onlyFavorites && !e.venueFollowed) return false;
      if (needle.length > 0) {
        const inTitle = e.title.toLowerCase().includes(needle);
        const inVenue = e.venue.name.toLowerCase().includes(needle);
        const inDesc = (e.description ?? '').toLowerCase().includes(needle);
        if (!inTitle && !inVenue && !inDesc) return false;
      }
      return true;
    });
  }, [events, activeCats, activeGenres, onlyFriends, onlyFavorites, query]);

  // Rails voor 'uit'-mode — gebaseerd op `filtered` (OccurrenceRow[]
  // van vandaag, gefilterd op user-state). Per rail aanvullende
  // filter-criterium. Lege rails worden door de Rail-component
  // gewoonweg niet gerenderd.
  const railClubs = useMemo(
    () => filtered.filter((r) => r.event.venue.type === 'club'),
    [filtered]
  );
  const railLivePodium = useMemo(
    () =>
      filtered.filter(
        (r) =>
          r.event.venue.type === 'podium' && r.event.category === 'Muziek'
      ),
    [filtered]
  );
  const railTheater = useMemo(
    () => filtered.filter((r) => r.event.category === 'Theater'),
    [filtered]
  );
  const railFilm = useMemo(
    () => filtered.filter((r) => r.event.category === 'Film'),
    [filtered]
  );
  // "Vrienden gaan" is bewust toekomst-inclusief (geen vandaag-window):
  // vrienden plannen vooruit, en de rail hoort daarom onder de
  // agenda-banner — los van het vandaag-deel. Pool is `leadsPool`
  // (uit-mode-events, alle toekomst, gesorteerd op startsAt) gefilterd
  // op friendsSaved.
  const railFriendsUit = useMemo(
    () =>
      leadsPool.filter((r) => (r.event.friendsSaved?.length ?? 0) > 0),
    [leadsPool]
  );
  // Rails voor 'expo'-mode — gebaseerd op `expoEvents` (ApiEvent[]).
  // Doorlopende exhibitions worden gegroepeerd per type instelling
  // (musea per genre, galleries per scene) i.p.v. op tijd-framing —
  // omdat exhibitions weken/maanden lopen is een tijd-rail ('nieuw
  // geopend' / 'sluit binnenkort') minder bruikbaar dan een
  // instelling-rail. De 'Vandaag te bezoeken'-rail valt buiten dit
  // patroon: dat is `filtered` in cmode='expo' (zelfde today-window-
  // logic als 'uit'-mode, alleen mode-cats wijzen op Kunst/Literatuur).
  const isFotoOrMediaMuseum = (e: ApiEvent): boolean => {
    const sub = e.venue.subtype ?? [];
    return sub.includes('fotografie') || sub.includes('media');
  };

  // Sort-key voor expo-rails: single-day events (concrete happenings —
  // openingen, lezingen, talks) komen vóór multi-day items
  // (doorlopende exhibitions). Een vandaag-eenmalige opening anders
  // is anders gevaarlijk eenvoudig te missen tussen wekenlange
  // tentoonstellingen. Binnen elke groep sorteert 'ie op startsAt.
  const sortByStartsAt = (a: ApiEvent, b: ApiEvent) => {
    const aMulti = isMultiDay(a.startsAt, a.endsAt);
    const bMulti = isMultiDay(b.startsAt, b.endsAt);
    if (aMulti !== bMulti) return aMulti ? 1 : -1;
    return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
  };

  const railMuseaMain = useMemo<ApiEvent[]>(
    () =>
      expoEvents
        .filter(
          (e) => e.venue.type === 'museum' && !isFotoOrMediaMuseum(e)
        )
        .sort(sortByStartsAt),
    [expoEvents]
  );

  const railMuseaFoto = useMemo<ApiEvent[]>(
    () =>
      expoEvents
        .filter((e) => e.venue.type === 'museum' && isFotoOrMediaMuseum(e))
        .sort(sortByStartsAt),
    [expoEvents]
  );

  const railGalleriesHedendaags = useMemo<ApiEvent[]>(
    () =>
      expoEvents
        .filter(
          (e) =>
            e.venue.type === 'galerie' &&
            (e.venue.scene === 'mainstream' ||
              e.venue.scene === 'alternatief')
        )
        .sort(sortByStartsAt),
    [expoEvents]
  );

  const railGalleriesAndere = useMemo<ApiEvent[]>(
    () =>
      expoEvents
        .filter(
          (e) =>
            e.venue.type === 'galerie' &&
            (e.venue.scene === 'underground' || e.venue.scene === 'fringe')
        )
        .sort(sortByStartsAt),
    [expoEvents]
  );

  const railLit = useMemo<ApiEvent[]>(
    () =>
      expoEvents
        .filter((e) => e.category === 'Literatuur')
        .sort(sortByStartsAt),
    [expoEvents]
  );

  const railFriendsExpo = useMemo<ApiEvent[]>(
    () =>
      expoEvents
        .filter((e) => (e.friendsSaved?.length ?? 0) > 0)
        .sort(sortByStartsAt),
    [expoEvents]
  );

  const hasFilterActive =
    activeBlocks.length > 0 ||
    activeCats.length > 0 ||
    activeGenres.length > 0 ||
    onlyFriends ||
    onlyFavorites ||
    query.trim().length > 0;

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
            tintColor={roles.accent}
            colors={[roles.accent]}
            title={
              refreshing
                ? t('Vernieuwen…', 'Refreshing…')
                : t('Trek om te vernieuwen', 'Pull to refresh')
            }
            titleColor={roles.fgMuted}
            progressViewOffset={insets.top + HEADER_HEIGHT}
          />
        }
      >
        {/* Hoofd-artikelen: alle featured events uit vandaag-events.
            Lichte negative marginTop zodat de top van de hero onder
            de fade-to-transparent header doorloopt. */}
        {leads.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <FeaturedCarousel
              leads={leads}
              kicker={t('Onze keuze', 'Our pick')}
              locale={locale}
            />
          </View>
        )}

        {/* Kaart-CTA — in beide modes. Voor 'uit' zie je clubs/podia
            in de buurt; voor 'expo' lopende musea/galleries in de
            buurt — beide zijn ruimtelijke verkenning waard. */}
        <KaartBanner />

        {/* Hero — divider + "{dag} {datum}" met datum in accent. */}
        <View style={[styles.heroDivider, { backgroundColor: roles.bgChip }]} />
        <View style={styles.hero}>
          <Text
            numberOfLines={1}
            style={[styles.heroLine, { color: roles.fg }]}
          >
            {heroParts.day}{' '}
            <Text style={{ color: roles.accent }}>{heroParts.date}</Text>
          </Text>
        </View>

        {/* Festivals/series in 'uit', doorlopende tentoonstellingen in
            'expo'. Tussen Hero en cat-rails. Geen kop-label —
            visueel onderscheidt de strook zich genoeg door image-format
            en datum-range subline. */}
        <RunningStrip
          series={cmode === 'uit' ? (seriesList ?? []) : []}
          exhibitionEvents={[]}
        />

        {isLoading && (
          <View style={styles.loadingWrap}>
            <SpinningCross size={28} color={roles.fgPlaceholder} />
          </View>
        )}
        {error && (
          <ListState
            text={t('Kon events niet laden.', 'Couldn’t load events.')}
            tone="error"
          />
        )}

        {/* Rails — afhankelijk van content-mode. Lege rails worden door
            de Rail-component zelf weggelaten. Cards mappen op
            occurrence-rij ('uit') of event ('expo' — exhibitions). */}
        {!isLoading && !error && cmode === 'uit' && (
          <>
            <Rail
              kicker={t('Vannacht in de clubs', 'Tonight in the clubs')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({ pathname: '/agenda', params: { cat: 'Muziek' } })
              }
            >
              {railClubs.map((r) => (
                <RailEventCard
                  key={r.id}
                  event={r.event}
                  occurrenceId={
                    r.occurrence.id.endsWith('::next') ? undefined : r.occurrence.id
                  }
                  occurrenceStartsAt={r.occurrence.startsAt}
                  occurrenceEndsAt={r.occurrence.endsAt}
                />
              ))}
            </Rail>
            <Rail
              kicker={t('Live op de podia', 'Live on stage')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({ pathname: '/agenda', params: { cat: 'Muziek' } })
              }
            >
              {railLivePodium.map((r) => (
                <RailEventCard
                  key={r.id}
                  event={r.event}
                  occurrenceId={
                    r.occurrence.id.endsWith('::next') ? undefined : r.occurrence.id
                  }
                  occurrenceStartsAt={r.occurrence.startsAt}
                  occurrenceEndsAt={r.occurrence.endsAt}
                />
              ))}
            </Rail>
            <Rail
              kicker={t('Theater & dans', 'Theatre & dance')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({ pathname: '/agenda', params: { cat: 'Theater' } })
              }
            >
              {railTheater.map((r) => (
                <RailEventCard
                  key={r.id}
                  event={r.event}
                  occurrenceId={
                    r.occurrence.id.endsWith('::next') ? undefined : r.occurrence.id
                  }
                  occurrenceStartsAt={r.occurrence.startsAt}
                  occurrenceEndsAt={r.occurrence.endsAt}
                />
              ))}
            </Rail>
            <Rail
              kicker={t('Film vanavond', 'Film tonight')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({ pathname: '/agenda', params: { cat: 'Film' } })
              }
            >
              {railFilm.map((r) => (
                <RailEventCard
                  key={r.id}
                  event={r.event}
                  occurrenceId={
                    r.occurrence.id.endsWith('::next') ? undefined : r.occurrence.id
                  }
                  occurrenceStartsAt={r.occurrence.startsAt}
                  occurrenceEndsAt={r.occurrence.endsAt}
                />
              ))}
            </Rail>
          </>
        )}

        {!isLoading && !error && cmode === 'expo' && (
          <>
            <Rail
              kicker={t('Vandaag te bezoeken', 'Today on view')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({ pathname: '/agenda', params: { cat: 'Kunst' } })
              }
            >
              {filtered.map((r) => (
                <RailEventCard
                  key={r.id}
                  event={r.event}
                  occurrenceId={
                    r.occurrence.id.endsWith('::next') ? undefined : r.occurrence.id
                  }
                  occurrenceStartsAt={r.occurrence.startsAt}
                  occurrenceEndsAt={r.occurrence.endsAt}
                />
              ))}
            </Rail>
            <Rail
              kicker={t('Grote kunstmusea', 'Major art museums')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({ pathname: '/agenda', params: { cat: 'Kunst' } })
              }
            >
              {railMuseaMain.map((e) => (
                <RailEventCard key={e.id} event={e} />
              ))}
            </Rail>
            <Rail
              kicker={t('Foto & media musea', 'Photo & media museums')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({ pathname: '/agenda', params: { cat: 'Kunst' } })
              }
            >
              {railMuseaFoto.map((e) => (
                <RailEventCard key={e.id} event={e} />
              ))}
            </Rail>
            <Rail
              kicker={t('Hedendaagse galleries', 'Contemporary galleries')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({ pathname: '/agenda', params: { cat: 'Kunst' } })
              }
            >
              {railGalleriesHedendaags.map((e) => (
                <RailEventCard key={e.id} event={e} />
              ))}
            </Rail>
            <Rail
              kicker={t('Andere kunstruimtes', 'Other art spaces')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({ pathname: '/agenda', params: { cat: 'Kunst' } })
              }
            >
              {railGalleriesAndere.map((e) => (
                <RailEventCard key={e.id} event={e} />
              ))}
            </Rail>
            <Rail
              kicker={t('Literatuur', 'Literature')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({
                  pathname: '/agenda',
                  params: { cat: 'Literatuur' },
                })
              }
            >
              {railLit.map((e) => (
                <RailEventCard key={e.id} event={e} />
              ))}
            </Rail>
          </>
        )}

        {/* Empty-state alleen in 'uit'-modus — daar is "vandaag" het
            uitgangspunt en zegt geen-events-vandaag iets. In 'expo'-
            modus draaien de rails op expoEvents (geen vandaag-filter)
            dus filtered=0 betekent niets — de rails kunnen alsnog vol
            staan met exhibitions/lit-events. Een "vandaag niets op de
            agenda"-melding zou dan tegenstrijdig zijn. */}
        {cmode === 'uit' &&
          !isLoading &&
          !error &&
          filtered.length === 0 &&
          events && (
            <Animated.View entering={FadeIn.duration(220)}>
              <EmptyResults hasFilter={hasFilterActive} minHeight={240} />
            </Animated.View>
          )}

        {/* Bottom-banner: na alle rails een uitnodiging om door te
            klikken naar de volledige Agenda. Spiegelt visueel de
            KaartBanner bovenaan. */}
        {!isLoading && !error && <AgendaBanner />}

        {/* Vrienden gaan — toekomst-inclusief, dus niet bij het
            vandaag-deel maar onder de agenda-banner. Splitst alsnog
            per content-mode (uit gebruikt OccurrenceRow met occurrence-
            id voor recurring events, expo werkt op kale ApiEvent). */}
        {!isLoading && !error && cmode === 'uit' && railFriendsUit.length > 0 && (
          <Rail kicker={t('Vrienden gaan', 'Friends going')}>
            {railFriendsUit.map((r) => (
              <RailEventCard
                key={r.id}
                event={r.event}
                occurrenceId={
                  r.occurrence.id.endsWith('::next') ? undefined : r.occurrence.id
                }
                occurrenceStartsAt={r.occurrence.startsAt}
                occurrenceEndsAt={r.occurrence.endsAt}
              />
            ))}
          </Rail>
        )}
        {!isLoading && !error && cmode === 'expo' && railFriendsExpo.length > 0 && (
          <Rail kicker={t('Vrienden gaan', 'Friends going')}>
            {railFriendsExpo.map((e) => (
              <RailEventCard key={e.id} event={e} />
            ))}
          </Rail>
        )}

        {/* Favoriete venues, altijd zichtbaar — los van of er vandaag
            iets speelt. Komt na de agenda-banner omdat 't visueel
            buiten de "vandaag"-bubbel valt en als hub voor je
            volg-lijst dient (tap → venue-pagina met volledige
            programmering). */}
        {followedVenues.length > 0 && (
          <Rail
            kicker={t('Jouw favoriete venues', 'Your favourite venues')}
            moreLabel={t('Alle venues →', 'All venues →')}
            onMore={() => router.push('/venues' as never)}
          >
            {followedVenues.map((v) => (
              <VenueRailCard
                key={v.id}
                slug={v.slug}
                name={v.name}
                imageUrl={v.imageUrl}
                type={v.type}
              />
            ))}
          </Rail>
        )}
      </ScrollView>
      <AppHeader title={t('Vandaag', 'Today')} showContentMode />
      <ContentSwitchHint />
    </View>
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

function EmptyResults({
  hasFilter,
  minHeight,
}: {
  hasFilter: boolean;
  minHeight: number;
}) {
  const roles = useRoles();
  const t = useT();
  const title = hasFilter
    ? t('Niets gevonden met deze filters.', 'Nothing found with these filters.')
    : t('Vandaag niets op de agenda.', 'Nothing on today’s agenda.');
  const body = hasFilter
    ? t(
        'Pas je filter of zoekterm aan om meer events te zien.',
        'Adjust your filter or search to see more events.'
      )
    : t(
        'Kijk morgen weer, of bekijk de hele week op Agenda.',
        'Check back tomorrow, or browse the whole week on Agenda.'
      );
  return (
    <View style={[styles.emptyResults, { minHeight }]}>
      <Ionicons
        name={hasFilter ? 'search-outline' : 'sparkles-outline'}
        size={44}
        color={roles.fgMuted}
      />
      <Text style={[styles.emptyResultsTitle, { color: roles.fg }]}>
        {title}
      </Text>
      <Text style={[styles.emptyResultsBody, { color: roles.fgMuted }]}>
        {body}
      </Text>
    </View>
  );
}

/**
 * Page-snap carousel voor de hero-cards bovenaan Vandaag. Bij één lead
 * vervalt 't naar een gewone Pressable+FeaturedCard zonder dots.
 */
function FeaturedCarousel({
  leads,
  kicker,
  locale,
}: {
  leads: OccurrenceRow[];
  kicker: string;
  locale: Locale;
}) {
  const { width } = useWindowDimensions();
  const roles = useRoles();
  const [page, setPage] = useState(0);
  // Re-tap op Vandaag-tab → carousel terug naar eerste lead + dot-
  // indicator gereset. Eigen listener (geen useScrollToTop) omdat we
  // óók de page-state moeten meereseten, anders staat de dot scheef.
  // Hooks vóór de single-lead early return — Rules of Hooks.
  // `as any` op de event-naam omdat useNavigation default getypt is
  // op de root-navigator; tabPress wordt geëmit door de tab-navigator
  // waar dit scherm in zit (de Tabs-stack).
  const carouselRef = useRef<ScrollView>(null);
  const navigation = useNavigation();
  useEffect(() => {
    const unsubscribe = navigation.addListener('tabPress' as never, () => {
      if (navigation.isFocused()) {
        carouselRef.current?.scrollTo({ x: 0, animated: true });
        setPage(0);
      }
    });
    return unsubscribe;
  }, [navigation]);

  if (leads.length === 1) {
    const lead = leads[0];
    return (
      <Pressable onPress={() => router.push(eventPathFor(lead) as never)}>
        <FeaturedCard
          kicker={kicker}
          title={lead.event.title}
          meta={formatMetaForRow(lead, locale)}
          photo={eventImageUrl(lead.event) ?? undefined}
          category={lead.event.category}
        />
      </Pressable>
    );
  }

  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / width);
    setPage(Math.min(Math.max(idx, 0), leads.length - 1));
  };

  return (
    <View>
      <ScrollView
        ref={carouselRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScrollEnd}
      >
        {leads.map((lead) => (
          <View key={lead.id} style={{ width }}>
            <Pressable
              onPress={() => router.push(eventPathFor(lead) as never)}
            >
              <FeaturedCard
                kicker={kicker}
                title={lead.event.title}
                meta={formatMetaForRow(lead, locale)}
                photo={eventImageUrl(lead.event) ?? undefined}
                category={lead.event.category}
              />
            </Pressable>
          </View>
        ))}
      </ScrollView>
      <View style={styles.featuredDots}>
        {leads.map((_, i) => (
          <View
            key={i}
            style={[
              styles.featuredDot,
              {
                backgroundColor: i === page ? roles.fg : roles.fgPlaceholder,
                width: i === page ? 18 : 6,
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

function FeaturedCard({
  kicker,
  title,
  meta,
  photo,
  category,
}: {
  kicker: string;
  title: string;
  meta: string;
  photo?: string;
  category?: ApiEvent['category'];
}) {
  const mode = useMode();
  const roles = useRoles();
  const locale = useLocale();
  const isNacht = mode === 'nacht';
  const titleColor = isNacht ? palette.ink : palette.paper3;
  const metaColor = isNacht
    ? 'rgba(242,242,239,0.85)'
    : 'rgba(245,241,232,0.95)';
  const categoryTone = category
    ? TONE[mode][CATEGORY_TICK[category]]
    : undefined;

  return (
    <View style={styles.featuredWrap}>
      <View
        style={[
          styles.featured,
          { backgroundColor: isNacht ? palette.noir2 : roles.accent },
        ]}
      >
        {photo && (
          <Image
            source={{ uri: photo }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
        )}
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              // Subtiele tint over de foto — donker op nacht voor
              // contrast, een hint accent op dag (veel zachter dan
              // voorheen, foto blijft duidelijk de hero).
              backgroundColor: isNacht
                ? 'rgba(10,10,11,0.45)'
                : 'rgba(201,69,58,0.18)',
            },
          ]}
        />
        <View style={styles.featuredInner}>
          <View style={styles.featuredBottom}>
            <View style={styles.featuredLabels}>
              <View
                style={[
                  styles.featuredLabel,
                  { backgroundColor: roles.accent },
                ]}
              >
                <Text
                  style={[styles.featuredLabelText, { color: roles.onAccent }]}
                >
                  {kicker}
                </Text>
              </View>
              {category && categoryTone && (
                <View
                  style={[
                    styles.featuredLabel,
                    { backgroundColor: categoryTone },
                  ]}
                >
                  <Text
                    style={[
                      styles.featuredLabelText,
                      { color: roles.onAccent },
                    ]}
                  >
                    {translateCategory(category, locale)}
                  </Text>
                </View>
              )}
            </View>
            <Text style={[styles.featuredTitle, { color: titleColor }]}>
              {title}
            </Text>
            <Text style={[styles.featuredMeta, { color: metaColor }]}>
              {meta}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function KaartBanner() {
  const roles = useRoles();
  const t = useT();
  return (
    <Pressable
      onPress={() => router.push('/kaart' as never)}
      style={[
        styles.kaartBanner,
        {
          backgroundColor: roles.bgLift,
          borderColor: roles.bgChip,
        },
      ]}
    >
      <Ionicons name="map-outline" size={22} color={roles.fgMuted} />
      <View style={styles.kaartBody}>
        <Text style={[styles.kaartKicker, { color: roles.fgMuted }]}>
          {t('Op de kaart', 'On the map')}
        </Text>
        <Text style={[styles.kaartTitle, { color: roles.fg }]}>
          {t(
            'Zie wat er nu speelt in de buurt.',
            'See what’s on around you right now.'
          )}
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

function AgendaBanner() {
  const roles = useRoles();
  const t = useT();
  return (
    <Pressable
      onPress={() => router.push('/agenda' as never)}
      style={[
        styles.kaartBanner,
        {
          backgroundColor: roles.bgLift,
          borderColor: roles.bgChip,
        },
      ]}
    >
      <Ionicons name="calendar-outline" size={22} color={roles.fgMuted} />
      <View style={styles.kaartBody}>
        <Text style={[styles.kaartKicker, { color: roles.fgMuted }]}>
          {t('Vooruit plannen', 'Plan ahead')}
        </Text>
        <Text style={[styles.kaartTitle, { color: roles.fg }]}>
          {t(
            'Bekijk de hele agenda.',
            'Browse the full agenda.'
          )}
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

export function AvondFilterSheet({
  query,
  onlyFriends,
  onlyFavorites,
  activeBlocks,
  activeCats,
  activeTypes,
  activeGenres,
  showFavoritesChip,
  onSetFriends,
  onSetFavorites,
  onToggleBlock,
  onSetBlocks,
  onSetCats,
  onSetTypes,
  onSetGenres,
  onClose,
}: {
  query: string;
  /** Geen visible Vrienden-toggle meer in dit sheet — die zit nu
      enkel in de chip-row buiten het sheet. We houden onlyFriends +
      onSetFriends wél als prop voor saved-search round-trip en zodat
      "Wis alles" de Vrienden-filter ook reset. */
  onlyFriends: boolean;
  onlyFavorites: boolean;
  activeBlocks: TimeBlock[];
  activeCats: ApiEvent['category'][];
  activeTypes: VenueType[];
  activeGenres: string[];
  showFavoritesChip: boolean;
  onSetFriends: (next: boolean) => void;
  onSetFavorites: (next: boolean) => void;
  onToggleBlock: (b: TimeBlock) => void;
  onSetBlocks: (next: TimeBlock[]) => void;
  onSetCats: (next: ApiEvent['category'][]) => void;
  onSetTypes: (next: VenueType[]) => void;
  onSetGenres: (next: string[]) => void;
  onClose: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const locale = useLocale();
  const isNacht = mode === 'nacht';
  const t = useT();
  const timeBlocks = useTimeBlocks();
  const typeChips = useMemo(() => getVenueTypeChips(locale), [locale]);
  const addSaved = useAddSavedVandaagSearch();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  // Android-modal valt full-screen — inset-bottom (3-knops nav of
  // gesture-handle) moet de footer-rij omhoog duwen. iOS pageSheet
  // hangt los van de schermrand en heeft genoeg eigen ruimte.
  const sheetInsets = useSafeAreaInsets();
  const footerPaddingBottom =
    Platform.OS === 'android' ? sheetInsets.bottom + 16 : 16;
  const { data: genreData, isLoading: genresLoading, error: genresError } =
    useEventGenres();

  // Filter genre-buckets op de geselecteerde categorieën — als er
  // niets gekozen is, alle genres tonen. Zelfde patroon als Agenda.
  const groupedGenres = useMemo(() => {
    if (!genreData) return [];
    const filtered =
      activeCats.length > 0
        ? genreData.filter((b) => activeCats.includes(b.category))
        : genreData;
    const map = new Map<ApiEvent['category'], typeof filtered>();
    for (const b of filtered) {
      const arr = map.get(b.category) ?? [];
      arr.push(b);
      map.set(b.category, arr);
    }
    return CATEGORIES_ORDER.flatMap((category) => {
      const items = map.get(category);
      return items ? [{ category, items }] : [];
    });
  }, [genreData, activeCats]);

  const toggleCat = (c: ApiEvent['category']) => {
    if (activeCats.includes(c)) onSetCats(activeCats.filter((x) => x !== c));
    else onSetCats([...activeCats, c]);
  };
  const toggleType = (vt: VenueType) => {
    if (activeTypes.includes(vt))
      onSetTypes(activeTypes.filter((x) => x !== vt));
    else onSetTypes([...activeTypes, vt]);
  };
  const toggleGenre = (g: string) => {
    if (activeGenres.includes(g))
      onSetGenres(activeGenres.filter((x) => x !== g));
    else onSetGenres([...activeGenres, g]);
  };

  const filterCount =
    activeBlocks.length +
    activeCats.length +
    activeTypes.length +
    activeGenres.length +
    (onlyFriends ? 1 : 0) +
    (onlyFavorites ? 1 : 0);

  const onClearAll = () => {
    onSetFriends(false);
    onSetFavorites(false);
    onSetBlocks([]);
    onSetCats([]);
    onSetTypes([]);
    onSetGenres([]);
  };

  const onSave = () => {
    const name = saveName.trim();
    if (name.length === 0) return;
    addSaved({
      name,
      q: query,
      vr: onlyFriends,
      fv: onlyFavorites,
      tb: activeBlocks,
      cats: activeCats,
      vt: activeTypes,
      gn: activeGenres,
    });
    setSaveOpen(false);
    setSaveName('');
    onClose();
  };

  return (
    <KeyboardAvoidingView
      style={[styles.sheetRoot, { backgroundColor: roles.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 60 : 0}
    >
      <View style={styles.sheetDragHandleWrap}>
        <View
          style={[
            styles.sheetDragHandle,
            { backgroundColor: roles.fgPlaceholder },
          ]}
        />
      </View>
      {Platform.OS !== 'ios' && (
        <Pressable
          onPress={onClose}
          hitSlop={8}
          style={[
            styles.sheetCloseBtn,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        >
          <Cross size={14} thickness={2.6} color={roles.fg} />
        </Pressable>
      )}
      <View style={styles.sheetHead}>
        <Text style={[styles.sheetTitle, { color: roles.fg }]}>
          {t('Filter', 'Filter')}
        </Text>
        <Text style={[styles.sheetLead, { color: roles.fgMuted }]}>
          {t(
            "Combineer tijd, vrienden en favorieten. Sla 'm op om de combinatie als chip te bewaren.",
            'Combine time, friends and favourites. Save it to keep the combination as a chip.'
          )}
        </Text>
      </View>

      <ScrollView
        style={styles.sheetScroll}
        contentContainerStyle={styles.sheetScrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.sheetSectionHead, { color: roles.fgMuted }]}>
          {t('Categorie', 'Category')}
        </Text>
        <View style={styles.sheetWrap}>
          {CATEGORIES_ORDER.map((cat) => (
            <SheetChip
              key={cat}
              label={translateCategory(cat, locale)}
              active={activeCats.includes(cat)}
              onPress={() => toggleCat(cat)}
            />
          ))}
        </View>

        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          {t('Venue-type', 'Venue type')}
        </Text>
        {/* Venue-type-chips, gevolgd door de "Favoriete venues"-toggle
            als de gebruiker venues volgt — beide zijn "waar?"-filters,
            dus thematisch één rij. Vrienden-toggle staat in de chip-row
            buiten dit sheet en hoeft hier niet dubbel. */}
        <View style={styles.sheetWrap}>
          {typeChips.map((c) => (
            <SheetChip
              key={c.value}
              label={c.label}
              active={activeTypes.includes(c.value)}
              onPress={() => toggleType(c.value)}
            />
          ))}
          {showFavoritesChip && (
            <SheetChip
              label={t('Favoriete venues', 'Favourite venues')}
              active={onlyFavorites}
              onPress={() => onSetFavorites(!onlyFavorites)}
            />
          )}
        </View>

        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          {t('Tijd', 'Time')}
        </Text>
        <View style={styles.sheetWrap}>
          {timeBlocks.map((b) => (
            <SheetChip
              key={b.id}
              label={b.label}
              sub={b.range}
              active={activeBlocks.includes(b.id)}
              onPress={() => onToggleBlock(b.id)}
            />
          ))}
        </View>

        {/* Genres komen onderaan: het kunnen er veel zijn, dus eerst
            de korte label-secties (categorie/venue-type/tijd) en dan
            pas de lange genre-lijst. */}
        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          {t('Genre', 'Genre')}
        </Text>
        {genresLoading && (
          <View style={styles.sheetLoading}>
            <SpinningCross size={24} color={roles.fgPlaceholder} />
          </View>
        )}
        {genresError && (
          <Text style={[styles.sheetEmpty, { color: '#c9453a' }]}>
            {t('Kon genres niet laden.', 'Couldn’t load genres.')}
          </Text>
        )}
        {!genresLoading && !genresError && groupedGenres.length === 0 && (
          <Text style={[styles.sheetEmpty, { color: roles.fgMuted }]}>
            {activeCats.length === 1
              ? t(
                  `Geen genres gevonden voor ${activeCats[0]}.`,
                  `No genres found for ${translateCategory(activeCats[0], 'en')}.`
                )
              : activeCats.length > 1
                ? t(
                    'Geen genres gevonden voor deze categorieën.',
                    'No genres found for these categories.'
                  )
                : t('Nog geen genres ingevuld.', 'No genres yet.')}
          </Text>
        )}
        <View style={styles.sheetSubGroup}>
          {groupedGenres.map((section) => (
            <View key={section.category}>
              {(activeCats.length === 0 || activeCats.length > 1) && (
                <Text
                  style={[
                    styles.sheetSubHead,
                    { color: roles.fgPlaceholder },
                  ]}
                >
                  {translateCategory(section.category, locale)}
                </Text>
              )}
              <View style={styles.sheetWrap}>
                {section.items.map((b) => {
                  const checked = activeGenres.includes(b.genre);
                  return (
                    <Pressable
                      key={`${section.category}-${b.genre}`}
                      onPress={() => {
                        tinyTap();
                        toggleGenre(b.genre);
                      }}
                      style={[
                        styles.genreChip,
                        {
                          borderColor: checked ? roles.fg : roles.bgChip,
                          backgroundColor: checked
                            ? roles.fg
                            : isNacht
                              ? palette.noir2
                              : palette.paper2,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.genreChipText,
                          { color: checked ? roles.bg : roles.fg },
                        ]}
                      >
                        {b.genre}
                      </Text>
                      <Text
                        style={[
                          styles.genreChipCount,
                          {
                            color: checked
                              ? roles.bg
                              : roles.fgPlaceholder,
                          },
                        ]}
                      >
                        {b.count}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      {saveOpen ? (
        <View
          style={[
            styles.sheetFooter,
            { borderTopColor: roles.bgChip, paddingBottom: footerPaddingBottom },
          ]}
        >
          <View
            style={[
              styles.saveInputWrap,
              {
                backgroundColor: isNacht ? palette.noir2 : palette.paper2,
                borderColor: roles.bgChip,
              },
            ]}
          >
            <TextInput
              value={saveName}
              onChangeText={setSaveName}
              placeholder={t(
                'Naam (bv. Avond met vrienden)',
                'Name (e.g. Evening with friends)'
              )}
              placeholderTextColor={roles.fgPlaceholder}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={onSave}
              style={[styles.saveInput, { color: roles.fg }]}
              maxLength={28}
            />
          </View>
          <Pressable
            accessibilityLabel={t('Opslaan', 'Save')}
            onPress={() => {
              softTap();
              onSave();
            }}
            disabled={saveName.trim().length === 0}
            style={[
              styles.sheetIconBtn,
              {
                backgroundColor: isNacht ? palette.acid : palette.red,
                borderColor: 'transparent',
                opacity: saveName.trim().length === 0 ? 0.4 : 1,
              },
            ]}
          >
            <Ionicons
              name="checkmark"
              size={20}
              color={isNacht ? palette.noir : palette.paper3}
            />
          </Pressable>
          <Pressable
            accessibilityLabel={t('Annuleer', 'Cancel')}
            onPress={() => {
              setSaveOpen(false);
              setSaveName('');
            }}
            style={[styles.sheetIconBtn, { borderColor: roles.bgChip }]}
          >
            <Ionicons name="close" size={18} color={roles.fgMuted} />
          </Pressable>
        </View>
      ) : (
        <View
          style={[
            styles.sheetFooter,
            { borderTopColor: roles.bgChip, paddingBottom: footerPaddingBottom },
          ]}
        >
          <Pressable
            onPress={onClose}
            style={[
              styles.sheetDoneBtn,
              { backgroundColor: isNacht ? palette.acid : palette.red },
            ]}
          >
            <Text
              style={[
                styles.sheetDoneText,
                { color: isNacht ? palette.noir : palette.paper3 },
              ]}
            >
              {t('Bekijk', 'View')}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel={t('Bewaar filter', 'Save filter')}
            onPress={() => {
              softTap();
              setSaveOpen(true);
            }}
            disabled={filterCount === 0}
            style={[
              styles.sheetIconBtn,
              {
                borderColor: roles.bgChip,
                opacity: filterCount === 0 ? 0.4 : 1,
              },
            ]}
          >
            <Ionicons name="bookmark-outline" size={18} color={roles.accent} />
          </Pressable>
          <Pressable
            accessibilityLabel={t('Sluit filter', 'Close filter')}
            onPress={() => {
              if (filterCount > 0) onClearAll();
              onClose();
            }}
            style={[styles.sheetIconBtn, { borderColor: roles.bgChip }]}
          >
            <Ionicons name="close" size={18} color={roles.fgMuted} />
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function SheetChip({
  label,
  sub,
  active,
  onPress,
}: {
  label: string;
  sub?: string;
  active: boolean;
  onPress: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  return (
    <Pressable
      onPress={() => {
        tinyTap();
        onPress();
      }}
      style={[
        styles.sheetChip,
        {
          borderColor: active ? roles.fg : roles.bgChip,
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
          styles.sheetChipText,
          { color: active ? roles.bg : roles.fg },
        ]}
      >
        {label}
      </Text>
      {sub && (
        <Text
          style={[
            styles.sheetChipSub,
            { color: active ? roles.bg : roles.fgPlaceholder },
          ]}
        >
          {sub}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Hero — divider + "{dag} {datum} op de agenda" in display-font,
  // datum in accent. Geen mono-kicker meer. Strak op de
  // exhibitions-strook erboven.
  heroDivider: {
    marginHorizontal: 22,
    marginTop: 0,
    marginBottom: 14,
    height: StyleSheet.hairlineWidth,
  },
  hero: { paddingHorizontal: 22, paddingBottom: 12 },
  heroLine: {
    fontFamily: fontFamily.display,
    fontSize: 26,
    lineHeight: 26 * 1.05,
    letterSpacing: -0.8,
  },

  // Featured — same horizontal inset as the rest of the feed
  featuredWrap: {
    paddingHorizontal: 18,
    marginBottom: 20,
  },
  featuredDots: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: -8,
    marginBottom: 20,
  },
  featuredDot: {
    height: 6,
    borderRadius: 999,
  },
  featured: {
    aspectRatio: 1 / 1.2,
    borderRadius: 18,
    overflow: 'hidden',
    padding: 16,
    justifyContent: 'space-between',
  },
  featuredInner: { flex: 1, justifyContent: 'flex-end' },
  // Onderste blok — labels boven titel. Zelfde stijl en spacing als
  // de tag-pill in de event-detail hero (heroBottom gap 12, tag
  // paddingHorizontal 10 / paddingVertical 5, mono 10/1.4 uppercase).
  featuredBottom: { gap: 12 },
  featuredLabels: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  featuredLabel: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  featuredLabelText: {
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

  // Chip-row — zelfde patroon als Agenda's ChipRow. Expliciete height
  // zodat de afstand tussen logo en chipRow exact matcht met
  // Agenda/Venues (zonder dit waren er 4px verschil door content-
  // sized layout).
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 22,
    paddingVertical: 6,
    height: STICKY_CHIPROW_HEIGHT,
  },
  searchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
  },
  searchIcon: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchInput: {
    flex: 1,
    fontFamily: fontFamily.mono,
    fontSize: 13,
    letterSpacing: 0.8,
    padding: 0,
    margin: 0,
    height: 24,
  },
  catChip: {
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.06,
  },
  iconToggle: {
    width: 44,
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Filter-sheet — zelfde design als Agenda-sheet.
  sheetRoot: { flex: 1 },
  sheetDragHandleWrap: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 8,
  },
  sheetDragHandle: {
    width: 44,
    height: 5,
    borderRadius: 2.5,
    opacity: 0.6,
  },
  sheetCloseBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetHead: {
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 14,
  },
  sheetTitle: {
    fontFamily: fontFamily.display,
    fontSize: 24,
    lineHeight: 24 * 1.05,
    letterSpacing: -0.6,
  },
  sheetLead: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
  },
  sheetScroll: { flex: 1 },
  sheetScrollContent: {
    paddingHorizontal: 22,
    paddingBottom: 24,
  },
  sheetSectionHead: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  sheetWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sheetLoading: {
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetEmpty: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    paddingVertical: 14,
    textAlign: 'center',
  },
  sheetSubGroup: { gap: 12 },
  sheetSubHead: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  genreChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
  },
  genreChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.13,
    textTransform: 'lowercase',
  },
  genreChipCount: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  sheetChip: {
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  sheetChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.13,
  },
  sheetChipSub: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.8,
    marginTop: 1,
  },
  sheetFooter: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 22,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetIconBtn: {
    width: 48,
    height: 48,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetDoneBtn: {
    flex: 1.4,
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetDoneText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  saveInputWrap: {
    flex: 1.4,
    height: 48,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  saveInput: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
    padding: 0,
    margin: 0,
  },

  // Lege-resultaten — gecentreerd, minHeight zorgt dat het keyboard
  // 'm niet over de tekst legt als je in de zoek tikt en geen events
  // matcht. Zelfde icon-title-body design als andere empty-states.
  emptyResults: {
    paddingHorizontal: 32,
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyResultsTitle: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.4,
    textAlign: 'center',
    marginTop: 12,
  },
  emptyResultsBody: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 4,
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

  // Kaart-banner — accent-getinte vlakke pill. Geen border, geen
  // ronde icon-tile; kicker + zin direct naast het map-icoon en
  // dicht op elkaar. Beide regels in bold.
  kaartBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 22,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  kaartBody: { flex: 1, minWidth: 0 },
  kaartKicker: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  kaartTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    lineHeight: 18,
    letterSpacing: -0.14,
  },

});
