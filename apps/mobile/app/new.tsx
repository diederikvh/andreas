/**
 * "Andreas ✕ Nieuw" — events die sinds de vorige app-sessie nieuw
 * gescraped zijn. Toegankelijk via 'n shortcut-kaartje op /avond. Het
 * "since"-tijdvenster komt uit `useSessionTimestamps.previous`:
 * zodra je 'n nieuwe sessie start (>30min weg geweest) schuift
 * previous naar de timestamp van je vórige open en zie je alles dat
 * de scrapers in die tussentijd hebben binnen gehaald.
 */
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { SwipeableRow } from '@/components/SwipeableRow';
import { FILTER_ROW_HEIGHT, FilterChip } from '@/components/FilterChip';
import { EventListRow } from '@/components/EventListRow';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SpinningCross } from '@/components/SpinningCross';
import { useIsRegistered, useSession } from '@/lib/authClient';
import {
  LANES,
  markNewSeenOnServer,
  type ApiEvent,
  type Lane,
} from '@/lib/api';
import {
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  dowMixed,
  eventImageUrl,
  monthShort,
  rowTimeLabel,
  translateCategory,
} from '@/lib/eventDisplay';
import { softTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import {
  useNewArrivals,
  useToggleDismiss,
  useToggleSave,
} from '@/lib/queries';
import type { BadgeTone } from '@/lib/types';
import {
  TASTE_NUDGE_THRESHOLD,
  useNewFilters,
} from '@/store/newFilters';
import { useSessionTimestamps } from '@/store/sessionTimestamps';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/** Eén baan-sectie in de lijst; `onbekend` is de restbak. */
type LaneSection = {
  lane: Lane | 'onbekend';
  data: ApiEvent[];
  /** In welke lading deze sectie zit. 0 is wat je bij het openen zag. */
  batch: number;
  /** Eerste sectie van een nieuwe lading: die krijgt een scheiding. */
  batchStart: boolean;
};

/**
 * Hoeveel er per lading binnenkomt.
 *
 * Was 15, met een knop die de rest ophaalde. Dat cijfer kwam uit "de
 * dagpagina moet áf kunnen", en dat blijft waar -- maar 15 is te weinig
 * om een zaterdag mee door te komen en de knop maakte het erger dan de
 * cap zelf.
 */
const PAGE = 40;

/** Waar de server ophoudt (`/events/new`). Daarboven blijven vragen geeft
    elke keer dezelfde lijst terug, en dan blijft de scroll-trigger vuren. */
const SERVER_MAX = 600;

export default function NewScreen() {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const insets = useSafeAreaInsets();
  const t = useT();
  const qc = useQueryClient();

  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const registered = useIsRegistered();
  // Markeer de pagina als gezien, zodat de teller op het app-icoon en de
  // stip in het Meer-menu naar nul zakken. Raakt de lijst hierboven niet
  // — die hangt aan `previous`, niet aan dit bezoek-moment.
  //
  // Bij focus én bij blur. Focus omdat kíjken genoeg is: het icoon hoort
  // niet nog een getal te tonen terwijl je de pagina open hebt. Blur
  // omdat de grens daarmee opschuift naar het moment dat je wegging, en
  // niet naar dat je binnenkwam.
  useFocusEffect(
    useCallback(() => {
      useSessionTimestamps.getState().markNewSeen();
      if (registered) void markNewSeenOnServer();
      return () => {
        useSessionTimestamps.getState().markNewSeen();
        // Ook serverkant, zodat het venster een nieuwe telefoon
        // overleeft. Alleen zinvol met een echt account — anoniem leeft
        // je identiteit toch op dit toestel.
        if (registered) void markNewSeenOnServer();
      };
    }, [registered])
  );

  // Baan-voorkeur (film/theater/live/club/kunst). Leeg = alles. Staat in
  // een persisted store, want dit is een voorkeur en geen sessie-filter.
  const activeLanes = useNewFilters((s) => s.activeLanes);
  const toggleLane = useNewFilters((s) => s.toggleLane);
  const resetLanes = useNewFilters((s) => s.reset);

  // Na een chip-tik terug naar boven, net als op /theater. Anders kijk je
  // na het filteren nog halverwege de vorige lijst — een andere baan met
  // dezelfde scrollpositie leest als "er is niks veranderd".
  // Via de scroll-responder en niet scrollToLocation: die laatste gooit
  // als de nieuwe selectie nul secties oplevert.
  const listRef = useRef<SectionList<ApiEvent, LaneSection>>(null);
  const pickLane = useCallback((apply: () => void) => {
    apply();
    listRef.current?.getScrollResponder()?.scrollTo({ y: 0, animated: true });
  }, []);

  // Eén keer, nadat je genoeg hebt beoordeeld om iets te verliezen te
  // hebben: melden dat je smaak lokaal staat. Niet omdat we een account
  // willen verkopen — omdat 't waar is, en dit het moment is waarop 't
  // gaat knellen. Verdwijnt zodra je 'm wegtikt of een account maakt.
  const ratedCount = useNewFilters((s) => s.ratedCount);
  const nudgeDismissed = useNewFilters((s) => s.nudgeDismissed);
  const showNudge =
    !registered && !nudgeDismissed && ratedCount >= TASTE_NUDGE_THRESHOLD;

  // Hoeveel ladingen we hebben opgevraagd. Elke volgende vraagt een
  // hogere `limit` op bij dezelfde `since`, en omdat de server binnen dat
  // venster een stabiele volgorde teruggeeft (createdAt aflopend) zijn de
  // eerste PAGE items van lading twee exact die van lading één. Daar hangt
  // alles onder aan: zonder die stabiliteit kan je niet chunken.
  const [pages, setPages] = useState(1);

  // Wat er nu te vinden is, uit één gedeelde hook — dezelfde die de
  // aanwinsten-strook op Vandaag voedt. Die twee mogen niet uit elkaar
  // lopen: als de strook iets belooft moet deze pagina 't ook tonen.
  const {
    data: active,
    showingFallback,
    since,
    isLoading,
    error,
  } = useNewArrivals({
    enabled: authed,
    lanes: activeLanes,
    limit: Math.min(pages * PAGE, SERVER_MAX),
  });
  const rawEvents = active?.events;
  // Wat je deze sessie al beoordeeld hebt. De server haalt beoordeelde
  // events er ook uit, maar pas bij de volgende fetch — deze set laat de
  // rij meteen verdwijnen zodat de lijst onder je handen leegloopt.
  // Dát is de beloning: je kunt 'm áf krijgen.
  const [rated, setRated] = useState<Set<string>>(new Set());
  const markRated = useCallback((eventId: string) => {
    setRated((prev) => new Set(prev).add(eventId));
  }, []);

  // Laatste oordeel, voor ongedaan maken. Vegen mist vaker dan tikken —
  // je haalt 'm net te ver door terwijl je wilde scrollen — en een nee
  // haalt het event permanent uit de lijst. Zonder uitweg is dat te
  // definitief voor een gebaar dat je per ongeluk maakt.
  const [lastRated, setLastRated] = useState<{
    eventId: string;
    occurrenceId: string;
    kind: 'ja' | 'nee';
    title: string;
  } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rememberForUndo = useCallback(
    (entry: NonNullable<typeof lastRated>) => {
      setLastRated(entry);
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setLastRated(null), 6000);
    },
    []
  );
  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    []
  );

  const toggleSaveMut = useToggleSave();
  const toggleDismissMut = useToggleDismiss();
  const undoLast = useCallback(() => {
    if (!lastRated) return;
    softTap();
    // Beide mutaties zijn togglers, dus nog een keer aanroepen draait 'm
    // terug. De rij komt vanzelf weer boven water zodra 'ie uit `rated`
    // is en de volgende fetch 'm niet meer wegfiltert.
    if (lastRated.kind === 'ja')
      toggleSaveMut.mutate({ occurrenceId: lastRated.occurrenceId, source: 'new' });
    else
      toggleDismissMut.mutate({
        occurrenceId: lastRated.occurrenceId,
        source: 'new',
      });
    setRated((prev) => {
      const next = new Set(prev);
      next.delete(lastRated.eventId);
      return next;
    });
    setLastRated(null);
  }, [lastRated, toggleSaveMut, toggleDismissMut]);

  // Welke rij de veeg-hint krijgt. Eén keer vastgezet op de eerste rij
  // die we te zien krijgen, en daarna niet meer verschoven — anders
  // begint de volgende rij te wiebelen zodra je de eerste wegveegt.
  const [hintId, setHintId] = useState<string | null>(null);
  const hintDone = useRef(false);

  // `total` telt vóór de cap: 15 in beeld, 47 achter de meer-knop. Min
  // wat je deze sessie al hebt weggetikt — de server weet daar pas van
  // bij de volgende fetch, en tot die tijd zou de teller stil blijven
  // staan terwijl de lijst onder je handen korter wordt.
  const total = Math.max(0, (active?.total ?? 0) - rated.size);
  const shown = (active?.events.length ?? 0) - rated.size;
  const laneCounts = active?.laneCounts;
  // Server geeft de lijst in createdAt-desc volgorde (meest recent
  // gescraped eerst). Visueel is dat verwarrend: gebruiker ziet de
  // event-datum naast elke kaart en die springt dan random rond. Hier
  // hersorteer we op event-startsAt zodat de tijdvolgorde leesbaar
  // is: morgen → volgende week → over een jaar.
  //
  // Daarnaast splitsen we op `venueFollowed`: items van venues die
  // jij volgt komen bovenaan onder hun eigen kop, daarna de rest.
  // Mooie persoonlijke filter zonder dat je écht items mist.
  /**
   * De lijst, in ladingen van PAGE.
   *
   * Hier zat het probleem. De server geeft op nieuwheid (createdAt
   * aflopend), maar naast elke kaart staat de *event*-datum, en die
   * sprong dan willekeurig rond -- dus hersorteerden we de hele lijst op
   * startsAt. Zolang je één lading had was dat prima. Vroeg je de rest
   * op, dan werden die 185 nieuwe items door de 15 die je al had
   * beoordeeld heen gesorteerd, en moest je opnieuw zoeken waar je was.
   *
   * De oplossing is niet minder sorteren maar kleiner sorteren: we
   * knippen op de serverordening in ladingen en sorteren *binnen* een
   * lading. Zo blijft de datum leesbaar per blok, en komt een volgende
   * lading er altijd onder -- nooit tussen wat je al gezien hebt.
   *
   * Het knippen gebeurt vóór het wegfilteren van wat je net beoordeelde.
   * Andersom zou elke veeg de blokgrenzen opschuiven en dus rijen tussen
   * blokken laten verspringen: precies hetzelfde probleem, maar dan per
   * veeg in plaats van per knop.
   */
  const batched = useMemo(() => {
    if (!rawEvents) return undefined;
    const byStart = (a: ApiEvent, b: ApiEvent) => {
      const aT = a.startsAt ? new Date(a.startsAt).getTime() : Infinity;
      const bT = b.startsAt ? new Date(b.startsAt).getTime() : Infinity;
      return aT - bT;
    };
    const out: { batch: number; events: ApiEvent[] }[] = [];
    for (let i = 0; i < rawEvents.length; i += PAGE) {
      const chunk = rawEvents
        .slice(i, i + PAGE)
        .filter((e) => !rated.has(e.id))
        .sort(byStart);
      if (chunk.length > 0) out.push({ batch: i / PAGE, events: chunk });
    }
    return out;
  }, [rawEvents, rated]);

  const events = useMemo(
    () => (batched ? batched.flatMap((b) => b.events) : undefined),
    [batched]
  );

  // Eén sectie per baan, in vaste volgorde zodat de lijst er elke dag
  // hetzelfde uitziet ongeacht welke scraper toevallig als laatste liep.
  // Binnen een baan komen gevolgde venues bovenaan — dat signaal was
  // eerder een eigen sectie, maar de baan-indeling is de belangrijkere
  // scheiding en twee kapstokken door elkaar leest niet.
  useEffect(() => {
    if (hintDone.current) return;
    const first = events?.[0];
    if (!first) return;
    hintDone.current = true;
    setHintId(first.id);
  }, [events]);

  const sections = useMemo(() => {
    if (!batched) return [];
    const out: LaneSection[] = [];
    // Per lading z'n eigen baan-indeling. De kopjes komen daardoor bij
    // lading twee opnieuw voorbij, en dat is precies goed: het zegt "hier
    // begint de volgende stapel" in plaats van je terug te sturen naar
    // boven. De scheiding boven de eerste sectie van een lading maakt dat
    // expliciet.
    for (const { batch, events: chunk } of batched) {
      let first = true;
      for (const lane of LANES) {
        const data = chunk.filter((e) => e.lane === lane);
        if (data.length === 0) continue;
        out.push({
          lane,
          batch,
          batchStart: first,
          data: [
            ...data.filter((e) => e.venueFollowed),
            ...data.filter((e) => !e.venueFollowed),
          ],
        });
        first = false;
      }
      // De fallback-query (`/events/new` zonder since) levert geen lane —
      // die rijen vallen hier in één naamloze sectie.
      const rest = chunk.filter((e) => !e.lane);
      if (rest.length > 0) {
        out.push({ lane: 'onbekend', batch, batchStart: first, data: rest });
      }
    }
    return out;
  }, [batched]);
  const showSectionHeaders = sections.some((s) => s.lane !== 'onbekend');

  // "24 mei" / "May 24" (+ jaartal bij andere jaren). Concrete datum in
  // de intro maakt expliciet vanaf wanneer we 'nieuw' definiëren — bv.
  // wanneer er 0 items zijn helpt het te zien dat de teller wel klopt.
  const locale = useLocale();
  const sinceLabel = since ? formatSinceLabel(since, locale) : null;

  // Nog een lading. `loadingMore` is puur voor de voetregel: de query
  // houdt met keepPreviousData de vorige lijst staan, dus `isLoading` slaat
  // hier niet aan en zonder eigen vlag gebeurt er zichtbaar niets.
  const hasMore =
    shown < total && (rawEvents?.length ?? 0) < SERVER_MAX;
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    setPages((p) => p + 1);
  }, [hasMore, loadingMore]);
  // De nieuwe lading is binnen zodra er meer rijen staan dan we vroegen.
  useEffect(() => {
    setLoadingMore(false);
  }, [rawEvents]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await qc.invalidateQueries({ queryKey: ['events', 'new'] });
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) await new Promise((r) => setTimeout(r, 700 - elapsed));
      setRefreshing(false);
    }
  }, [qc]);

  // De chip-rij zit vást in de header, dus de content moet er ook
  // onder beginnen — zelfde rekensom als op /theater en /clubs.
  const topInset = insets.top + HEADER_HEIGHT + FILTER_ROW_HEIGHT;
  const bottomInset = insets.bottom + 96;

  const closeBtn = (
    <Pressable
      onPress={() => router.back()}
      hitSlop={8}
      style={[
        styles.closeBtn,
        { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
      ]}
    >
      <Ionicons name="close" size={20} color={roles.fg} />
    </Pressable>
  );

  const isEmpty =
    !isLoading && !error && (events?.length ?? 0) === 0;

  // Leeg door jouw filter, of leeg omdat er niets is? Dat verschil moet
  // de tekst maken. "Je bent bij" terwijl er 23 films klaarstaan die je
  // wegfiltert is onwaar, en laat je bovendien zoeken naar iets wat één
  // tik verderop staat. Banen met inhoud die jij niet hebt aanstaan,
  // grootste eerst.
  const elsewhere = laneCounts
    ? LANES.filter(
        (l) => !activeLanes.includes(l) && (laneCounts[l] ?? 0) > 0
      ).sort((a, b) => (laneCounts[b] ?? 0) - (laneCounts[a] ?? 0))
    : [];
  const elsewhereLane = elsewhere[0];
  const elsewhereCount = elsewhereLane ? (laneCounts?.[elsewhereLane] ?? 0) : 0;
  const activeNames = activeLanes.map((l) => laneLabel(l, t));

  // Alle vijf banen, ook die op nul staan. Eerder verborgen we lege
  // banen om de rij kort te houden, maar dan verdwijnt de uitweg
  // precies wanneer je 'm zoekt: filter op theater, niks nieuws, en de
  // andere labels zijn weg. Een nul is trouwens ook antwoord.
  const chips = laneCounts ? (
    <View style={{ height: FILTER_ROW_HEIGHT }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {/* "Alle" eerst, net als op /theater. Geen baan aangeklikt is
            hier al alles, dus deze chip doet niets nieuws — hij maakt
            zichtbaar dat je in de complete lijst kijkt, en geeft één tik
            om uit een filter te stappen in plaats van elke aangezette
            baan los uit te moeten tikken. */}
        <FilterChip
          label={t('Alle', 'All')}
          count={LANES.reduce((n, l) => n + (laneCounts[l] ?? 0), 0)}
          active={activeLanes.length === 0}
          onPress={() => pickLane(resetLanes)}
        />
        {LANES.map((lane) => (
          <FilterChip
            key={lane}
            label={laneLabel(lane, t)}
            count={laneCounts[lane] ?? 0}
            active={activeLanes.includes(lane)}
            onPress={() => pickLane(() => toggleLane(lane))}
          />
        ))}
      </ScrollView>
    </View>
  ) : null;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner visible={refreshing} topOffset={topInset + 8} />

      {isEmpty ? (
        <View style={{ flex: 1, paddingTop: topInset }}>
          <View style={[styles.emptyCenter, { paddingBottom: bottomInset }]}>
            <Ionicons name="flash-outline" size={48} color={roles.fgMuted} />
            <Text style={[styles.emptyTitle, { color: roles.fg }]}>
              {elsewhereLane
                ? t('Niks in deze baan', 'Nothing in this lane')
                : t('Je bent bij', 'You’re up to date')}
            </Text>
            <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
              {elsewhereLane
                ? t(
                    `Niks nieuws in ${activeNames.join(' en ')}. Wel ${elsewhereCount} in ${laneLabel(elsewhereLane, t)} — tik die baan hierboven aan.`,
                    `Nothing new in ${activeNames.join(' and ')}. But ${elsewhereCount} in ${laneLabel(elsewhereLane, t)} — tap that lane above.`
                  )
                : t(
                    'Vandaag is er nog niks bijgekomen. Zodra de venues hun programma bijwerken staat het hier.',
                    'Nothing added today yet. As soon as venues update their programme it shows up here.'
                  )}
            </Text>
          </View>
        </View>
      ) : isLoading ? (
        <View style={[styles.loadingWrap, { paddingTop: topInset }]}>
          <SpinningCross size={28} color={roles.fgPlaceholder} />
        </View>
      ) : error ? (
        <View style={[styles.listState, { paddingTop: topInset }]}>
          <Text style={[styles.listStateText, { color: '#c9453a' }]}>
            {t('Kon de lijst niet laden.', 'Couldn’t load the list.')}
          </Text>
        </View>
      ) : (
        <SectionList
          ref={listRef}
          sections={sections}
          keyExtractor={(e) => e.id}
          renderItem={({ item }) => (
            <NewArrivalRow
              event={item}
              onRated={markRated}
              onRemember={rememberForUndo}
              hint={item.id === hintId}
            />
          )}
          renderSectionHeader={({ section }) => {
            const lane =
              showSectionHeaders && section.lane !== 'onbekend' ? (
                <View style={[styles.sectionHead, { backgroundColor: roles.bg }]}>
                  <Text style={[styles.sectionHeadText, { color: roles.fg }]}>
                    {laneLabel(section.lane, t)}
                  </Text>
                </View>
              ) : null;
            // Boven de eerste sectie van een volgende lading: een streep
            // met het nummer erin. Zonder dat lijkt een tweede "Muziek"
            // een fout, en juist hier moet je zien dat alles hieronder
            // nieuw voor je is.
            if (!section.batchStart || section.batch === 0) return lane;
            return (
              <View>
                <View style={styles.batchBreak}>
                  <View
                    style={[
                      styles.batchLine,
                      { backgroundColor: roles.bgChip },
                    ]}
                  />
                  <Text
                    style={[styles.batchText, { color: roles.fgPlaceholder }]}
                  >
                    {t('vanaf hier nieuw', 'new from here')}
                  </Text>
                  <View
                    style={[
                      styles.batchLine,
                      { backgroundColor: roles.bgChip },
                    ]}
                  />
                </View>
                {lane}
              </View>
            );
          }}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={
            <View>
              <View
                style={[
                  styles.fallbackHint,
                  { borderColor: roles.bgChip },
                ]}
              >
                <Text style={[styles.fallbackText, { color: roles.fg }]}>
                  {/* Alleen het totaal. Eerder stond hier "15 van 30",
                      maar dat cijfer zegt niks dat je niet al ziet: wat
                      er nog achter de cap zit staat als knop onderaan de
                      lijst. */}
                  {showingFallback
                    ? // Geen sessiegrens, of je bent bij. Dan is "vandaag"
                      // het venster — geen datum uit het verleden noemen
                      // die niks meer betekent.
                      total === 0
                      ? t(
                          'Je bent bij. Vandaag is er nog niks bijgekomen.',
                          'You’re up to date. Nothing added today yet.'
                        )
                      : t(
                          `${total} vandaag toegevoegd.`,
                          `${total} added today.`
                        )
                    : t(
                        `${total} ${total === 1 ? 'aanwinst' : 'aanwinsten'} sinds je vorige bezoek (${sinceLabel}).`,
                        `${total} ${total === 1 ? 'new addition' : 'new additions'} since your last visit (${sinceLabel}).`
                      )}
                </Text>
              </View>
              {showNudge && (
                <View
                  style={[
                    styles.nudge,
                    { borderColor: roles.fgPlaceholder },
                  ]}
                >
                  <View style={styles.nudgeBody}>
                    <Text style={[styles.nudgeText, { color: roles.fg }]}>
                      {t(
                        `Je hebt ${ratedCount} dingen beoordeeld. Dat profiel staat alleen op deze telefoon.`,
                        `You’ve rated ${ratedCount} things. That profile lives only on this phone.`
                      )}
                    </Text>
                    <Pressable
                      onPress={() => {
                        softTap();
                        router.push('/jij' as never);
                      }}
                    >
                      <Text
                        style={[styles.nudgeLink, { color: roles.accent }]}
                      >
                        {t('Bewaar het →', 'Keep it safe →')}
                      </Text>
                    </Pressable>
                  </View>
                  <Pressable
                    onPress={() => useNewFilters.getState().dismissNudge()}
                    hitSlop={10}
                    accessibilityLabel={t('Verberg', 'Dismiss')}
                  >
                    <Ionicons
                      name="close"
                      size={16}
                      color={roles.fgPlaceholder}
                    />
                  </Pressable>
                </View>
              )}
            </View>
          }
          // Scroll je naar de onderkant, dan komt de volgende lading er
          // onder. De knop blijft staan als vangnet: `onEndReached` mist
          // wel eens een keer, en dan is een lijst die stil blijft liggen
          // erger dan een knop die je niet nodig had.
          onEndReached={loadMore}
          onEndReachedThreshold={0.6}
          ListFooterComponent={
            // Op het plafond van de server. Niet zwijgend stoppen: de
            // teller bovenaan noemt duizenden events en dan lijkt een
            // lijst die ophoudt stuk. Dit zegt waar de grens zit en wat
            // je eraan kan doen.
            !hasMore && (rawEvents?.length ?? 0) >= SERVER_MAX ? (
              <Text style={[styles.capNote, { color: roles.fgPlaceholder }]}>
                {t(
                  `Dit zijn de eerste ${SERVER_MAX}. Zet een baan of twee uit om de rest scherper te krijgen.`,
                  `These are the first ${SERVER_MAX}. Turn off a lane or two to narrow the rest down.`
                )}
              </Text>
            ) : hasMore ? (
              <Pressable
                onPress={loadMore}
                disabled={loadingMore}
                style={[styles.moreBtn, { borderColor: roles.fgPlaceholder }]}
              >
                {loadingMore ? (
                  <SpinningCross size={18} color={roles.fgMuted} />
                ) : (
                  <Text style={[styles.moreBtnText, { color: roles.fg }]}>
                    {t(
                      `Nog ${total - shown} — tik of scroll verder`,
                      `${total - shown} more — tap or keep scrolling`
                    )}
                  </Text>
                )}
              </Pressable>
            ) : null
          }
          contentContainerStyle={{
            paddingTop: topInset,
            paddingBottom: bottomInset,
          }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={roles.accent}
              colors={[roles.accent]}
              progressViewOffset={topInset}
            />
          }
          windowSize={7}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          // `removeClippedSubviews` stond hier voor de performance, maar
          // op iOS krijgen geclipte rijen geen touches meer — dus alles
          // ná de eerste batch was niet meer te vegen. De lijst is
          // gecapt op 15, dus die optimalisatie levert hier toch niks op.
        />
      )}

      <AppHeader
        title={t('Nieuw', 'New')}
        hideAvatar
        rightSlot={closeBtn}
      >
        {chips}
      </AppHeader>

      {lastRated && (
        <View
          style={[
            styles.undoBar,
            {
              bottom: insets.bottom + 24,
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
              borderColor: roles.bgChip,
            },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.undoText, { color: roles.fgMuted }]}
          >
            {lastRated.kind === 'ja'
              ? t(`Bewaard: ${lastRated.title}`, `Saved: ${lastRated.title}`)
              : t(`Weg: ${lastRated.title}`, `Dismissed: ${lastRated.title}`)}
          </Text>
          <Pressable onPress={undoLast} hitSlop={8}>
            <Text style={[styles.undoAction, { color: roles.accent }]}>
              {t('Ongedaan', 'Undo')}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** Baan-labels. "live" en "club" zijn de scheiding waar het om draait:
    een concert om 20:30 en een feest om 01:00 zijn niet dezelfde vraag. */
function laneLabel(lane: Lane, t: ReturnType<typeof useT>): string {
  switch (lane) {
    case 'film':
      return t('Film', 'Film');
    case 'theater':
      return t('Theater', 'Theatre');
    case 'live':
      return t('Live muziek', 'Live music');
    case 'club':
      return t('Clubs & dj’s', 'Clubs & DJs');
    case 'kunst':
      return t('Kunst & meer', 'Art & more');
  }
}

function formatSinceLabel(date: Date, locale: ReturnType<typeof useLocale>): string {
  const day = date.getDate();
  const month = monthShort(date.getMonth(), locale).toLowerCase();
  const year = date.getFullYear();
  const nowYear = new Date().getFullYear();
  return year === nowYear ? `${day} ${month}` : `${day} ${month} ${year}`;
}

function NewArrivalRow({
  event,
  onRated,
  onRemember,
  hint,
}: {
  event: ApiEvent;
  onRated: (eventId: string) => void;
  hint: boolean;
  onRemember: (entry: {
    eventId: string;
    occurrenceId: string;
    kind: 'ja' | 'nee';
    title: string;
  }) => void;
}) {
  const locale = useLocale();
  const t = useT();
  const roles = useRoles();
  const toggleSave = useToggleSave();
  const toggleDismiss = useToggleDismiss();
  const venueTone =
    event.venue.type &&
    (VENUE_TYPE_TICK as Record<string, BadgeTone>)[event.venue.type]
      ? (VENUE_TYPE_TICK as Record<string, BadgeTone>)[event.venue.type]
      : undefined;
  const tone = CATEGORY_TICK[event.category];
  const start = event.startsAt;
  if (!start) return null;
  const d = new Date(start);
  const dow = dowMixed(d.getDay(), locale);
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  const time = rowTimeLabel(start, event.endsAt ?? null, locale);
  const dateLabel = `${dow} ${d.getDate()} ${month}`;
  // Onder een baan-kop is de categorie-tag ruis. Wat je daar wél wil
  // weten: is dit nieuw, of kreeg iets bestaands er datums bij? Dat
  // laatste zag je hiervoor helemaal niet.
  const extraDates = (event.newOccurrenceCount ?? 0) > 1;
  const tags =
    event.lane && event.isNewEvent === false && extraDates
      ? [
          {
            label: t(
              `+${event.newOccurrenceCount} datums`,
              `+${event.newOccurrenceCount} dates`
            ),
            tone,
          },
        ]
      : [{ label: translateCategory(event.category, locale), tone }];
  // Ja/nee landt op één occurrence, maar geldt voor het hele event: de
  // server haalt daarna álle voorstellingen van dit event uit /new.
  // Anders dismis je een film met 19 screenings negentien keer.
  const rateId = event.rateOccurrenceId;
  const rate = (kind: 'ja' | 'nee') => {
    if (!rateId) return;
    softTap();
    if (kind === 'ja') toggleSave.mutate({ occurrenceId: rateId, source: 'new' });
    else toggleDismiss.mutate({ occurrenceId: rateId, source: 'new' });
    onRated(event.id);
    onRemember({
      eventId: event.id,
      occurrenceId: rateId,
      kind,
      title: event.title,
    });
    useNewFilters.getState().bumpRated();
  };

  return (
    <SwipeableRow
      hint={hint}
      enabled={Boolean(rateId)}
      onSwipeRight={() => rate('ja')}
      onSwipeLeft={() => rate('nee')}
      onPress={() => router.push(`/event/${event.id}?source=new` as never)}
    >
    <EventListRow
      thumb={eventImageUrl(event) ?? ''}
      thumbSize={96}
      title={event.title}
      venue={event.venue.name}
      venueTone={venueTone}
      time={time}
      dateLabel={dateLabel}
      dateAbove
      tags={tags}
      genreLabel={(event.genres ?? [])[0]}
      tick={tone}
      // Geen onPress hier: die zit op SwipeableRow, zodat 'ie kan
      // verliezen van de veeg. De Pressable van EventListRow blijft
      // wel z'n indruk-feedback geven.
    />
    </SwipeableRow>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCenter: {
    flex: 1,
    paddingHorizontal: 32,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 22,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  emptySub: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listState: { paddingHorizontal: 22, paddingVertical: 14 },
  listStateText: {
    fontFamily: fontFamily.body,
    fontSize: 13,
  },
  // Regels boven en onder maken hier een eigen bandje van, in plaats van
  // een losse regel die tussen de chips en de eerste sectiekop hangt.
  // Randen tot de schermrand (geen inset) zodat 'ie leest als een
  // scheiding en niet als een omlijnd blok.
  fallbackHint: {
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fallbackText: {
    fontFamily: fontFamily.body,
    fontSize: 15,
    lineHeight: 21,
    letterSpacing: -0.1,
    // Gecentreerd: dit is een onderschrift over de lijst, geen rij ín de
    // lijst. Links uitlijnen zou 'm laten meedoen met de sectiekoppen.
    textAlign: 'center',
  },
  // Zweeft boven de lijst, net boven de home-indicator. Zes seconden
  // zichtbaar — lang genoeg om 'm te zien na een misveeg, kort genoeg
  // dat 'ie niet in de weg blijft hangen.
  undoBar: {
    position: 'absolute',
    left: 22,
    right: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    height: 48,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  undoText: { flex: 1, fontFamily: fontFamily.body, fontSize: 13 },
  undoAction: { fontFamily: fontFamily.displayBold, fontSize: 14 },
  nudge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 22,
    marginTop: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  nudgeBody: { flex: 1, gap: 4 },
  nudgeText: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 18 },
  nudgeLink: { fontFamily: fontFamily.medium, fontSize: 13 },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 22,
    // Vult de vaste rijhoogte in de header, net als op /theater — zo
    // staan de chips verticaal gecentreerd zonder losse paddings.
    height: '100%',
  },
  capNote: {
    fontFamily: fontFamily.body,
    fontSize: 12.5,
    lineHeight: 18,
    paddingHorizontal: 32,
    paddingTop: 22,
    textAlign: 'center',
  },
  batchBreak: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 22,
    paddingTop: 26,
    paddingBottom: 6,
  },
  batchLine: { flex: 1, height: 1 },
  batchText: {
    fontFamily: fontFamily.display,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  moreBtn: {
    marginHorizontal: 22,
    marginTop: 14,
    height: 46,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.06,
  },
  // Section-headers — zelfde display-stijl als de category-headers
  // op Agenda: dikke font-titel, geen mono-kicker.
  sectionHead: {
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 6,
  },
  sectionHeadText: {
    fontFamily: fontFamily.displayBold,
    fontSize: 18,
    letterSpacing: -0.36,
  },
});
