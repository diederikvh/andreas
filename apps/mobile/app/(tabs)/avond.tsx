import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
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
  isDaytimeOccurrence,
  getVenueTypeChips,
  dowFull,
  dowUpper,
  effectiveEndsAtMs,
  expandToOccurrenceRows,
  isLongRunning,
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
  // Vandaag = 06:00 vandaag → 06:00 morgen (logische dag wisselt om
  // 06:00, niet om middernacht). Events vóór 06:00 horen nog bij de
  // avond/nacht ervoor — een club die om 02:00 nog draait is part of
  // de vorige avond. Wanneer je rond 03:00 opent met "vannacht" in
  // gedachten, valt het venster terug naar gisteren 06:00 → vandaag
  // 06:00.
  const todayWindow = useMemo(() => {
    const d = new Date(focusedNow);
    if (d.getHours() < 6) {
      d.setDate(d.getDate() - 1);
    }
    d.setHours(6, 0, 0, 0);
    const from = new Date(d);
    const to = new Date(d);
    to.setDate(to.getDate() + 1);
    return {
      from: from.toISOString(),
      toMs: to.getTime(),
      refDate: from,
    };
  }, [focusedNow]);
  // Morgen-window: 06:00 na todayWindow-end → 06:00 daarna. Sluit
  // exact aan op de todayWindow zonder gap of overlap.
  const tomorrowWindow = useMemo(() => {
    const from = new Date(todayWindow.toMs);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { fromMs: from.getTime(), toMs: to.getTime() };
  }, [todayWindow.toMs]);
  // Late avond? Trigger voor de "Morgen"-rail in dag-mode — vanaf
  // 20:00 is de overdag-content grotendeels achterhaald en wil de
  // gebruiker vooruitkijken naar morgen.
  const isLateEvening = useMemo(() => new Date(now).getHours() >= 20, [now]);
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
  // "Jouw favoriete venues"-rail toont ALLE gevolgde venues — geen
  // dag/nacht-filter. Je kiest expliciet wie je volgt en wilt die ook
  // altijd zien, ongeacht of de venue als dag- of nacht-locatie
  // geclassificeerd staat.
  const followedVenues = useMemo(() => {
    return (allVenues ?? []).filter((v) => v.myFollowState === 'volgen');
  }, [allVenues]);

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
      // Long-running events (> 7 dagen — audio tours, permanente
      // installaties, exhibitions) horen niet in "Vandaag te bezoeken".
      // Die zijn niet echt 'op een tijd vandaag' maar doorlopend, en
      // verschijnen al via de musea/galleries-rails. Multi-day-short
      // events (24h-7d) zoals weekendfestivals BLIJVEN — die zijn
      // single-day-achtig en hun per-dag occurrence-rows tonen op de
      // juiste dag.
      if (isLongRunning(e.startsAt, e.endsAt)) return false;
      if (effectiveEndsAtMs(row.occurrence) < now) return false;
      // Cliënt-side vandaag-filter: alleen occurrences waarvan
      // startsAt vandaag valt (= < morgen 00:00).
      if (
        new Date(row.occurrence.startsAt).getTime() >= todayWindow.toMs
      ) {
        return false;
      }
      // Geen cat-mode-coupling meer: `filtered` bevat alle single-day
      // events van vandaag. Cmode kiest welke rails worden gerenderd
      // (en die rails filteren zelf op cat en/of tijd). Een 14:00
      // matinee in dag-mode én een 22:00 club-event zitten beide hier
      // — de rail-render kiest wat ze tonen.
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
        // Search matched óók op event.genres — zo vindt "techno"
        // events met techno-tag ook al staat 't niet in de titel.
        const inGenres = (e.genres ?? []).some((g) =>
          g.toLowerCase().includes(needle)
        );
        if (!inTitle && !inVenue && !inDesc && !inGenres) return false;
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
    onlyFriends,
    onlyFavorites,
    query,
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
        // Tijd-coupling per mode: dag-mode hero toont alleen daytime,
        // nacht-mode alleen niet-daytime — geen cat-coupling meer.
        const isDay = isDaytimeOccurrence(
          row.occurrence.startsAt,
          row.occurrence.endsAt
        );
        if (cmode === 'expo' && !isDay) return false;
        if (cmode === 'uit' && isDay) return false;
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
        // Exhibitions / long-running zijn doorlopend en passen bij
        // dag-mode (musea/galleries). Voor nacht skippen we ze.
        const lr =
          row.event.kind === 'exhibition' ||
          isLongRunning(row.event.startsAt, row.event.endsAt);
        if (lr) return cmode === 'expo';
        // Single-day events: tijd-coupling per cmode.
        const isDay = isDaytimeOccurrence(
          row.occurrence.startsAt,
          row.occurrence.endsAt
        );
        if (cmode === 'expo' && !isDay) return false;
        if (cmode === 'uit' && isDay) return false;
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

  // Voor 'expo'-rails: events-pool die exhibitions wél meeneemt.
  // Filtering: mode-mapping (cat ∈ expo), overrule via expliciete cats,
  // plus de generieke search/friends/favorites filters die ook in
  // 'uit'-mode actief zijn. Voor de musea/galleries/lit-rails verder
  // afgekapt op "vandaag op view" via expoEventsToday hieronder; de
  // vrienden-rail draait op de bredere pool (toekomst-inclusief).
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
      if (onlyFriends && (e.friendsSaved?.length ?? 0) === 0) return false;
      if (onlyFavorites && !e.venueFollowed) return false;
      if (needle.length > 0) {
        const inTitle = e.title.toLowerCase().includes(needle);
        const inVenue = e.venue.name.toLowerCase().includes(needle);
        const inDesc = (e.description ?? '').toLowerCase().includes(needle);
        const inGenres = (e.genres ?? []).some((g) =>
          g.toLowerCase().includes(needle)
        );
        if (!inTitle && !inVenue && !inDesc && !inGenres) return false;
      }
      return true;
    });
  }, [events, activeCats, onlyFriends, onlyFavorites, query]);

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
  // Expo-mode "Overdag"-rail: alle single-day events vandaag die
  // helemaal in het dag-venster vallen (start < 18:00 én eindt
  // < 20:00 dezelfde dag) — cat-agnostisch. Zo glipt een 15:00
  // clubfeest, een matinee-concert of een middag-lezing er allemaal in.
  const railOverdag = useMemo(
    () =>
      filtered.filter((r) =>
        isDaytimeOccurrence(r.occurrence.startsAt, r.occurrence.endsAt)
      ),
    [filtered]
  );
  // "Vandaag te bezoeken" in expo-mode: alleen Kunst + Literatuur
  // single-day items (openingen, lezingen) — geen tijd-cutoff, want
  // een 19:00 art-opening hoort ook hier. Tweede mental model dan
  // "Overdag" (een tentoonstelling/lezing bezoeken ≠ een matinee
  // bijwonen).
  const railVandaagKunstLit = useMemo(
    () =>
      filtered.filter(
        (r) =>
          r.event.category === 'Kunst' || r.event.category === 'Literatuur'
      ),
    [filtered]
  );
  // Morgen-rail: zelfde filter als "Overdag" (start < 18:00, eindt
  // < 20:00 dezelfde dag) maar voor morgen. Avond-events horen niet
  // in deze rail — die check je terug in nacht-mode. Cat-agnostisch,
  // dus zowel matinees, daytime concerten als opening-events vallen
  // erin.
  const railMorgen = useMemo<OccurrenceRow[]>(() => {
    if (!events) return [];
    return expandToOccurrenceRows(events).filter((row) => {
      const e = row.event;
      if (e.kind === 'exhibition') return false;
      if (isLongRunning(e.startsAt, e.endsAt)) return false;
      if (effectiveEndsAtMs(row.occurrence) < now) return false;
      const startMs = new Date(row.occurrence.startsAt).getTime();
      if (startMs < tomorrowWindow.fromMs || startMs >= tomorrowWindow.toMs) {
        return false;
      }
      if (!isDaytimeOccurrence(row.occurrence.startsAt, row.occurrence.endsAt)) {
        return false;
      }
      return true;
    });
  }, [events, now, tomorrowWindow.fromMs, tomorrowWindow.toMs]);
  // "Vrienden gaan" is bewust toekomst-inclusief (geen vandaag-window):
  // vrienden plannen vooruit, en de rail hoort daarom onder de
  // agenda-banner — los van het vandaag-deel. Pool is `leadsPool`
  // (uit-mode-events, alle toekomst, gesorteerd op startsAt) gefilterd
  // op friendsSaved op occurrence-niveau — anders zou een 5-occurrence
  // event waarvan één voorstelling is gesaved op alle 5 dagen in deze
  // rail verschijnen.
  const railFriendsUit = useMemo(
    () =>
      leadsPool.filter(
        (r) => (r.occurrence.friendsSaved?.length ?? 0) > 0
      ),
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

  // "Op view vandaag": event-window overlapt met het vandaag-window.
  // Dwz. het event is begonnen of begint vandaag (startsAt < morgen 00:00)
  // én is nog niet afgelopen (endsAt ≥ vandaag 00:00). Hierdoor:
  // - lopende exhibitions (started weeks ago, runs for months) blijven ✓
  // - openingen/lezingen vandaag blijven ✓
  // - exhibitions die pas later openen vallen weg ✓
  // - single-day events in de toekomst vallen weg ✓
  // endsAt mag null zijn — we behandelen 'm dan als startsAt (single-day).
  const startOfTodayMs = todayWindow.refDate.getTime();
  const isOnViewToday = (e: ApiEvent): boolean => {
    const startsMs = new Date(e.startsAt).getTime();
    const endsMs = e.endsAt ? new Date(e.endsAt).getTime() : startsMs;
    return startsMs < todayWindow.toMs && endsMs >= startOfTodayMs;
  };

  // Smallere pool voor de instelling-rails: alleen wat vandaag écht
  // te bezoeken is. Vrienden-rail gebruikt 'm bewust niet.
  const expoEventsToday = useMemo<ApiEvent[]>(
    () => expoEvents.filter(isOnViewToday),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expoEvents, todayWindow.toMs, startOfTodayMs]
  );

  // Sort-key voor expo-rails: concrete happenings (single-day én
  // multi-day-short, dus openingen/lezingen/festivals tot een week)
  // komen vóór long-running items (doorlopende exhibitions). Een
  // vandaag-eenmalige opening is anders gevaarlijk eenvoudig te
  // missen tussen wekenlange tentoonstellingen. Binnen elke groep
  // sorteert 'ie op startsAt.
  const sortByStartsAt = (a: ApiEvent, b: ApiEvent) => {
    const aLong = isLongRunning(a.startsAt, a.endsAt);
    const bLong = isLongRunning(b.startsAt, b.endsAt);
    if (aLong !== bLong) return aLong ? 1 : -1;
    return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
  };

  // Musea/galleries-rails zijn kunst-rails — gate op category='Kunst'
  // zodat een daytime concert of literatuur-event in een museum-venue
  // niet per ongeluk hier landt (sinds Muziek/Theater nu óók in
  // expo-cats zitten voor de overdag-rails).
  const railMuseaMain = useMemo<ApiEvent[]>(
    () =>
      expoEventsToday
        .filter(
          (e) =>
            e.category === 'Kunst' &&
            e.venue.type === 'museum' &&
            !isFotoOrMediaMuseum(e)
        )
        .sort(sortByStartsAt),
    [expoEventsToday]
  );

  const railMuseaFoto = useMemo<ApiEvent[]>(
    () =>
      expoEventsToday
        .filter(
          (e) =>
            e.category === 'Kunst' &&
            e.venue.type === 'museum' &&
            isFotoOrMediaMuseum(e)
        )
        .sort(sortByStartsAt),
    [expoEventsToday]
  );

  const railGalleriesHedendaags = useMemo<ApiEvent[]>(
    () =>
      expoEventsToday
        .filter(
          (e) =>
            e.category === 'Kunst' &&
            e.venue.type === 'galerie' &&
            (e.venue.scene === 'mainstream' ||
              e.venue.scene === 'alternatief')
        )
        .sort(sortByStartsAt),
    [expoEventsToday]
  );

  const railGalleriesAndere = useMemo<ApiEvent[]>(
    () =>
      expoEventsToday
        .filter(
          (e) =>
            e.category === 'Kunst' &&
            e.venue.type === 'galerie' &&
            (e.venue.scene === 'underground' || e.venue.scene === 'fringe')
        )
        .sort(sortByStartsAt),
    [expoEventsToday]
  );

  const railLit = useMemo<ApiEvent[]>(
    () =>
      expoEventsToday
        .filter((e) => e.category === 'Literatuur')
        .sort(sortByStartsAt),
    [expoEventsToday]
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

        {/* Twee shortcut-CTAs naast elkaar: Kaart (ruimtelijke verkenning
            in de buurt) en Vibes (Tinder-stijl swipe-stack). */}
        <View style={styles.shortcutRow}>
          <KaartBanner />
          <OpGevoelBanner />
        </View>

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
            {/* Morgen-rail: alleen na 20:00 in dag-mode — voor wie op
                de bank al wil checken wat morgen kan. */}
            {isLateEvening && (
              <Rail
                kicker={t('Morgen', 'Tomorrow')}
                moreLabel={t('Meer →', 'More →')}
                onMore={() => router.push('/agenda' as never)}
              >
                {railMorgen.map((r) => (
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
            <Rail
              kicker={t('Overdag', 'Daytime')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() => router.push('/agenda' as never)}
            >
              {railOverdag.map((r) => (
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
              kicker={t('Vandaag te bezoeken', 'Today on view')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() =>
                router.push({ pathname: '/agenda', params: { cat: 'Kunst' } })
              }
            >
              {railVandaagKunstLit.map((r) => (
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

        {/* Vrienden gaan — toekomst-inclusief, dus niet bij het
            vandaag-deel maar onder de agenda-banner. Splitst alsnog
            per content-mode (uit gebruikt OccurrenceRow met occurrence-
            id voor recurring events, expo werkt op kale ApiEvent). */}
        {!isLoading && !error && cmode === 'uit' && railFriendsUit.length > 0 && (
          <Rail kicker={t("Vrienden vinden 't leuk", 'Friends liked')}>
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
          <Rail kicker={t("Vrienden vinden 't leuk", 'Friends liked')}>
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

function OpGevoelBanner() {
  const roles = useRoles();
  const t = useT();
  return (
    <Pressable
      onPress={() => router.push('/op-gevoel' as never)}
      style={[
        styles.shortcutBtn,
        { backgroundColor: roles.bgLift, borderColor: roles.bgChip },
      ]}
    >
      <MaterialCommunityIcons
        name="cards-outline"
        size={36}
        color={roles.accent}
      />
      <Text style={[styles.shortcutKicker, { color: roles.fgMuted }]}>
        {t('Vibes', 'Vibes')}
      </Text>
      <Text style={[styles.shortcutTitle, { color: roles.fg }]}>
        {t(
          'Swipe en kies wat je leuk vindt.',
          'Swipe and pick what you like.'
        )}
      </Text>
    </Pressable>
  );
}

function KaartBanner() {
  const roles = useRoles();
  const t = useT();
  return (
    <Pressable
      onPress={() => router.push('/kaart' as never)}
      style={[
        styles.shortcutBtn,
        { backgroundColor: roles.bgLift, borderColor: roles.bgChip },
      ]}
    >
      <Ionicons name="map-outline" size={36} color={roles.accent} />
      <Text style={[styles.shortcutKicker, { color: roles.fgMuted }]}>
        {t('Kaart', 'Map')}
      </Text>
      <Text style={[styles.shortcutTitle, { color: roles.fg }]}>
        {t(
          'Zie wat er nu speelt in de buurt.',
          'See what’s on around you right now.'
        )}
      </Text>
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
  showFavoritesChip,
  onSetFriends,
  onSetFavorites,
  onToggleBlock,
  onSetBlocks,
  onSetCats,
  onSetTypes,
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
  showFavoritesChip: boolean;
  onSetFriends: (next: boolean) => void;
  onSetFavorites: (next: boolean) => void;
  onToggleBlock: (b: TimeBlock) => void;
  onSetBlocks: (next: TimeBlock[]) => void;
  onSetCats: (next: ApiEvent['category'][]) => void;
  onSetTypes: (next: VenueType[]) => void;
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

  const toggleCat = (c: ApiEvent['category']) => {
    if (activeCats.includes(c)) onSetCats(activeCats.filter((x) => x !== c));
    else onSetCats([...activeCats, c]);
  };
  const toggleType = (vt: VenueType) => {
    if (activeTypes.includes(vt))
      onSetTypes(activeTypes.filter((x) => x !== vt));
    else onSetTypes([...activeTypes, vt]);
  };

  const filterCount =
    activeBlocks.length +
    activeCats.length +
    activeTypes.length +
    (onlyFriends ? 1 : 0) +
    (onlyFavorites ? 1 : 0);

  const onClearAll = () => {
    onSetFriends(false);
    onSetFavorites(false);
    onSetBlocks([]);
    onSetCats([]);
    onSetTypes([]);
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
      gn: [],
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
    marginBottom: 22,
    height: StyleSheet.hairlineWidth,
  },
  hero: { paddingHorizontal: 22, paddingBottom: 0 },
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

  // Twee shortcut-buttons (Kaart + Vibes) naast elkaar boven de hero
  // divider. Marginbottom geeft adem voor de divider eronder.
  shortcutRow: {
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 22,
    marginBottom: 18,
  },
  shortcutBtn: {
    flex: 1,
    // Vierkante-aanvoelende kaartknop: icoon bovenin, tekstblok eronder,
    // alles links-uitgelijnd. Geen chevron — voelt rustiger in half-
    // breedte naast z'n tweelingknop.
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  shortcutBody: { gap: 2 },
  shortcutKicker: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  shortcutTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    lineHeight: 18,
    letterSpacing: -0.14,
  },

});
