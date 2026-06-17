import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { Cross } from '@/components/Cross';
import { Rail, useRailCardStyles } from '@/components/Rail';
import { FilmRailCard, FILM_CARD_WIDTH } from '@/components/FilmRailCard';
import { RailEventCard } from '@/components/RailEventCard';
import {
  VenueSquareRailCard,
  SQUARE_CARD_WIDTH,
} from '@/components/VenueSquareRailCard';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SearchOverlay } from '@/components/SearchOverlay';
import { RunningStrip } from '@/components/RunningStrip';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent, ApiFeedEvent, SavedApiEvent, VenueType } from '@/lib/api';
import {
  eventImageUrl,
  CATEGORY_TICK,
  eventBelongsToMode,
  isDaytimeOccurrence,
  getVenueTypeChips,
  dowMixed,
  dowUpper,
  monthShort,
  effectiveEndsAtMs,
  expandToOccurrenceRows,
  isLongRunning,
  rowTimeLabel,
  freeLabel,
  getTimeBlock,
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
  useForYouEvents,
  useMe,
  useMySaves,
  useNewArrivalsSince,
  useSocialFeed,
  useVenues,
  useSeriesList,
} from '@/lib/queries';
import { useSession } from '@/lib/authClient';
import { useMode, useRoles } from '@/store/mode';
import { useAddSavedVandaagSearch } from '@/store/savedVandaagSearches';
import { useNewBadgeSince } from '@/store/sessionTimestamps';
import { useVandaagFilters } from '@/store/vandaagFilters';
import { useZoekStore } from '@/store/zoek';
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
    (row.occurrence.venue?.name ?? row.event.venue.name).toUpperCase(),
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
  'Lezing',
  'Literatuur',
  'Film',
];

// Tone-mapping per mode — zelfde patroon als in EventListRow zodat de
// cat-titels op Vandaag dezelfde kleuren delen als de tag-pills op de
// rijen eronder.
const TONE: Record<
  'nacht' | 'dag',
  Record<'acid' | 'flare' | 'plum' | 'azure' | 'saffron' | 'cobalt', string>
> = {
  nacht: {
    acid: palette.acid,
    flare: palette.flare,
    plum: palette.plum,
    azure: palette.azure,
    saffron: palette.saffron,
    cobalt: palette.cobalt,
  },
  dag: {
    acid: palette.red,
    flare: palette.forest,
    plum: palette.cobalt,
    azure: '#8a5b00',
    saffron: '#9d6008',
    cobalt: '#1a3157',
  },
};

export default function Avond() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const [searchOpen, setSearchOpen] = useState(false);
  const openGuide = useZoekStore((s) => s.openGuide);

  // Elke tap op de tab-bar (ook re-tap op /avond zelf) sluit de
  // search-overlay. Anders zou je vanuit een andere tab terugkomen op
  // /avond met de overlay nog open — onverwacht, want de tab-bar-tap
  // signaleert "ik wil naar dit hoofdscherm".
  const navigation = useNavigation();
  useEffect(() => {
    const unsubscribe = navigation.addListener('tabPress' as never, () => {
      setSearchOpen(false);
    });
    return unsubscribe;
  }, [navigation]);

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
    lean: true,
  });
  // "Voor jou" — gepersonaliseerde aanbevelingen op basis van je save-
  // historie + gevolgde venues + vrienden-saves. Rail toont alleen
  // komende 7 dagen; de "more"-knop leidt naar `/voor-jou` met de
  // volle chronologische feed (infinite scroll). Lege array voor
  // uitgelogde users of users zonder profiel-input.
  const { data: forYouEvents } = useForYouEvents({ weekOnly: true });
  // Proactieve "Jouw avond vanavond"-curatie (alleen events binnen de
  // logische avond/nacht, gepersonaliseerd).
  const { data: tonightEvents } = useForYouEvents({ tonight: true });
  // Series + exhibitions delen één "Loopt nu"-strook bovenaan.
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
  const authed = Boolean(session?.user?.id);
  // Eigen saves + social-feed: input voor de "Planning"-rail onderaan
  // de pagina. Beide queries zijn al elders in de app actief, hier
  // herbenoemen we de cache zodat we mergen op occurrenceId.
  const { data: me } = useMe();
  const { data: mySaves } = useMySaves({ enabled: authed });
  const { data: socialFeed } = useSocialFeed({ enabled: authed });

  // Combined planning: eigen saves + saves van vrienden, gemerged per
  // occurrence. Per item komt jezelf voorop in de avatar-stack zodat het
  // direct duidelijk is dat je 'm zelf hebt gesaved. Toekomstige events
  // alleen, oudste eerst.
  const planningRail = useMemo(() => {
    if (!authed) return [];
    const myFirst = (me?.name?.split(' ')[0] || 'Jij').trim() || 'Jij';
    const map = new Map<
      string,
      {
        eventId: string;
        occurrenceId: string;
        event: SavedApiEvent | ApiFeedEvent;
        startsAt: string;
        endsAt: string | null;
        friends: { name: string; avatar: string | null }[];
      }
    >();
    for (const s of mySaves ?? []) {
      map.set(s.occurrenceId, {
        eventId: s.id,
        occurrenceId: s.occurrenceId,
        event: s,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        friends: [{ name: myFirst, avatar: me?.avatarUrl ?? null }],
      });
    }
    for (const f of socialFeed ?? []) {
      const startsAtStr =
        typeof f.occurrence.startsAt === 'string'
          ? f.occurrence.startsAt
          : new Date(f.occurrence.startsAt as unknown as string).toISOString();
      const endsAtStr =
        f.occurrence.endsAt == null
          ? null
          : typeof f.occurrence.endsAt === 'string'
            ? f.occurrence.endsAt
            : new Date(f.occurrence.endsAt as unknown as string).toISOString();
      const friendBadges = f.friendsSaved.map((fr) => ({
        name: fr.name,
        avatar: fr.avatarUrl,
      }));
      const existing = map.get(f.occurrence.id);
      if (existing) {
        existing.friends.push(...friendBadges);
      } else {
        map.set(f.occurrence.id, {
          eventId: f.eventId,
          occurrenceId: f.occurrence.id,
          event: f,
          startsAt: startsAtStr,
          endsAt: endsAtStr,
          friends: friendBadges,
        });
      }
    }
    const now = Date.now();
    return Array.from(map.values())
      .filter((m) => new Date(m.endsAt ?? m.startsAt).getTime() >= now)
      .sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
      );
  }, [authed, me, mySaves, socialFeed]);

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
  // Eénmalige expansie van events naar occurrence-rows. Hieronder
  // hebben 4 useMemo's de geëxpandeerde rows nodig — door 't hier te
  // cachen vermijden we 4× dezelfde flatMap over ~500-2000 events bij
  // elke re-render.
  const allRows = useMemo<OccurrenceRow[]>(
    () => (events ? expandToOccurrenceRows(events) : []),
    [events]
  );

  // Hoofd-lijst: vandaag's events (geen exhibitions), gefilterd op
  // tijd-blokken, vrienden en favoriete venues. Mode speelt geen rol
  // meer — die is puur stilistisch.
  const filtered = useMemo<OccurrenceRow[]>(() => {
    if (!events) return [];
    const needle = query.trim().toLowerCase();
    return allRows.filter((row) => {
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
      if (effectiveEndsAtMs(row.occurrence, row.event) < now) return false;
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
    return allRows
      .filter((row) => {
        if (row.event.kind === 'exhibition') return false;
        if (effectiveEndsAtMs(row.occurrence, row.event) < now) return false;
        return true;
      })
      .sort(
        (a, b) =>
          new Date(a.occurrence.startsAt).getTime() -
          new Date(b.occurrence.startsAt).getTime()
      );
  }, [events, allRows, now]);

  // Bredere pool voor de Featured-fallback — bevat óók exhibitions
  // (anders zou de hero in expo-mode alleen single-day events kunnen
  // tonen, terwijl de musea/galleries-rails wél exhibitions tonen).
  const featuredFallbackPool = useMemo<OccurrenceRow[]>(() => {
    if (!events) return [];
    return allRows
      .filter((row) => {
        if (effectiveEndsAtMs(row.occurrence, row.event) < now) return false;
        return true;
      })
      .sort(
        (a, b) =>
          new Date(a.occurrence.startsAt).getTime() -
          new Date(b.occurrence.startsAt).getTime()
      );
  }, [events, allRows, now]);

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
  }, [events, allRows, activeCats, onlyFriends, onlyFavorites, query]);

  // Rails voor 'uit'-mode — gebaseerd op `filtered` (OccurrenceRow[]
  // van vandaag, gefilterd op user-state). Per rail aanvullende
  // filter-criterium. Lege rails worden door de Rail-component
  // gewoonweg niet gerenderd.
  // "Voor jou" rail — eerste occurrence per event, score-volgorde
  // behouden (backend retourneert al op score gesorteerd).
  const railForYou = useMemo<OccurrenceRow[]>(() => {
    if (!forYouEvents || forYouEvents.length === 0) return [];
    const rows: OccurrenceRow[] = [];
    for (const event of forYouEvents) {
      const occ = event.occurrencesInRange?.[0];
      if (!occ) continue;
      rows.push({ id: `${event.id}::${occ.id}`, event, occurrence: occ });
    }
    return rows;
  }, [forYouEvents]);

  const tonightRows = useMemo<OccurrenceRow[]>(() => {
    if (!tonightEvents || tonightEvents.length === 0) return [];
    const rows: OccurrenceRow[] = [];
    for (const event of tonightEvents) {
      const occ = event.occurrencesInRange?.[0];
      if (!occ) continue;
      rows.push({ id: `${event.id}::${occ.id}`, event, occurrence: occ });
    }
    return rows;
  }, [tonightEvents]);

  // Eén gepersonaliseerde rail: "Jouw avond vanavond" zodra er ≥3 picks
  // voor vanavond zijn, anders de bredere "Voor jou · deze week".
  const showTonight = tonightRows.length >= 3;
  const personalRows = showTonight ? tonightRows : railForYou;

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
  // < 20:00 dezelfde dag). Cat-agnostisch maar excl. Film — films-
  // matinees krijgen hun eigen rail (zie railFilmOverdag) zodat ze
  // niet ook hier verschijnen (anders dubbelroken op één pagina).
  const railOverdag = useMemo(
    () =>
      filtered.filter(
        (r) =>
          r.event.category !== 'Film' &&
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
    return allRows.filter((row) => {
      const e = row.event;
      if (e.kind === 'exhibition') return false;
      if (isLongRunning(e.startsAt, e.endsAt)) return false;
      if (effectiveEndsAtMs(row.occurrence, row.event) < now) return false;
      const startMs = new Date(row.occurrence.startsAt).getTime();
      if (startMs < tomorrowWindow.fromMs || startMs >= tomorrowWindow.toMs) {
        return false;
      }
      if (!isDaytimeOccurrence(row.occurrence.startsAt, row.occurrence.endsAt)) {
        return false;
      }
      return true;
    });
  }, [events, allRows, now, tomorrowWindow.fromMs, tomorrowWindow.toMs]);
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
        {/* Hoofd-artikelen: alle featured events uit vandaag-events. */}
        {leads.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <FeaturedCarousel
              leads={leads}
              kicker={t('Onze keuze', 'Our pick')}
              locale={locale}
            />
          </View>
        )}

        {/* Rij 1 — grote banners (Gids · Voor jou · Net binnen · Zoek)
            onder de feature. */}
        <ShortcutsRow
          variant="big"
          onOpenGuide={openGuide}
          onOpenSearch={() => setSearchOpen(true)}
        />

        {/* Rij 2 — compacte categorie/ingang-knopjes. */}
        <ShortcutsRow
          variant="small"
          onOpenGuide={openGuide}
          onOpenSearch={() => setSearchOpen(true)}
        />

        {/* Eén gepersonaliseerde rail: "Jouw avond · vanavond" (uit-modus,
            ≥3 picks) óf de bredere "Voor jou · deze week". "Meer →" opent
            /voor-jou met de volle chronologische feed. Verbergt zich bij
            lege data. */}
        {!isLoading && !error && personalRows.length > 0 && (
          <View style={{ marginTop: -12 }}>
          <Rail
            kicker={
              showTonight
                ? t('Jouw avond · vanavond', 'Your night · tonight')
                : t('Voor jou · deze week', 'For you · this week')
            }
            moreLabel={t('Meer →', 'More →')}
            onMore={() => router.push('/voor-jou' as never)}
          >
            {personalRows.map((r) => (
              <RailEventCard
                key={r.id}
                event={r.event}
                occurrenceId={
                  r.occurrence.id.endsWith('::next')
                    ? undefined
                    : r.occurrence.id
                }
                occurrenceStartsAt={r.occurrence.startsAt}
                occurrenceEndsAt={r.occurrence.endsAt}
                occurrenceVenueName={r.occurrence.venue?.name ?? null}
                showDate={!showTonight}
                reason={r.event.reason}
              />
            ))}
          </Rail>
          </View>
        )}

        {/* Jouw favoriete venues — direct onder de Voor jou-rail zodat je
            volg-lijst snel bereikbaar is (was voorheen onderaan Vandaag). */}
        {followedVenues.length > 0 && (
          <Rail
            kicker={t('Jouw favoriete venues', 'Your favourite venues')}
            moreLabel={t('Alle venues →', 'All venues →')}
            onMore={() => router.push('/venues' as never)}
            cardWidth={SQUARE_CARD_WIDTH}
          >
            {followedVenues.map((v) => (
              <VenueSquareRailCard
                key={v.id}
                slug={v.slug}
                name={v.name}
                imageUrl={v.imageUrl}
              />
            ))}
          </Rail>
        )}

        {/* Festivals/series in 'uit', doorlopende tentoonstellingen in
            'expo'. Tussen Hero en cat-rails. Geen kop-label —
            visueel onderscheidt de strook zich genoeg door image-format
            en datum-range subline. */}
        <RunningStrip series={seriesList ?? []} exhibitionEvents={[]} />

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

        {/* Alle rails op één pagina. Lege rails worden door de Rail-
            component zelf weggelaten. Eerst de avond-rails (clubs/live/
            theater/film), daarna overdag + cultuur. */}
        {!isLoading && !error && (
          <>
            <Rail
              kicker={t('Vannacht in de clubs', 'Tonight in the clubs')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() => router.push('/clubs' as never)}
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
                  occurrenceVenueName={r.occurrence.venue?.name ?? null}
                />
              ))}
            </Rail>
            <Rail
              kicker={t('Live op de podia', 'Live on stage')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() => router.push('/live' as never)}
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
                  occurrenceVenueName={r.occurrence.venue?.name ?? null}
                />
              ))}
            </Rail>
            <Rail
              kicker={t('Theater & dans', 'Theatre & dance')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() => router.push('/theater' as never)}
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
                  occurrenceVenueName={r.occurrence.venue?.name ?? null}
                />
              ))}
            </Rail>
            <Rail
              kicker={t('Film vanavond', 'Film tonight')}
              moreLabel={t('Meer →', 'More →')}
              onMore={() => router.push('/films' as never)}
              cardWidth={FILM_CARD_WIDTH}
            >
              {railFilm.map((r) => (
                <FilmRailCard
                  key={r.id}
                  event={r.event}
                  occurrenceId={
                    r.occurrence.id.endsWith('::next') ? undefined : r.occurrence.id
                  }
                  occurrenceStartsAt={r.occurrence.startsAt}
                  occurrenceEndsAt={r.occurrence.endsAt}
                  occurrenceVenueName={r.occurrence.venue?.name ?? null}
                />
              ))}
            </Rail>
          </>
        )}

        {!isLoading && !error && (
          <>
            {/* Morgen-rail: alleen 's avonds laat — voor wie op de bank
                al wil checken wat morgen kan. */}
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
                    occurrenceVenueName={r.occurrence.venue?.name ?? null}
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
                  occurrenceVenueName={r.occurrence.venue?.name ?? null}
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
                  occurrenceVenueName={r.occurrence.venue?.name ?? null}
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

        {/* Empty-state alleen als er écht niets is: geen single-day
            events vandaag (filtered) én geen lopende cultuur (musea/
            galleries/literatuur). Anders kan een rail alsnog vol staan
            en zou de melding tegenstrijdig zijn. */}
        {!isLoading &&
          !error &&
          filtered.length === 0 &&
          expoEventsToday.length === 0 &&
          events && (
            <Animated.View entering={FadeIn.duration(220)}>
              <EmptyResults hasFilter={hasFilterActive} minHeight={240} />
            </Animated.View>
          )}


        {/* Favoriete venues, altijd zichtbaar — los van of er vandaag
            iets speelt. Komt na de agenda-banner omdat 't visueel
            buiten de "vandaag"-bubbel valt en als hub voor je
            volg-lijst dient (tap → venue-pagina met volledige
            programmering). */}
        {/* Jouw + vrienden-planning — events waar jij of een vriend(in)
            naartoe wil. Eigen saves + social-feed gemerged per occurrence.
            Per kaart toont de avatar-stack wie 'm geliked heeft. Boven
            de venues-rail want planning is persoonlijker en relevanter. */}
        {planningRail.length > 0 && (
          <Rail
            kicker={t('Jij en je vrienden', 'You and friends')}
            moreLabel={t('Alles →', 'See all →')}
            onMore={() => router.push('/going' as never)}
          >
            {planningRail.map((m) => (
              <PlanningRailCard key={m.occurrenceId} entry={m} />
            ))}
          </Rail>
        )}

      </ScrollView>
      <AppHeader title={t('Vandaag', 'Today')} />
      <SearchOverlay
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
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
  const base = `/event/${row.event.id}?source=avond`;
  if (row.occurrence.id.endsWith('::next')) return base;
  return `${base}&o=${row.occurrence.id}`;
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

/**
 * Card voor de "Op de planning"-rail onderaan Avond. Eén tegel per
 * occurrence: hero-image bovenaan, datum + tijd, titel, venue, en een
 * avatar-stack onderaan met "Jij + Roos & Milan +2"-style label. Tap
 * navigeert naar event-detail met de juiste occurrence-target.
 */
function PlanningRailCard({
  entry,
}: {
  entry: {
    eventId: string;
    occurrenceId: string;
    event: SavedApiEvent | ApiFeedEvent;
    startsAt: string;
    endsAt: string | null;
    friends: { name: string; avatar: string | null }[];
  };
}) {
  const roles = useRoles();
  const locale = useLocale();
  const { surface } = useRailCardStyles();
  const e = entry.event;
  // SavedApiEvent en ApiFeedEvent hebben beide `imageUrl` + `venue.{name,imageUrl}`.
  const eventImage = (e as { imageUrl?: string | null }).imageUrl ?? null;
  const venueRef = (
    e as { venue?: { name?: string; imageUrl?: string | null } }
  ).venue;
  const venueName = venueRef?.name ?? '';
  const thumb =
    eventImage ??
    venueRef?.imageUrl ??
    null;
  const d = new Date(entry.startsAt);
  const dateLabel = `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(d.getMonth(), locale).toLowerCase()}`;
  const time = rowTimeLabel(entry.startsAt, entry.endsAt, locale);

  const visible = entry.friends.slice(0, 3);
  const overflow = Math.max(0, entry.friends.length - visible.length);
  const totalTiles = visible.length + (overflow > 0 ? 1 : 0);
  const nameLabel = (() => {
    if (entry.friends.length === 0) return '';
    if (entry.friends.length === 1) return entry.friends[0].name;
    if (entry.friends.length === 2)
      return `${entry.friends[0].name} & ${entry.friends[1].name}`;
    return `${entry.friends[0].name} +${entry.friends.length - 1}`;
  })();

  return (
    <Pressable
      onPress={() =>
        router.push(
          `/event/${entry.eventId}?o=${entry.occurrenceId}&source=avond` as never
        )
      }
      style={planningCardStyles.card}
    >
      <View
        style={[
          planningCardStyles.imgWrap,
          { backgroundColor: surface.fallback },
        ]}
      >
        {thumb ? (
          <Image
            source={{ uri: thumb }}
            style={planningCardStyles.img}
            contentFit="cover"
          />
        ) : null}
      </View>
      <View style={planningCardStyles.body}>
        <Text
          numberOfLines={1}
          style={[planningCardStyles.kicker, { color: roles.accent }]}
        >
          {`${dateLabel} · ${time}`}
        </Text>
        <Text
          numberOfLines={2}
          style={[planningCardStyles.title, { color: roles.fg }]}
        >
          {e.title}
        </Text>
        <Text
          numberOfLines={1}
          style={[planningCardStyles.venue, { color: roles.fgMuted }]}
        >
          {venueName}
        </Text>
        {entry.friends.length > 0 && (
          <View style={planningCardStyles.friendsRow}>
            <View style={planningCardStyles.stack}>
              {visible.map((f, i) => (
                <View
                  key={`${f.name}-${i}`}
                  style={[
                    planningCardStyles.avatar,
                    {
                      left: i * 12,
                      zIndex: totalTiles - i,
                      borderColor: roles.bg,
                      backgroundColor: roles.bg,
                    },
                  ]}
                >
                  {f.avatar ? (
                    <Image
                      source={{ uri: f.avatar }}
                      style={planningCardStyles.avatarImg}
                      contentFit="cover"
                    />
                  ) : (
                    <Text
                      style={[
                        planningCardStyles.avatarInitial,
                        { color: roles.fgMuted },
                      ]}
                    >
                      {(f.name.trim()[0] ?? '?').toUpperCase()}
                    </Text>
                  )}
                </View>
              ))}
              {overflow > 0 && (
                <View
                  style={[
                    planningCardStyles.avatar,
                    {
                      left: visible.length * 12,
                      zIndex: 0,
                      borderColor: surface.bg,
                      backgroundColor: roles.bg,
                    },
                  ]}
                >
                  <Text
                    style={[
                      planningCardStyles.avatarInitial,
                      { color: roles.fgMuted },
                    ]}
                  >
                    +{overflow}
                  </Text>
                </View>
              )}
            </View>
            <Text
              numberOfLines={1}
              style={[planningCardStyles.friendsLabel, { color: roles.fgMuted }]}
            >
              {nameLabel}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const planningCardStyles = StyleSheet.create({
  card: {
    width: 220,
  },
  imgWrap: {
    width: '100%',
    height: 130,
    borderRadius: 10,
    overflow: 'hidden',
  },
  img: {
    width: '100%',
    height: '100%',
  },
  body: {
    paddingTop: 8,
    gap: 4,
  },
  kicker: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: -0.1,
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
    lineHeight: 18,
    marginTop: 2,
  },
  venue: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  friendsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  stack: {
    height: 24,
    minWidth: 24,
    position: 'relative',
  },
  avatar: {
    position: 'absolute',
    top: 0,
    width: 24,
    height: 24,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: {
    width: '100%',
    height: '100%',
  },
  avatarInitial: {
    fontFamily: fontFamily.bold,
    fontSize: 10,
    letterSpacing: -0.1,
  },
  friendsLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
});

/** Eerste shortcut-banner: ingang naar de conversationele gids. Zelfde
    bgLift-vlak als de rest, maar met een accent-border zodat 'ie subtiel
    vooraan opvalt zonder de hele rij te domineren. */
function GidsBanner({ onPress }: { onPress: () => void }) {
  const roles = useRoles();
  const t = useT();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.shortcutBtn,
        { backgroundColor: roles.bgLift, borderWidth: 1.5, borderColor: roles.accent },
      ]}
    >
      <Ionicons name="sparkles" size={30} color={roles.accent} />
      <Text style={[styles.shortcutKicker, { color: roles.fgMuted }]}>
        {t('Gids', 'Guide')}
      </Text>
      <Text style={[styles.shortcutTitle, { color: roles.fg }]}>
        {t('Vraag Andreas', 'Ask Andreas')}
      </Text>
    </Pressable>
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
        {/* Vertical gradient: top transparant zodat de foto fris blijft,
            naar onderen donker voor leesbaarheid van title + meta. Nacht
            iets diepere bottom-stop dan dag (paper-bg verdraagt zachtere
            tint). */}
        <LinearGradient
          colors={
            isNacht
              ? [
                  'rgba(10,10,11,0)',
                  'rgba(10,10,11,0)',
                  'rgba(10,10,11,0.55)',
                  'rgba(10,10,11,0.85)',
                ]
              : [
                  'rgba(0,0,0,0)',
                  'rgba(0,0,0,0)',
                  'rgba(0,0,0,0.45)',
                  'rgba(0,0,0,0.72)',
                ]
          }
          locations={[0, 0.35, 0.7, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
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
            <View style={styles.featuredTitleBlock}>
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
    </View>
  );
}

function ShortcutsRow({
  variant,
  onOpenGuide,
  onOpenSearch,
}: {
  /** 'big' = de vier grote banners (boven de feature); 'small' = de
      compacte categorie-knopjes (onder de feature). De feature ertussen
      geeft rust tussen de twee knop-groepen. */
  variant: 'big' | 'small';
  onOpenGuide: () => void;
  onOpenSearch: () => void;
}) {
  // Gids-banner alleen tonen aan gebruikers met toegang (opt-in via admin).
  const { data: me } = useMe();
  const guideEnabled = me?.guideEnabled ?? false;
  const t = useT();
  const roles = useRoles();
  const scrollRef = useRef<ScrollView>(null);
  const navigation = useNavigation();
  // Re-tap op de Vandaag-tab → rij terug naar begin.
  useEffect(() => {
    const unsubscribe = navigation.addListener('tabPress' as never, () => {
      if (navigation.isFocused()) {
        scrollRef.current?.scrollTo({ x: 0, animated: true });
      }
    });
    return unsubscribe;
  }, [navigation]);

  if (variant === 'big') {
    return (
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.shortcutScroller}
        snapToInterval={122}
        snapToAlignment="start"
        decelerationRate="fast"
      >
        {guideEnabled ? <GidsBanner onPress={onOpenGuide} /> : null}
        <VoorJouBanner />
        <NewBanner />
        <SearchBanner onPress={onOpenSearch} />
      </ScrollView>
    );
  }

  // Compacte categorie/ingang-knopjes (icoon boven label).
  const small: Array<{
    key: string;
    icon: ReactNode;
    label: string;
    onPress: () => void;
  }> = [
    { key: 'films', icon: <Ionicons name="film-outline" size={20} color={roles.accent} />, label: t('Films', 'Films'), onPress: () => router.push('/films' as never) },
    { key: 'clubs', icon: <Ionicons name="disc-outline" size={20} color={roles.accent} />, label: t('Clubs', 'Clubs'), onPress: () => router.push('/clubs' as never) },
    { key: 'live', icon: <Ionicons name="musical-notes-outline" size={20} color={roles.accent} />, label: t('Live', 'Live'), onPress: () => router.push('/live' as never) },
    { key: 'theater', icon: <MaterialCommunityIcons name="drama-masks" size={20} color={roles.accent} />, label: t('Theater', 'Theatre'), onPress: () => router.push('/theater' as never) },
    { key: 'kaart', icon: <Ionicons name="map-outline" size={20} color={roles.accent} />, label: t('Kaart', 'Map'), onPress: () => router.push('/kaart' as never) },
    { key: 'friends', icon: <Ionicons name="people-outline" size={20} color={roles.accent} />, label: t('Friends', 'Friends'), onPress: () => router.push('/going' as never) },
    { key: 'vibes', icon: <MaterialCommunityIcons name="cards-outline" size={20} color={roles.accent} />, label: t('Vibes', 'Vibes'), onPress: () => router.push('/op-gevoel' as never) },
  ];
  void onOpenSearch;
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.shortcutScrollerSmall}
    >
      {small.map((s) => (
        <SmallShortcut key={s.key} icon={s.icon} label={s.label} onPress={s.onPress} />
      ))}
    </ScrollView>
  );
}

function VoorJouBanner() {
  const roles = useRoles();
  const t = useT();
  return (
    <Pressable
      onPress={() => router.push('/voor-jou' as never)}
      style={[styles.shortcutBtn, { backgroundColor: roles.bgLift }]}
    >
      <Ionicons name="heart-outline" size={30} color={roles.accent} />
      <Text style={[styles.shortcutKicker, { color: roles.fgMuted }]}>
        {t('Voor jou', 'For you')}
      </Text>
      <Text style={[styles.shortcutTitle, { color: roles.fg }]}>
        {t('Aanbevolen', 'Recommended')}
      </Text>
    </Pressable>
  );
}

function NewBanner() {
  const roles = useRoles();
  const t = useT();
  const since = useNewBadgeSince();
  const { data: events } = useNewArrivalsSince(since);
  // Badge telt events nieuwer dan je laatste /new-bezoek → zakt naar 0
  // zodra je de pagina hebt gezien, loopt pas weer op bij nieuwe
  // aanwinsten. Bij since=null (eerste sessie) staat de query op pauze
  // → 0, geen badge.
  const count = events?.length ?? 0;
  return (
    <Pressable
      onPress={() => router.push('/new' as never)}
      style={[
        styles.shortcutBtn,
        { backgroundColor: roles.bgLift },
      ]}
    >
      <View style={styles.shortcutIconRow}>
        <Ionicons name="flash-outline" size={30} color={roles.accent} />
        {count > 0 ? (
          <View
            style={[
              styles.shortcutInlineBadge,
              { backgroundColor: roles.accent },
            ]}
          >
            <Text
              style={[styles.shortcutBadgeText, { color: roles.onAccent }]}
              numberOfLines={1}
            >
              {count > 99 ? '99+' : count}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.shortcutKicker, { color: roles.fgMuted }]}>
        {t('Net binnen', 'Just in')}
      </Text>
      <Text style={[styles.shortcutTitle, { color: roles.fg }]}>
        {t('Nieuwste aanwinsten', 'Latest additions')}
      </Text>
    </Pressable>
  );
}

/** Grote zoek-banner — vervangt het losse zoekveld; opent de SearchOverlay
    (globale cross-zoek over venues + events). */
function SearchBanner({ onPress }: { onPress: () => void }) {
  const roles = useRoles();
  const t = useT();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.shortcutBtn, { backgroundColor: roles.bgLift }]}
    >
      <Ionicons name="search-outline" size={30} color={roles.accent} />
      <Text style={[styles.shortcutKicker, { color: roles.fgMuted }]}>
        {t('Zoek', 'Search')}
      </Text>
      <Text style={[styles.shortcutTitle, { color: roles.fg }]}>
        {t('Venues & events', 'Venues & events')}
      </Text>
    </Pressable>
  );
}

/** Compacte tweede-rij-banner: alleen icoon + kicker, pill-vorm. */
function SmallShortcut({
  icon,
  label,
  onPress,
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
}) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.shortcutBtnSmall, { backgroundColor: roles.bgLift }]}
    >
      {icon}
      <Text style={[styles.shortcutKicker, { color: roles.fg }]} numberOfLines={1}>
        {label}
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
  // Title + meta tegen elkaar i.p.v. via featuredBottom's gap:12 +
  // marginTop:10 — visueel komen ze nu als één blok in, met enkel 4px
  // ruimte tussen titel en datum.
  featuredTitleBlock: { gap: 4 },
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
  shortcutScroller: {
    paddingHorizontal: 22,
    gap: 10,
    marginTop: 14,
    marginBottom: 10,
  },
  // Tweede rij — compacte icoon+kicker-knopjes, dicht onder de feature
  // (kleine marginTop; bij één hero-image is er anders te veel lucht).
  shortcutScrollerSmall: {
    paddingHorizontal: 22,
    gap: 8,
    marginTop: 2,
    marginBottom: 18,
  },
  // Compacte pill: icoon + label naast elkaar.
  shortcutBtnSmall: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  shortcutBtn: {
    // Fixed-width zodat ~3 kaarten vol in beeld passen op een 390px
    // iPhone, met de 4e als peek-hint dat er nog meer is. Eerder
    // hadden we 155 (2 vol) maar dan moest je veel swipen om alles
    // te zien.
    width: 112,
    alignItems: 'flex-start',
    gap: 8,
    padding: 12,
    borderRadius: 14,
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
  // Count-badge naast het shortcut-icoon — alleen voor de "Nieuw"-
  // kaart wanneer er items zijn binnen gekomen sinds vorige sessie.
  // Pill-rond, accent-bg, cap op "99+".
  shortcutIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  shortcutInlineBadge: {
    minWidth: 24,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutBadgeText: {
    fontFamily: fontFamily.displayBold,
    fontSize: 12,
    letterSpacing: -0.1,
    lineHeight: 14,
  },
});
