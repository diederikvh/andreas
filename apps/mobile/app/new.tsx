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
  useNewArrivalsSince,
  useToggleDismiss,
  useToggleSave,
} from '@/lib/queries';
import type { BadgeTone } from '@/lib/types';
import {
  TASTE_NUDGE_THRESHOLD,
  useNewFilters,
} from '@/store/newFilters';
import {
  useNewWindowStart,
  useSessionTimestamps,
} from '@/store/sessionTimestamps';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

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
  // De lijst ankert op de sessie-grens (`previous`), niet op je
  // laatste bezoek. Daardoor blijft 'ie de hele sessie dezelfde "nieuw
  // sinds je vorige bezoek"-lijst tonen — wegstappen en terugkomen
  // verandert er niks aan. Pas een nieuwe sessie (>30min weg) schuift
  // het venster door.
  const since = useNewWindowStart();

  // Bij BLUR (= je verlaat /new): markeer de pagina als gezien zodat de
  // badge-teller op /avond naar 0 zakt. Raakt de lijst hierboven niet —
  // die hangt aan `previous`, niet aan dit bezoek-moment.
  useFocusEffect(
    useCallback(() => {
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

  // Eén keer, nadat je genoeg hebt beoordeeld om iets te verliezen te
  // hebben: melden dat je smaak lokaal staat. Niet omdat we een account
  // willen verkopen — omdat 't waar is, en dit het moment is waarop 't
  // gaat knellen. Verdwijnt zodra je 'm wegtikt of een account maakt.
  const ratedCount = useNewFilters((s) => s.ratedCount);
  const nudgeDismissed = useNewFilters((s) => s.nudgeDismissed);
  const showNudge =
    !registered && !nudgeDismissed && ratedCount >= TASTE_NUDGE_THRESHOLD;

  // De server capt op 15 zodat de lijst áf te maken is. Wie meer wil
  // klapt uit; dat is een tweede request, geen client-side slice.
  const [expanded, setExpanded] = useState(false);

  // Primair: alles dat sinds de vorige sessie is toegevoegd — nieuwe
  // events én nieuwe datums bij bestaande events. Pauzeert wanneer
  // since=null (eerste-ooit-launch).
  const {
    data: arrivals,
    isLoading: loadingSince,
    error: errorSince,
  } = useNewArrivalsSince(since, {
    enabled: authed,
    lanes: activeLanes,
    limit: expanded ? 200 : undefined,
  });

  // Fallback: geen sessiegrens (eerste keer) of niks nieuws sinds je
  // vorige bezoek. Dan tonen we wat er vandáág is bijgekomen — een
  // concreet venster in plaats van "de laatste tien, wanneer dan ook".
  // Dat laatste toonde items van drie weken terug alsof ze nieuw waren.
  //
  // De keuze hangt aan het venster, niet aan je filter: `laneCounts`
  // telt vóór het filteren, dus de som is wat er onbewerkt in zit.
  // Eerder keek dit naar `arrivals.total` plus "geen banen aangezet",
  // en dan zette de fallback zichzelf uit zodra je één baan aanklikte —
  // in het "vandaag"-venster viel dus niet te filteren.
  //
  // Zit er wél iets in het venster maar niet in jouw baan, dan blijft
  // dit false: dat is een antwoord op je filter, geen leeg venster.
  const sinceUnfiltered = arrivals
    ? Object.values(arrivals.laneCounts).reduce((a, b) => a + b, 0)
    : undefined;
  const sinceEmpty = !since || sinceUnfiltered === 0;
  // Middernacht, niet de logische dag-grens van 06:00. Die 06:00-regel
  // gaat over wannéér een event begint (een clubnacht om 02:00 hoort bij
  // de avond ervoor) — niet over wanneer een record is aangemaakt. De
  // scrape-cron draait om 02:00, dus met een 06:00-grens zou alles wat
  // vannacht binnenkwam onder "gisteren" vallen en stond hier 's ochtends
  // structureel nul.
  const todayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const {
    data: today,
    isLoading: loadingRecent,
    error: errorRecent,
  } = useNewArrivalsSince(todayStart, {
    enabled: authed && sinceEmpty,
    lanes: activeLanes,
    limit: expanded ? 200 : undefined,
  });
  // Eén bron voor de hele pagina: in de fallback is dat `today`, anders
  // `arrivals`. Eerder koos elke afgeleide waarde apart op
  // "heeft arrivals rijen?", en dan kon de lijst uit het ene venster
  // komen en de teller uit het andere.
  const active = sinceEmpty ? (today ?? arrivals) : arrivals;
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
  const events = useMemo(() => {
    if (!rawEvents) return undefined;
    return [...rawEvents]
      .filter((e) => !rated.has(e.id))
      .sort((a, b) => {
        const aT = a.startsAt ? new Date(a.startsAt).getTime() : Infinity;
        const bT = b.startsAt ? new Date(b.startsAt).getTime() : Infinity;
        return aT - bT;
      });
  }, [rawEvents, rated]);

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
    if (!events) return [];
    const out: { lane: Lane | 'onbekend'; data: ApiEvent[] }[] = [];
    for (const lane of LANES) {
      const data = events.filter((e) => e.lane === lane);
      if (data.length > 0)
        out.push({
          lane,
          data: [
            ...data.filter((e) => e.venueFollowed),
            ...data.filter((e) => !e.venueFollowed),
          ],
        });
    }
    // De fallback-query (`/events/new` zonder since) levert geen lane —
    // die rijen vallen hier in één naamloze sectie.
    const rest = events.filter((e) => !e.lane);
    if (rest.length > 0) out.push({ lane: 'onbekend', data: rest });
    return out;
  }, [events]);
  const showSectionHeaders = sections.some((s) => s.lane !== 'onbekend');
  // Toont de lijst het "vandaag"-venster in plaats van "sinds je vorige
  // bezoek"? Bepaalt de kop.
  const showingFallback = sinceEmpty;
  const isLoading = (since && loadingSince) || (sinceEmpty && loadingRecent);
  const error = errorSince ?? errorRecent;

  // "24 mei" / "May 24" (+ jaartal bij andere jaren). Concrete datum in
  // de intro maakt expliciet vanaf wanneer we 'nieuw' definiëren — bv.
  // wanneer er 0 items zijn helpt het te zien dat de teller wel klopt.
  const locale = useLocale();
  const sinceLabel = since ? formatSinceLabel(since, locale) : null;

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

  // Staat zowel in de lijst-header als op het lege scherm. Daar is 'ie
  // het hele punt: "zet er eentje bij om breder te kijken" is een
  // doodlopende tekst als de knoppen om dat te doen weg zijn.
  //
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
        {LANES.map((lane) => (
          <FilterChip
            key={lane}
            label={laneLabel(lane, t)}
            count={laneCounts[lane] ?? 0}
            active={activeLanes.includes(lane)}
            onPress={() => toggleLane(lane)}
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
              {t('Je bent bij', 'You’re up to date')}
            </Text>
            <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
              {activeLanes.length > 0
                ? t(
                    'Niks nieuws in de banen die je hebt aangezet. Zet er eentje bij om breder te kijken.',
                    'Nothing new in the lanes you picked. Turn one on to look wider.'
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
          renderSectionHeader={({ section }) =>
            showSectionHeaders && section.lane !== 'onbekend' ? (
              <View
                style={[
                  styles.sectionHead,
                  { backgroundColor: roles.bg },
                ]}
              >
                <Text style={[styles.sectionHeadText, { color: roles.fg }]}>
                  {laneLabel(section.lane, t)}
                </Text>
              </View>
            ) : null
          }
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={
            <View>
              <View style={styles.fallbackHint}>
                <Text style={[styles.fallbackText, { color: roles.fg }]}>
                  {showingFallback
                    ? // Geen sessiegrens, of je bent bij. Dan is "vandaag"
                      // het venster — geen datum uit het verleden noemen
                      // die niks meer betekent.
                      total === 0
                      ? t(
                          'Je bent bij. Vandaag is er nog niks bijgekomen.',
                          'You’re up to date. Nothing added today yet.'
                        )
                      : shown < total
                        ? t(
                            `${shown} van ${total} vandaag toegevoegd.`,
                            `${shown} of ${total} added today.`
                          )
                        : t(
                            `${total} vandaag toegevoegd.`,
                            `${total} added today.`
                          )
                    : shown < total
                      ? t(
                          `${shown} van ${total} sinds je vorige bezoek (${sinceLabel}).`,
                          `${shown} of ${total} since your last visit (${sinceLabel}).`
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
          ListFooterComponent={
            shown < total ? (
              <Pressable
                onPress={() => setExpanded(true)}
                style={[styles.moreBtn, { borderColor: roles.fgPlaceholder }]}
              >
                <Text style={[styles.moreBtnText, { color: roles.fg }]}>
                  {t(
                    `Toon de resterende ${total - shown}`,
                    `Show remaining ${total - shown}`
                  )}
                </Text>
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
  fallbackHint: {
    paddingHorizontal: 22,
    paddingTop: 6,
    paddingBottom: 4,
  },
  fallbackText: {
    fontFamily: fontFamily.body,
    fontSize: 15,
    lineHeight: 21,
    letterSpacing: -0.1,
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
