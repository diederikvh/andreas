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
import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SpinningCross } from '@/components/SpinningCross';
import { useSession } from '@/lib/authClient';
import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  dowMixed,
  eventImageUrl,
  monthShort,
  rowTimeLabel,
  translateCategory,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { useNewArrivalsSince, useRecentEvents } from '@/lib/queries';
import type { BadgeTone } from '@/lib/types';
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
      };
    }, [])
  );

  // Primair: events die sinds vorige sessie nieuw zijn. Pauzeert
  // wanneer since=null (eerste-ooit-launch).
  const {
    data: newSinceLast,
    isLoading: loadingSince,
    error: errorSince,
  } = useNewArrivalsSince(since, { enabled: authed });

  // Fallback: wanneer er sinds de vorige sessie 0 nieuwe items zijn (of
  // wanneer er nog geen since is) draaien we 'n tweede query voor de
  // laatste 10 recente events zodat de pagina nooit kaal blijft.
  const sinceEmpty =
    !since || (newSinceLast !== undefined && newSinceLast.length === 0);
  const {
    data: recent,
    isLoading: loadingRecent,
    error: errorRecent,
  } = useRecentEvents(10, { enabled: authed && sinceEmpty });

  const rawEvents =
    newSinceLast && newSinceLast.length > 0 ? newSinceLast : recent;
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
    return [...rawEvents].sort((a, b) => {
      const aT = a.startsAt ? new Date(a.startsAt).getTime() : Infinity;
      const bT = b.startsAt ? new Date(b.startsAt).getTime() : Infinity;
      return aT - bT;
    });
  }, [rawEvents]);

  const sections = useMemo(() => {
    if (!events) return [];
    const followed = events.filter((e) => e.venueFollowed);
    const others = events.filter((e) => !e.venueFollowed);
    const out: { kind: 'followed' | 'others'; data: ApiEvent[] }[] = [];
    if (followed.length > 0) out.push({ kind: 'followed', data: followed });
    if (others.length > 0) out.push({ kind: 'others', data: others });
    return out;
  }, [events]);
  // Header pas tonen als je ECHT iets volgt — anders is "Andere venues"
  // alleen verwarrend. Bij 0 follows = 1 sectie zonder kop.
  const showSectionHeaders = sections.length > 1;
  const showingFallback =
    sinceEmpty && (recent?.length ?? 0) > 0;
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

  const topInset = insets.top + HEADER_HEIGHT;
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

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner visible={refreshing} topOffset={topInset + 8} />

      {isEmpty ? (
        <View
          style={[
            styles.emptyCenter,
            { paddingTop: topInset, paddingBottom: bottomInset },
          ]}
        >
          <Ionicons name="flash-outline" size={48} color={roles.fgMuted} />
          <Text style={[styles.emptyTitle, { color: roles.fg }]}>
            {t('Nog niks toegevoegd', 'Nothing added yet')}
          </Text>
          <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
            {sinceLabel
              ? t(
                  `Sinds ${sinceLabel} is er niks binnengekomen. Zodra de scrapers iets oppakken verschijnt 't hier.`,
                  `Nothing has come in since ${sinceLabel}. As soon as scrapers pick something up it'll appear here.`
                )
              : t(
                  'Zodra er events worden binnengehaald verschijnen ze hier.',
                  'Items will appear here as soon as events come in.'
                )}
          </Text>
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
          renderItem={({ item }) => <NewArrivalRow event={item} />}
          renderSectionHeader={({ section }) =>
            showSectionHeaders ? (
              <View
                style={[
                  styles.sectionHead,
                  { backgroundColor: roles.bg },
                ]}
              >
                <Text style={[styles.sectionHeadText, { color: roles.fg }]}>
                  {section.kind === 'followed'
                    ? t('Bij jouw venues', 'At your venues')
                    : t('Bij andere venues', 'At other venues')}
                </Text>
              </View>
            ) : null
          }
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={
            <View style={styles.fallbackHint}>
              <Text style={[styles.fallbackText, { color: roles.fg }]}>
                {sinceLabel
                  ? showingFallback || !events || events.length === 0
                    ? t(
                        `Niks nieuws sinds ${sinceLabel} — hier zie je de laatste ${events?.length ?? 0} aanwinsten.`,
                        `Nothing new since ${sinceLabel} — here are the latest ${events?.length ?? 0} additions.`
                      )
                    : t(
                        `${events.length} ${events.length === 1 ? 'aanwinst' : 'aanwinsten'} sinds je vorige bezoek (${sinceLabel}).`,
                        `${events.length} ${events.length === 1 ? 'new addition' : 'new additions'} since your last visit (${sinceLabel}).`
                      )
                  : null}
              </Text>
            </View>
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
          removeClippedSubviews
        />
      )}

      <AppHeader
        title={t('Nieuw', 'New')}
        hideAvatar
        rightSlot={closeBtn}
      />
    </View>
  );
}

function formatSinceLabel(date: Date, locale: ReturnType<typeof useLocale>): string {
  const day = date.getDate();
  const month = monthShort(date.getMonth(), locale).toLowerCase();
  const year = date.getFullYear();
  const nowYear = new Date().getFullYear();
  return year === nowYear ? `${day} ${month}` : `${day} ${month} ${year}`;
}

function NewArrivalRow({ event }: { event: ApiEvent }) {
  const locale = useLocale();
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
  return (
    <EventListRow
      thumb={eventImageUrl(event) ?? ''}
      thumbSize={96}
      title={event.title}
      venue={event.venue.name}
      venueTone={venueTone}
      time={time}
      dateLabel={dateLabel}
      dateAbove
      tags={[{ label: translateCategory(event.category, locale), tone }]}
      genreLabel={(event.genres ?? [])[0]}
      tick={tone}
      onPress={() =>
        router.push(`/event/${event.id}?source=new` as never)
      }
    />
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
