import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
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
import { EventListRow } from '@/components/EventListRow';
import { RefreshBanner } from '@/components/RefreshBanner';
import { RunningExhibitions } from '@/components/RunningExhibitions';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent } from '@/lib/api';
import {
  eventImageUrl,
  CATEGORY_TICK,
  dowFull,
  dowUpper,
  effectiveEndsAtMs,
  expandToOccurrenceRows,
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
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { useEventGenres, useEvents, useFriends } from '@/lib/queries';
import { useSession } from '@/lib/authClient';
import { useMode, useRoles } from '@/store/mode';
import {
  isSavedVandaagSearchActive,
  type SavedVandaagSearch,
  useAddSavedVandaagSearch,
  useRemoveSavedVandaagSearch,
  useSavedVandaagSearches,
} from '@/store/savedVandaagSearches';
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
  return [dow, rowTimeLabel(row.occurrence.startsAt, row.occurrence.endsAt, locale), row.event.venue.name.toUpperCase(), price]
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
  const t = useT();
  const locale = useLocale();
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

  // Filter-keuze (zoek + vrienden + favorieten + tijd-blokken) wordt
  // persistent bewaard tussen sessies via een Zustand-store. URL-state
  // was onnodig — de Vandaag-tab is geen deeplink-target voor filters.
  const query = useVandaagFilters((s) => s.query);
  const onlyFriends = useVandaagFilters((s) => s.onlyFriends);
  const onlyFavorites = useVandaagFilters((s) => s.onlyFavorites);
  const activeBlocks = useVandaagFilters((s) => s.activeBlocks);
  const activeCats = useVandaagFilters((s) => s.activeCats);
  const activeGenres = useVandaagFilters((s) => s.activeGenres);
  const setQuery = useVandaagFilters((s) => s.setQuery);
  const setOnlyFriends = useVandaagFilters((s) => s.setOnlyFriends);
  const setOnlyFavorites = useVandaagFilters((s) => s.setOnlyFavorites);
  const setActiveBlocks = useVandaagFilters((s) => s.setActiveBlocks);
  const setActiveCats = useVandaagFilters((s) => s.setActiveCats);
  const setActiveGenres = useVandaagFilters((s) => s.setActiveGenres);
  const toggleBlock = useVandaagFilters((s) => s.toggleBlock);
  const { data: session } = useSession();
  const { data: friends } = useFriends({
    enabled: Boolean(session?.user?.id),
  });
  const showFriendsChip = (friends?.length ?? 0) > 0;
  const onToggleFriends = () => setOnlyFriends(!onlyFriends);
  const onToggleFavorites = () => setOnlyFavorites(!onlyFavorites);
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
      if (activeCats.length > 0 && !activeCats.includes(e.category)) {
        return false;
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
    activeGenres,
    onlyFriends,
    onlyFavorites,
    query,
  ]);

  // Toon de favorieten-chip alleen als de gebruiker minstens één venue
  // volgt — anders filter je naar 0 events en is 't onbegrijpelijk.
  const showFavoritesChip = useMemo(
    () => Boolean(events?.some((e) => e.venueFollowed)),
    [events]
  );

  // Lopende tentoonstellingen — altijd zichtbaar als losse strook.
  // Bestaat uit alle exhibitions die nu lopen of binnenkort openen
  // (de events-query haalt vanaf vandaag op zonder upper bound).
  // Gelijk aan wat Agenda toont, zodat beide tabs dezelfde set
  // doorlopende-events laten zien.
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
      if (new Date(row.occurrence.startsAt).getTime() >= todayWindow.toMs) {
        return false;
      }
      return true;
    });
  }, [events, now, todayWindow.toMs]);

  // Hoofd-artikelen: alle featured events uit vandaag-events (NIET
  // filter-afhankelijk). Geen featured? Eerste rij als enige hero.
  // Dedupe op event-id zodat een featured event met meerdere
  // occurrences vandaag maar één hero-card krijgt.
  const leads = useMemo<OccurrenceRow[]>(() => {
    if (allToday.length === 0) return [];
    const featuredRows = allToday.filter((r) => r.event.featured);
    if (featuredRows.length === 0) return [allToday[0]];
    const seen = new Set<string>();
    return featuredRows.filter((r) => {
      if (seen.has(r.event.id)) return false;
      seen.add(r.event.id);
      return true;
    });
  }, [allToday]);

  // Cat-secties: groepeer events per categorie (zelfde volgorde als
  // CATEGORIES_ORDER). Featured-events bovenaan in elke sublijst, dan
  // gewone rows op startsAt; eerste rij krijgt een ster. Het lead-
  // event komt hier ook in voor — Diederik wil dat 'ie ook in de lijst
  // staat zodat je 'm niet over het hoofd ziet als je voorbij de hero
  // scrollt. Wel deduplicaten op event-id zodat hetzelfde event met
  // meerdere occurrences vandaag niet meer dan één rij krijgt.
  const restByCategory = useMemo(() => {
    const seenEvents = new Set<string>();
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
      // Wanneer er een categorie-filter actief is, alleen die secties
      // tonen — anders filter-keuze niet zichtbaar.
      if (activeCats.length > 0 && !activeCats.includes(category)) return [];
      const items = map.get(category);
      return items && items.length > 0 ? [{ category, items }] : [];
    });
  }, [filtered, activeCats]);

  // Hero-tekst: "{dag} {datum} op de agenda" met de datum in
  // accent-kleur. Niet filter-afhankelijk; geen count meer in deze
  // copy (die zat nu boven de feature en voelde dubbelop).
  const heroParts = useMemo(() => {
    const d = todayWindow.refDate;
    return {
      day: dowFull(d.getDay(), locale).toLowerCase(),
      date: `${d.getDate()} ${monthFull(d.getMonth(), locale)}`,
    };
  }, [todayWindow.refDate, locale]);

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
            NIET filter-afhankelijk — staan bovenaan onafhankelijk van
            wat je beneden filtert. Bij meerdere featured: horizontale
            page-snap carousel met dots-indicator. Bij één: gewone kaart. */}
        {leads.length > 0 && (
          <FeaturedCarousel
            leads={leads}
            kicker={t('Onze keuze', 'Our pick')}
            locale={locale}
          />
        )}

        {/* Kaart-CTA — onafhankelijk van de filter. */}
        <KaartBanner />

        {/* Doorlopend te zien (musea/galleries) — altijd zichtbaar als
            losse strook, niet beïnvloed door de tijd-blok filter. */}
        <RunningExhibitions events={runningExhibitions} />

        {/* Hero — divider + "{dag} {datum}" met datum in primair
            (accent). Eén regel, kort. Niet filter-afhankelijk. */}
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

        {/* Filter-rij zit direct boven de cat-secties — zelfde patroon
            als op Agenda voor consistente leercurve. Search + filter-
            knop + vrienden + favorieten + saved-search chips. */}
        <AvondChipRow
          query={query}
          onQuery={setQuery}
          onlyFriends={onlyFriends}
          onToggleFriends={onToggleFriends}
          showFriendsChip={showFriendsChip}
          onlyFavorites={onlyFavorites}
          onToggleFavorites={onToggleFavorites}
          showFavoritesChip={showFavoritesChip}
          activeBlocks={activeBlocks}
          onToggleBlock={onToggleBlock}
          activeCats={activeCats}
          activeGenres={activeGenres}
          onSetBlocks={setActiveBlocks}
          onSetFriends={setOnlyFriends}
          onSetFavorites={setOnlyFavorites}
          onSetCats={setActiveCats}
          onSetGenres={setActiveGenres}
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
        {!isLoading && !error && (
          <Animated.View entering={FadeIn.duration(220)}>
            {filtered.length === 0 && events && (
              <EmptyResults
                hasFilter={
                  activeBlocks.length > 0 ||
                  activeCats.length > 0 ||
                  activeGenres.length > 0 ||
                  onlyFriends ||
                  onlyFavorites ||
                  query.trim().length > 0
                }
                minHeight={240}
              />
            )}
            {restByCategory.map(({ category, items }) => (
              <View key={category}>
                <SectionTitle
                  title={translateCategory(category, locale)}
                  titleColor={TONE[mode][CATEGORY_TICK[category]]}
                  meta={t('Meer →', 'More →')}
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
      <AppHeader title={t('Vandaag', 'Today')} />
    </View>
  );
}

function AvondChipRow({
  query,
  onQuery,
  onlyFriends,
  onToggleFriends,
  showFriendsChip,
  onlyFavorites,
  onToggleFavorites,
  showFavoritesChip,
  activeBlocks,
  onToggleBlock,
  activeCats,
  activeGenres,
  onSetBlocks,
  onSetFriends,
  onSetFavorites,
  onSetCats,
  onSetGenres,
}: {
  query: string;
  onQuery: (q: string) => void;
  onlyFriends: boolean;
  onToggleFriends: () => void;
  showFriendsChip: boolean;
  onlyFavorites: boolean;
  onToggleFavorites: () => void;
  showFavoritesChip: boolean;
  activeBlocks: TimeBlock[];
  onToggleBlock: (b: TimeBlock) => void;
  activeCats: ApiEvent['category'][];
  activeGenres: string[];
  onSetBlocks: (next: TimeBlock[]) => void;
  onSetFriends: (next: boolean) => void;
  onSetFavorites: (next: boolean) => void;
  onSetCats: (next: ApiEvent['category'][]) => void;
  onSetGenres: (next: string[]) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const [focused, setFocused] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const saved = useSavedVandaagSearches();
  const removeSaved = useRemoveSavedVandaagSearch();

  // Search-pill: collapsable. Open zodra hij focus heeft of er tekst in
  // staat. Width animeert van klein-icoon naar input-wide.
  const open = focused || query.length > 0;
  const COLLAPSED_W = 44;
  const MIN_OPEN_W = 130;
  const MAX_OPEN_W = 260;
  const textWidthEstimate = 44 + query.length * 8 + 18;
  const width = !open
    ? COLLAPSED_W
    : Math.min(MAX_OPEN_W, Math.max(MIN_OPEN_W, textWidthEstimate));

  const onIconPress = () => {
    if (open) {
      onQuery('');
      inputRef.current?.blur();
    } else {
      inputRef.current?.focus();
    }
  };

  const filterCount =
    activeBlocks.length + activeCats.length + activeGenres.length;
  const filterActive = filterCount > 0;
  const current = {
    q: query,
    vr: onlyFriends,
    fv: onlyFavorites,
    tb: activeBlocks,
    cats: activeCats,
    gn: activeGenres,
  };

  const applySaved = (s: SavedVandaagSearch) => {
    const active = isSavedVandaagSearchActive(s, current);
    if (active) {
      onQuery('');
      onSetFriends(false);
      onSetFavorites(false);
      onSetBlocks([]);
      onSetCats([]);
      onSetGenres([]);
      return;
    }
    onQuery(s.q);
    onSetFriends(s.vr);
    onSetFavorites(s.fv);
    onSetBlocks(s.tb);
    onSetCats(s.cats ?? []);
    onSetGenres(s.gn ?? []);
  };

  const onLongPressSaved = (s: SavedVandaagSearch) => {
    Alert.alert(
      t('Verwijderen', 'Remove'),
      t(
        `"${s.name}" verwijderen uit je opgeslagen filters?`,
        `Remove "${s.name}" from your saved filters?`
      ),
      [
        { text: t('Annuleren', 'Cancel'), style: 'cancel' },
        {
          text: t('Verwijder', 'Remove'),
          style: 'destructive',
          onPress: () => removeSaved(s.id),
        },
      ]
    );
  };

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={[
            styles.searchChip,
            {
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
              borderColor: isNacht ? '#2a2a2d' : palette.paper,
              width,
              // Collapsed = perfect rondje met icoon gecentreerd; expanded
              // = pill met padding voor de input ernaast.
              paddingHorizontal: open ? 14 : 0,
              gap: open ? 8 : 0,
              justifyContent: open ? 'flex-start' : 'center',
            },
          ]}
        >
          <Pressable onPress={onIconPress} hitSlop={6} style={styles.searchIcon}>
            <Ionicons
              name={open ? 'close' : 'search'}
              size={18}
              color={roles.fgMuted}
            />
          </Pressable>
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={onQuery}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={open ? t('ZOEK', 'SEARCH') : ''}
            placeholderTextColor={roles.fgPlaceholder}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
            style={[
              styles.searchInput,
              {
                color: roles.fg,
                // Collapsed: input neemt geen ruimte → icoon blijft
                // gecentreerd. Open: pakt z'n flex-ruimte naast het icoon.
                flex: open ? 1 : 0,
                width: open ? undefined : 0,
              },
            ]}
          />
        </View>
        <Pressable
          onPress={() => setFilterOpen(true)}
          style={[
            styles.catChip,
            {
              borderColor: filterActive
                ? roles.fg
                : isNacht
                  ? '#2a2a2d'
                  : palette.paper,
              backgroundColor: filterActive
                ? roles.fg
                : isNacht
                  ? palette.noir2
                  : palette.paper2,
              flexDirection: 'row',
              gap: 4,
            },
          ]}
        >
          <Ionicons
            name="options-outline"
            size={12}
            color={filterActive ? roles.bg : roles.fgMuted}
          />
          <Text
            style={[
              styles.catChipText,
              { color: filterActive ? roles.bg : roles.fgMuted },
            ]}
          >
            {filterActive
              ? `${t('Filter', 'Filter')} · ${filterCount}`
              : t('Filter', 'Filter')}
          </Text>
        </Pressable>
        {showFriendsChip && (
          <Pressable
            accessibilityLabel={
              onlyFriends
                ? t('Toon alle events', 'Show all events')
                : t('Alleen events met vrienden', 'Only events with friends')
            }
            onPress={onToggleFriends}
            style={[
              styles.iconToggle,
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
        {showFavoritesChip && (
          <Pressable
            accessibilityLabel={
              onlyFavorites
                ? t('Toon alle events', 'Show all events')
                : t(
                    'Alleen events bij favoriete venues',
                    'Only events at favourite venues'
                  )
            }
            onPress={onToggleFavorites}
            style={[
              styles.iconToggle,
              {
                borderColor: onlyFavorites
                  ? roles.fg
                  : isNacht
                    ? '#2a2a2d'
                    : palette.paper,
                backgroundColor: onlyFavorites
                  ? roles.fg
                  : isNacht
                    ? palette.noir2
                    : palette.paper2,
              },
            ]}
          >
            <Ionicons
              name={onlyFavorites ? 'heart' : 'heart-outline'}
              size={14}
              color={onlyFavorites ? roles.bg : roles.fgMuted}
            />
          </Pressable>
        )}
        {saved.map((s) => {
          const active = isSavedVandaagSearchActive(s, current);
          return (
            <Pressable
              key={s.id}
              onPress={() => applySaved(s)}
              onLongPress={() => onLongPressSaved(s)}
              delayLongPress={400}
              style={[
                styles.catChip,
                {
                  borderColor: active
                    ? roles.accent
                    : isNacht
                      ? '#2a2a2d'
                      : palette.paper,
                  backgroundColor: active
                    ? `${isNacht ? palette.acid : palette.red}1f`
                    : isNacht
                      ? palette.noir2
                      : palette.paper2,
                  flexDirection: 'row',
                  gap: 4,
                },
              ]}
            >
              <Ionicons
                name="bookmark"
                size={11}
                color={active ? roles.accent : roles.fgMuted}
              />
              <Text
                style={[
                  styles.catChipText,
                  { color: active ? roles.accent : roles.fgMuted },
                ]}
              >
                {s.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Modal
        visible={filterOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setFilterOpen(false)}
      >
        <AvondFilterSheet
          query={query}
          onlyFriends={onlyFriends}
          onlyFavorites={onlyFavorites}
          activeBlocks={activeBlocks}
          activeCats={activeCats}
          activeGenres={activeGenres}
          showFriendsChip={showFriendsChip}
          showFavoritesChip={showFavoritesChip}
          onSetFriends={onSetFriends}
          onSetFavorites={onSetFavorites}
          onToggleBlock={onToggleBlock}
          onSetBlocks={onSetBlocks}
          onSetCats={onSetCats}
          onSetGenres={onSetGenres}
          onClose={() => setFilterOpen(false)}
        />
      </Modal>
    </>
  );
}

export function AvondFilterSheet({
  query,
  onlyFriends,
  onlyFavorites,
  activeBlocks,
  activeCats,
  activeGenres,
  showFriendsChip,
  showFavoritesChip,
  onSetFriends,
  onSetFavorites,
  onToggleBlock,
  onSetBlocks,
  onSetCats,
  onSetGenres,
  onClose,
}: {
  query: string;
  onlyFriends: boolean;
  onlyFavorites: boolean;
  activeBlocks: TimeBlock[];
  activeCats: ApiEvent['category'][];
  activeGenres: string[];
  showFriendsChip: boolean;
  showFavoritesChip: boolean;
  onSetFriends: (next: boolean) => void;
  onSetFavorites: (next: boolean) => void;
  onToggleBlock: (b: TimeBlock) => void;
  onSetBlocks: (next: TimeBlock[]) => void;
  onSetCats: (next: ApiEvent['category'][]) => void;
  onSetGenres: (next: string[]) => void;
  onClose: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const locale = useLocale();
  const isNacht = mode === 'nacht';
  const t = useT();
  const timeBlocks = useTimeBlocks();
  const addSaved = useAddSavedVandaagSearch();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
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
  const toggleGenre = (g: string) => {
    if (activeGenres.includes(g))
      onSetGenres(activeGenres.filter((x) => x !== g));
    else onSetGenres([...activeGenres, g]);
  };

  const filterCount =
    activeBlocks.length +
    activeCats.length +
    activeGenres.length +
    (onlyFriends ? 1 : 0) +
    (onlyFavorites ? 1 : 0);

  const onClearAll = () => {
    onSetFriends(false);
    onSetFavorites(false);
    onSetBlocks([]);
    onSetCats([]);
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
                      onPress={() => toggleGenre(b.genre)}
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

        {(showFriendsChip || showFavoritesChip) && (
          <>
            <Text
              style={[
                styles.sheetSectionHead,
                { color: roles.fgMuted, marginTop: 22 },
              ]}
            >
              {t('Persoonlijk', 'Personal')}
            </Text>
            <View style={styles.sheetWrap}>
              {showFriendsChip && (
                <SheetChip
                  label={t('Vrienden', 'Friends')}
                  active={onlyFriends}
                  onPress={() => onSetFriends(!onlyFriends)}
                />
              )}
              {showFavoritesChip && (
                <SheetChip
                  label={t('Favoriete venues', 'Favourite venues')}
                  active={onlyFavorites}
                  onPress={() => onSetFavorites(!onlyFavorites)}
                />
              )}
            </View>
          </>
        )}
      </ScrollView>

      {saveOpen ? (
        <View
          style={[
            styles.sheetFooter,
            { borderTopColor: roles.bgChip, paddingBottom: 16 },
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
            onPress={onSave}
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
            { borderTopColor: roles.bgChip, paddingBottom: 16 },
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
            onPress={() => setSaveOpen(true)}
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
      onPress={onPress}
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
  const { event, occurrence } = row;
  const locale = useLocale();
  const rawFriends = occurrence.friendsSaved ?? event.friendsSaved ?? [];
  const friends = rawFriends.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  // Op Vandaag laten we de categorie-tag weg in de rij — die staat
  // al in de sectie-titel erboven. Ster + genre/series/friends
  // blijven; tick-kleur volgt nog steeds het thema.
  return (
    <EventListRow
      thumb={eventImageUrl(event) ?? ''}
      title={event.title}
      venue={formatMetaForRow(row, locale)}
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

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Hero — divider + "{dag} {datum} op de agenda" in display-font,
  // datum in accent. Geen mono-kicker meer. Strak op de
  // exhibitions-strook erboven.
  heroDivider: {
    marginHorizontal: 22,
    marginTop: 8,
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

  // Chip-row — zelfde patroon als Agenda's ChipRow.
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 22,
    paddingVertical: 6,
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
    marginBottom: 20,
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
