/**
 * Andreas × Theater — overzicht van komende voorstellingen (~2 weken).
 * Single-column feed; per show landscape banner, titel, venue, alle
 * speeldata en discipline-chip. Bovenin filter-chips per discipline
 * (toneel / dans / cabaret / opera / familie) zodat je snel kan kiezen
 * wat je wil zien.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { BannerTitleOverlay } from '@/components/BannerTitleOverlay';
import { EventActions } from '@/components/EventActions';
import { FollowVenueButton } from '@/components/FollowVenueButton';
import { PinchableImage } from '@/components/PinchableImage';
import { RefreshBanner } from '@/components/RefreshBanner';
import type { ApiEvent } from '@/lib/api';
import {
  dowMixed,
  eventImageUrl,
  formatWijk,
  isMultiDay,
  monthShort,
  translateVenueType,
} from '@/lib/eventDisplay';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { useEvents } from '@/lib/queries';
import { useImageAspect } from '@/lib/useImageAspect';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HORIZONTAL_PADDING = 14;
const CHIPROW_HEIGHT = 36;

type Discipline =
  | 'toneel'
  | 'dans'
  | 'cabaret'
  | 'musical'
  | 'opera'
  | 'familie'
  | 'overig';

const DISCIPLINE_LABELS: Record<Discipline, { nl: string; en: string }> = {
  toneel: { nl: 'Toneel', en: 'Theatre' },
  dans: { nl: 'Dans', en: 'Dance' },
  cabaret: { nl: 'Cabaret', en: 'Comedy' },
  musical: { nl: 'Musical', en: 'Musical' },
  opera: { nl: 'Opera', en: 'Opera' },
  familie: { nl: 'Familie', en: 'Family' },
  overig: { nl: 'Overig', en: 'Other' },
};

/** Map een event naar een primaire discipline. Comedy/cabaret wordt
    eerder gecheckt dan musical/opera. Musical heeft eigen bucket
    (geen opera). Default voor empty/niet-herkende genres: 'toneel'
    — als 't echt onbekend is is toneel de veiligste gok voor
    Theater-category-events. */
function disciplineFor(event: ApiEvent): Discipline {
  const genres = (event.genres ?? []).map((g) => g.toLowerCase());
  if (genres.some((g) => /kind|familie|family/.test(g))) return 'familie';
  if (genres.some((g) => /cabaret|comedy|stand-?up|improv|drag/.test(g)))
    return 'cabaret';
  if (genres.some((g) => /musical|muziektheater/.test(g))) return 'musical';
  if (genres.some((g) => /opera|operette/.test(g))) return 'opera';
  if (genres.some((g) => /dans|dance|ballet/.test(g))) return 'dans';
  return 'toneel';
}

export default function Theater() {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<Discipline | 'all'>('all');
  // FlatList ref + helper voor chip-switch: nieuwe filter = nieuwe
  // lijst, dus altijd terug naar top. Zonder dit blijf je op de oude
  // scroll-positie staan en mis je items bovenaan de nieuwe selectie.
  const listRef = useRef<FlatList<ApiEvent>>(null);
  const selectChip = useCallback((d: Discipline | 'all') => {
    setSelected(d);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // Venster: komende 14 dagen. Theater wordt vaak weken vooruit
  // geboekt; 2 weken voelt als de juiste mix tussen "wat speelt nu"
  // en "ik wil iets plannen".
  const range = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 14);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const { data: events, isLoading, error } = useEvents({
    from: range.from,
    to: range.to,
    category: 'Theater',
    lean: true,
    limit: 2000,
  });

  // Pull-to-refresh: invalideert de events-cache zodat de query opnieuw
  // fetched. Minimum 700ms zichtbaar zodat de spinner niet weg-flitst.
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await qc.invalidateQueries({ queryKey: ['events'] });
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) await new Promise((r) => setTimeout(r, 700 - elapsed));
      setRefreshing(false);
    }
  }, [qc]);

  // Dedupe op event-id, sorteer op eerstvolgende speeldatum. Een event
  // is alleen relevant voor discovery als 'ie minstens één occurrence
  // heeft die (a) nog komt en (b) korter dan een dag is — anders
  // staat 'r straks een card zonder data of klap je door op een
  // afgelopen voorstelling.
  const shows = useMemo<ApiEvent[]>(() => {
    if (!events) return [];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const minMs = startOfToday.getTime();
    const seen = new Set<string>();
    const out: Array<{ event: ApiEvent; firstUpcoming: number }> = [];
    for (const e of events) {
      if (e.category !== 'Theater') continue;
      if (seen.has(e.id)) continue;
      const occs = e.occurrencesInRange ?? [];
      let firstUpcoming = Infinity;
      for (const o of occs) {
        if (isMultiDay(o.startsAt, o.endsAt)) continue;
        const ts = new Date(o.startsAt).getTime();
        if (ts < minMs) continue;
        if (ts < firstUpcoming) firstUpcoming = ts;
      }
      if (firstUpcoming === Infinity) continue;
      seen.add(e.id);
      out.push({ event: e, firstUpcoming });
    }
    return out
      .sort((a, b) => a.firstUpcoming - b.firstUpcoming)
      .map((x) => x.event);
  }, [events]);

  const filtered = useMemo(() => {
    if (selected === 'all') return shows;
    return shows.filter((s) => disciplineFor(s) === selected);
  }, [shows, selected]);

  // Tel per discipline om lege chips weg te laten (geen 'opera' chip
  // tonen als er deze 2 weken niets is). Volgorde is vaste discipline-
  // hierarchie zodat de chip-row consistent oogt over runs.
  const counts = useMemo(() => {
    const c: Record<Discipline, number> = {
      toneel: 0,
      dans: 0,
      cabaret: 0,
      musical: 0,
      opera: 0,
      familie: 0,
      overig: 0,
    };
    for (const s of shows) c[disciplineFor(s)] += 1;
    return c;
  }, [shows]);

  const visibleChips: Discipline[] = (['toneel', 'dans', 'cabaret', 'musical', 'opera', 'familie', 'overig'] as Discipline[])
    .filter((d) => counts[d] > 0);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner
        visible={refreshing}
        topOffset={insets.top + HEADER_HEIGHT + CHIPROW_HEIGHT + 8}
      />
      <FlatList
        ref={listRef}
        data={filtered}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => <ShowCard show={item} locale={locale} />}
        contentContainerStyle={{
          // +16 extra gap tussen chip-row en eerste card — zonder dit
          // plakt de eerste banner tegen de chips aan.
          paddingTop: insets.top + HEADER_HEIGHT + CHIPROW_HEIGHT + 16,
          paddingBottom: insets.bottom + 24,
        }}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.centerWrap}>
              <Text style={[styles.dim, { color: roles.fgMuted }]}>
                {t('Laden…', 'Loading…')}
              </Text>
            </View>
          ) : error ? (
            <View style={styles.centerWrap}>
              <Text style={[styles.dim, { color: roles.fgMuted }]}>
                {t('Kon theater niet laden.', "Couldn't load theatre.")}
              </Text>
            </View>
          ) : (
            <View style={styles.centerWrap}>
              <Text style={[styles.dim, { color: roles.fgMuted }]}>
                {t('Geen voorstellingen.', 'No shows.')}
              </Text>
            </View>
          )
        }
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
            progressViewOffset={insets.top + HEADER_HEIGHT + CHIPROW_HEIGHT + 60}
          />
        }
        // Virtualisatie: alleen wat in viewport (+ overscan) zit wordt
        // gemount. Cruciaal voor oude Android-toestellen — een ScrollView
        // met 100+ banner-cards tegelijk mounten gaat ze knock-out.
        windowSize={7}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        removeClippedSubviews
      />

      <AppHeader
        title={t('Theater', 'Theatre')}
        hideAvatar
        rightSlot={
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
        }
      >
        {/* Discipline-chips vast in de header zodat ze niet wegscrollen.
            Eerste chip = "Alle" om snel naar de complete lijst terug. */}
        <View style={{ height: CHIPROW_HEIGHT }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsRow}
          >
            <Chip
              label={t('Alle', 'All')}
              count={shows.length}
              active={selected === 'all'}
              onPress={() => selectChip('all')}
            />
            {visibleChips.map((d) => (
              <Chip
                key={d}
                label={DISCIPLINE_LABELS[d][locale === 'en' ? 'en' : 'nl']}
                count={counts[d]}
                active={selected === d}
                onPress={() => selectChip(d)}
              />
            ))}
          </ScrollView>
        </View>
      </AppHeader>
    </View>
  );
}

function Chip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        {
          // Inactief: half-transparante bg-tint zodat de AppHeader-
          // blur er doorheen scheen — matcht de day-chip pattern op
          // de Agenda. Actief: accent-vlak.
          backgroundColor: active ? roles.accent : `${roles.bg}99`,
        },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          { color: active ? roles.onAccent : roles.fg },
        ]}
      >
        {label}
        <Text
          style={{ color: active ? roles.onAccent : roles.fgMuted }}
        >
          {' '}
          {count}
        </Text>
      </Text>
    </Pressable>
  );
}

function ShowCard({ show, locale }: { show: ApiEvent; locale: Locale }) {
  const roles = useRoles();
  const banner = eventImageUrl(show);
  const { aspect: bannerAspect, onLoad: onBannerLoad } = useImageAspect(banner);
  const isFallbackImage = !show.imageUrl && Boolean(show.venue.imageUrl);
  const discipline = disciplineFor(show);

  // Verzamel unieke speeldata uit occurrencesInRange. We bewaren de
  // volledige occurrence (niet alleen de Date) zodat we voor één-
  // occurrence en today-shows een EventActions-rij kunnen renderen met
  // de juiste occurrenceId + ticketUrl.
  const upcomingOccs = useMemo(() => {
    const occs = show.occurrencesInRange ?? [];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const minMs = startOfToday.getTime();
    const byKey = new Map<string, (typeof occs)[number]>();
    for (const o of occs) {
      if (isMultiDay(o.startsAt, o.endsAt)) continue;
      const d = new Date(o.startsAt);
      if (d.getTime() < minMs) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
      if (!byKey.has(key)) byKey.set(key, o);
    }
    return [...byKey.values()].sort(
      (a, b) =>
        new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
    );
  }, [show]);

  const dates = upcomingOccs.map((o) => new Date(o.startsAt));
  const visibleDates = dates.slice(0, 5);
  const extra = dates.length - visibleDates.length;

  // Vandaag bepalen voor de inline-highlight: zelfde dag-grens als
  // de dates-filter (00:00 vandaag → 00:00 morgen) zodat een matinee
  // én een avond-show op zelfde dag allebei "vandaag" zijn.
  const todayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);
  const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;

  // EventActions-rij tonen als 't event maar één upcoming occurrence
  // heeft, OF wanneer de eerstvolgende vandaag is (geel uitgelicht in
  // de date-string). In beide gevallen weten we exact welke occurrence
  // de actie betreft (save/share/ticket).
  const actionOccurrence = (() => {
    if (upcomingOccs.length === 1) return upcomingOccs[0];
    const firstTodayOcc = upcomingOccs.find((o) => {
      const ts = new Date(o.startsAt).getTime();
      return ts >= todayStart && ts < tomorrowStart;
    });
    return firstTodayOcc ?? null;
  })();

  const formatDate = (d: Date) => {
    const dow = dowMixed(d.getDay(), locale);
    const day = d.getDate();
    const month = monthShort(d.getMonth(), locale).toLowerCase();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${dow} ${day} ${month} ${hh}:${mm}`;
  };

  const venue = show.venue;
  const followState = show.venueFollowed ? 'volgen' : 'normaal';
  return (
    <View style={styles.card}>
      <View style={styles.venueHeader}>
        <Pressable
          onPress={() => router.push(`/venue/${venue.slug}` as never)}
          style={styles.venueHeaderLeft}
        >
          <View
            style={[styles.venueAvatar, { backgroundColor: roles.bgLift }]}
          >
            {venue.imageUrl ? (
              <Image
                source={{ uri: venue.imageUrl }}
                style={styles.venueAvatarImg}
                contentFit="cover"
              />
            ) : (
              <Text
                style={[styles.venueAvatarFallback, { color: roles.fgMuted }]}
              >
                {venue.name.slice(0, 1).toUpperCase()}
              </Text>
            )}
          </View>
          <View style={styles.venueHeaderText}>
            <Text
              numberOfLines={1}
              style={[styles.venueHeaderName, { color: roles.fg }]}
            >
              {venue.name}
            </Text>
            {(venue.type || venue.wijk) && (
              <Text
                numberOfLines={1}
                style={[styles.venueHeaderType, { color: roles.fgMuted }]}
              >
                {[
                  venue.type ? translateVenueType(venue.type, locale) : null,
                  venue.wijk ? formatWijk(venue.wijk) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            )}
          </View>
        </Pressable>
        <FollowVenueButton
          venueId={venue.id}
          name={venue.name}
          state={followState}
          size={36}
        />
      </View>
      {(() => {
        const goDetail = () =>
          router.push(`/event/${show.id}?source=theater` as never);
        const bannerStyle = [
          styles.banner,
          { backgroundColor: roles.bgLift, aspectRatio: bannerAspect },
        ];
        const overlays = (
          <>
            <View style={[styles.disciplineChip, { backgroundColor: roles.accent }]}>
              <Text style={[styles.disciplineText, { color: roles.onAccent }]}>
                {DISCIPLINE_LABELS[discipline][locale === 'en' ? 'en' : 'nl'].toLowerCase()}
              </Text>
            </View>
            {isFallbackImage && <BannerTitleOverlay title={show.title} />}
          </>
        );
        return banner ? (
          <PinchableImage
            uri={banner}
            onLoad={onBannerLoad}
            onPress={goDetail}
            style={bannerStyle}
          >
            {overlays}
          </PinchableImage>
        ) : (
          <Pressable onPress={goDetail}>
            <View style={bannerStyle}>{overlays}</View>
          </Pressable>
        );
      })()}
      {actionOccurrence && (
        <EventActions
          eventId={show.id}
          eventTitle={show.title}
          occurrenceId={actionOccurrence.id}
          ticketUrl={actionOccurrence.ticketUrl ?? show.ticketUrl ?? null}
          invitedCount={show.myInvitesCount ?? 0}
        />
      )}
      <Pressable
        onPress={() =>
          router.push(`/event/${show.id}?source=theater` as never)
        }
        style={styles.body}
      >
        <Text style={[styles.title, { color: roles.fg }]} numberOfLines={2}>
          {show.title}
        </Text>
        {visibleDates.length > 0 && (
          <Text style={[styles.dates, { color: roles.fgRead }]}>
            {visibleDates.map((d, i) => {
              const isToday =
                d.getTime() >= todayStart && d.getTime() < tomorrowStart;
              const sep = i > 0 ? ' · ' : '';
              return (
                <Text key={i}>
                  {sep}
                  <Text
                    style={
                      isToday
                        ? { color: roles.accent, fontFamily: fontFamily.bold }
                        : undefined
                    }
                  >
                    {formatDate(d)}
                  </Text>
                </Text>
              );
            })}
            {extra > 0 ? ` · +${extra}` : ''}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  chipsRow: {
    paddingHorizontal: HORIZONTAL_PADDING,
    gap: 8,
    alignItems: 'center',
    height: '100%',
  },
  chip: {
    paddingHorizontal: 14,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    letterSpacing: -0.13,
  },
  centerWrap: {
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingVertical: 60,
    alignItems: 'center',
  },
  dim: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.8,
  },
  card: {
    marginBottom: 36,
  },
  venueHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingBottom: 10,
  },
  venueHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  venueAvatar: {
    width: 40,
    height: 40,
    borderRadius: 999,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  venueAvatarImg: { width: '100%', height: '100%' },
  venueAvatarFallback: {
    fontFamily: fontFamily.bold,
    fontSize: 16,
    letterSpacing: -0.2,
  },
  venueHeaderText: { flex: 1, minWidth: 0 },
  venueHeaderName: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
    lineHeight: 18,
  },
  venueHeaderType: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  banner: {
    width: '100%',
    aspectRatio: 1,
    marginBottom: 10,
  },
  bannerImg: { width: '100%', height: '100%' },
  // Pill-stijl gespiegeld aan de Featured-label op Vandaag — zelfde
  // padding, font, letter-spacing zodat alle "label op foto" pills
  // visueel één familie zijn.
  disciplineChip: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  disciplineText: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  body: {
    paddingHorizontal: HORIZONTAL_PADDING,
    gap: 0,
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.34,
    marginBottom: 1,
  },
  dates: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: -0.13,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
