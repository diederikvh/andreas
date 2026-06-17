/**
 * "Voor jou" feed-pagina. Chronologische infinite-scroll lijst van
 * events die de scoring leuk vindt voor deze gebruiker: events bij
 * gevolgde venues, events met genre-overlap met je save-historie, en
 * events waar vrienden naartoe gaan. Sortering is pure chronologisch
 * (eerstvolgende eerst), zodat je natuurlijk door je persoonlijke
 * agenda heen scrollt zonder per dag te hoeven klikken.
 *
 * Visueel matcht dit scherm de "insta-vibe" van /clubs, /live,
 * /theater en /films: banner-led full-width cards, venue-header met
 * avatar, genre-chips op het beeld, accent-day-bars tussen dagen.
 * Chip-row bovenaan filtert op Muziek/Theater/Film/Kunst/Lezing
 * (zonder counts, dat past niet bij de gemixte feed).
 *
 * Backend: `GET /events/for-you?mode=feed&category=...`. Pagina-size 20.
 */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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

import { AanbevolenPicker } from '@/components/AanbevolenPicker';
import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { BannerTitleOverlay } from '@/components/BannerTitleOverlay';
import { EventActions } from '@/components/EventActions';
import { FollowVenueButton } from '@/components/FollowVenueButton';
import { FriendsOnImage } from '@/components/FriendsOnImage';
import { PinchableImage } from '@/components/PinchableImage';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SpinningCross } from '@/components/SpinningCross';
import { useSession } from '@/lib/authClient';
import type { ApiEvent, ApiOccurrence } from '@/lib/api';
import {
  dowMixed,
  eventImageUrl,
  formatWijk,
  isLongRunning,
  isMultiDay,
  monthShort,
  rowTimeLabel,
  translateVenueType,
} from '@/lib/eventDisplay';
import { useT, useLocale, type Locale } from '@/lib/i18n';
import { useForYouFeed, useMySaves } from '@/lib/queries';
import { useImageAspect } from '@/lib/useImageAspect';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HORIZONTAL_PADDING = 14;
const CHIPROW_HEIGHT = 36;

type FeedNight = {
  id: string;
  event: ApiEvent;
  occurrence: ApiOccurrence;
};

type CategoryFilter = ApiEvent['category'];
const CATEGORY_LABELS: Record<CategoryFilter, { nl: string; en: string }> = {
  Muziek: { nl: 'Muziek', en: 'Music' },
  Theater: { nl: 'Theater', en: 'Theatre' },
  Film: { nl: 'Film', en: 'Film' },
  Kunst: { nl: 'Kunst', en: 'Art' },
  Lezing: { nl: 'Lezing', en: 'Talk' },
  Literatuur: { nl: 'Literatuur', en: 'Literature' },
};
const CATEGORY_ORDER: CategoryFilter[] = [
  'Muziek',
  'Theater',
  'Film',
  'Kunst',
  'Lezing',
  'Literatuur',
];

export default function VoorJouScreen() {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const qc = useQueryClient();

  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);

  // Picker-overlay state — open in onboarding-mode (eerste open zonder
  // profiel-signaal) of settings-mode (tap topbar-icoon).
  const [pickerMode, setPickerMode] = useState<
    'onboarding' | 'settings' | null
  >(null);

  // Saves-status bepaalt of we automatisch onboarding tonen — een user
  // zonder saves én lege feed is een first-time visit.
  const { data: saves } = useMySaves({ enabled: authed });

  // Categorie-filter chips — multi-select, lege Set = alle categorieën
  // (= "Alle"-chip actief). Tap op een cat-chip toggled in/out; tap
  // op "Alle" leegt de set. Zonder counts: bij de feed weet je pas
  // na fetch hoeveel events er per categorie zijn (server-side filter).
  const [selected, setSelected] = useState<Set<CategoryFilter>>(new Set());
  const categoriesArr = useMemo(() => [...selected], [selected]);

  const {
    data,
    isLoading,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useForYouFeed({ enabled: authed, categories: categoriesArr });

  // Auto-open onboarding-overlay één keer per visit als we voor het
  // eerst constateren dat user geen profiel-input heeft. `pickerMode`
  // wordt nooit auto-gereset → na sluiten van de overlay komt-ie niet
  // terug deze sessie.
  const feedEmpty = !isLoading && !error && data && data.pages[0]?.events.length === 0;
  const noSaves = saves !== undefined && saves.length === 0;
  const shouldOnboardingShow =
    authed && feedEmpty && noSaves && pickerMode === null;
  useEffect(() => {
    if (shouldOnboardingShow) setPickerMode('onboarding');
  }, [shouldOnboardingShow]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await qc.invalidateQueries({ queryKey: ['events', 'for-you', 'feed'] });
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) await new Promise((r) => setTimeout(r, 700 - elapsed));
      setRefreshing(false);
    }
  }, [qc]);

  // Flatten alle paginated pages naar één lijst van (event, occurrence)-paren.
  const nights = useMemo<FeedNight[]>(() => {
    if (!data) return [];
    const out: FeedNight[] = [];
    for (const page of data.pages) {
      for (const e of page.events) {
        if (!e.startsAt) continue;
        // Synthesiseer een minimal occurrence uit event-level fields
        // zodat ClubNightCard-stijl rendering werkt.
        const occ: ApiOccurrence = {
          id: `${e.id}::head`,
          startsAt: e.startsAt,
          endsAt: e.endsAt ?? null,
          priceCents: e.priceCents ?? null,
          priceNote: e.priceNote ?? null,
          ticketUrl: e.ticketUrl ?? null,
          room: null,
          lineup: null,
          status: 'scheduled',
          venue: e.nextOccurrenceVenue ?? null,
          friendsSaved: e.friendsSaved ?? [],
          friendsSavedCount: e.friendsSavedCount ?? 0,
        };
        out.push({ id: `${e.id}-${e.startsAt}`, event: e, occurrence: occ });
      }
    }
    return out;
  }, [data]);

  // Group per logical day (events na middernacht horen bij de avond
  // ervoor — 6:00 als boundary, zelfde regel als /clubs).
  const sections = useMemo(() => {
    if (nights.length === 0) return [];
    const buckets = new Map<string, FeedNight[]>();
    for (const n of nights) {
      const d = new Date(n.occurrence.startsAt);
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const list = buckets.get(key);
      if (list) list.push(n);
      else buckets.set(key, [n]);
    }
    const ordered = [...buckets.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    return ordered.map(([key, items], idx) => ({
      key,
      isFirst: idx === 0,
      title: dateHeader(items[0].occurrence.startsAt, locale, idx === 0),
      data: items,
    }));
  }, [nights, locale]);

  const topInset =
    insets.top + HEADER_HEIGHT + CHIPROW_HEIGHT + 8;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner visible={refreshing} topOffset={topInset} />
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item, section }) => (
          <FeedCard
            night={item}
            locale={locale}
            t={t}
            isToday={section.isFirst}
          />
        )}
        renderSectionHeader={() => null}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{
          paddingTop: topInset + 8,
          paddingBottom: insets.bottom + 24,
        }}
        ListEmptyComponent={
          !authed ? (
            <View style={styles.centerWrap}>
              <Ionicons name="sparkles-outline" size={42} color={roles.fgMuted} />
              <Text style={[styles.dim, { color: roles.fg }]}>
                {t('Log in voor Voor jou', 'Sign in for For you')}
              </Text>
              <Text style={[styles.dimSub, { color: roles.fgMuted }]}>
                {t(
                  'Save events en volg venues om hier persoonlijke aanbevelingen te krijgen.',
                  'Save events and follow venues for personal recommendations.',
                )}
              </Text>
            </View>
          ) : isLoading ? (
            <View style={[styles.centerWrap, { paddingTop: 80 }]}>
              <SpinningCross size={28} color={roles.fgPlaceholder} />
            </View>
          ) : error ? (
            <View style={styles.centerWrap}>
              <Text style={[styles.dim, { color: roles.fgMuted }]}>
                {t('Kon Voor jou niet laden.', 'Couldn’t load For you.')}
              </Text>
            </View>
          ) : (
            <View style={styles.centerWrap}>
              <Text style={[styles.dim, { color: roles.fgMuted }]}>
                {selected.size > 0
                  ? t(
                      'Geen aanbevelingen in deze categorieën.',
                      'No recommendations in these categories.',
                    )
                  : t(
                      'Nog niets om aan te bevelen.',
                      'Nothing to recommend yet.',
                    )}
              </Text>
              <Text style={[styles.dimSub, { color: roles.fgMuted }]}>
                {t(
                  'Save events of volg venues, dan vullen we deze feed.',
                  'Save events or follow venues to fill this feed.',
                )}
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
            progressViewOffset={topInset + 60}
          />
        }
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) fetchNextPage();
        }}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={styles.footerLoading}>
              <ActivityIndicator color={roles.fgMuted} />
            </View>
          ) : null
        }
        windowSize={9}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
      />

      <AppHeader
        title={t('Voor jou', 'For you')}
        hideAvatar
        rightSlot={
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {/* Settings-icoon — alleen tonen wanneer user al een profiel
                heeft (saves of follows die de feed gevuld hebben). In
                first-time onboarding-state is er nog niets om te tunen. */}
            {authed && !noSaves && (
              <Pressable
                onPress={() => setPickerMode('settings')}
                hitSlop={8}
                style={[
                  styles.closeBtn,
                  { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
                ]}
              >
                <Ionicons name="options-outline" size={18} color={roles.fg} />
              </Pressable>
            )}
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
          </View>
        }
      >
        <View style={{ height: CHIPROW_HEIGHT }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsRow}
          >
            <Chip
              label={t('Alle', 'All')}
              active={selected.size === 0}
              onPress={() => setSelected(new Set())}
            />
            {CATEGORY_ORDER.map((cat) => (
              <Chip
                key={cat}
                label={CATEGORY_LABELS[cat][locale === 'en' ? 'en' : 'nl']}
                active={selected.has(cat)}
                onPress={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(cat)) next.delete(cat);
                    else next.add(cat);
                    return next;
                  })
                }
              />
            ))}
          </ScrollView>
        </View>
      </AppHeader>

      {/* Picker-overlay — full-screen modal-stijl. Onboarding-mode
          opent automatisch bij lege feed + geen saves; settings-mode
          opent via topbar-knop. Beide eindigen op feed-invalidate via
          de mutation in de picker zelf. */}
      {pickerMode && (
        <View
          style={[
            styles.pickerOverlay,
            {
              backgroundColor: roles.bg,
              // insets.top matcht de AppHeader's eigen paddingTop —
              // de close-knop in de picker valt zo precies op de
              // positie van de close-knop in de feed eronder.
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
            },
          ]}
        >
          <AanbevolenPicker
            mode={pickerMode}
            onClose={() => setPickerMode(null)}
            onDone={() => setPickerMode(null)}
          />
        </View>
      )}
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
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
      </Text>
    </Pressable>
  );
}

function FeedCard({
  night,
  locale,
  t,
}: {
  night: FeedNight;
  locale: Locale;
  t: ReturnType<typeof useT>;
  isToday: boolean;
}) {
  const roles = useRoles();
  const { event, occurrence } = night;
  const banner = eventImageUrl(event);
  const { aspect: bannerAspect, onLoad: onBannerLoad } = useImageAspect(banner);
  const isFallbackImage = !event.imageUrl && Boolean(event.venue.imageUrl);
  const time = rowTimeLabel(occurrence.startsAt, occurrence.endsAt, locale);
  const genres = event.genres ?? [];
  const isSoldOut = occurrence.status === 'sold_out';

  // Datum-label boven de meta-line. Multi-day events tonen een range
  // ("12 sep – 14 sep" of "t/m 31 mei" voor long-running) zodat een
  // expo of festival in de feed niet als één-dag-event leest.
  const dayLabel = (() => {
    const start = new Date(occurrence.startsAt);
    if (start.getHours() < 6) start.setDate(start.getDate() - 1);
    const endIso = event.endsAt ?? occurrence.endsAt ?? null;
    const longRun = isLongRunning(occurrence.startsAt, endIso);
    const multi = isMultiDay(occurrence.startsAt, endIso);
    const startDow = dowMixed(start.getDay(), locale);
    const startMonth = monthShort(start.getMonth(), locale).toLowerCase();
    if (longRun && endIso) {
      const end = new Date(endIso);
      const endMonth = monthShort(end.getMonth(), locale).toLowerCase();
      return locale === 'en'
        ? `until ${end.getDate()} ${endMonth}`
        : `t/m ${end.getDate()} ${endMonth}`;
    }
    if (multi && endIso) {
      const end = new Date(endIso);
      const endDow = dowMixed(end.getDay(), locale);
      const endMonth = monthShort(end.getMonth(), locale).toLowerCase();
      const sameMonth = start.getMonth() === end.getMonth();
      const left = `${startDow} ${start.getDate()}${sameMonth ? '' : ' ' + startMonth}`;
      const right = `${endDow} ${end.getDate()} ${endMonth}`;
      return `${left} – ${right}`;
    }
    return `${startDow} ${start.getDate()} ${startMonth}`;
  })();

  const venue = event.venue;
  const followState = event.venueFollowed ? 'volgen' : 'normaal';
  return (
    <View style={styles.card}>
      <View style={styles.venueHeader}>
        <Pressable
          onPress={() => router.push(`/venue/${venue.slug}` as never)}
          style={styles.venueHeaderLeft}
        >
          <View style={[styles.venueAvatar, { backgroundColor: roles.bgLift }]}>
            {venue.imageUrl ? (
              <Image
                source={{ uri: venue.imageUrl }}
                style={styles.venueAvatarImg}
                contentFit="cover"
              />
            ) : (
              <Text style={[styles.venueAvatarFallback, { color: roles.fgMuted }]}>
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
          router.push(`/event/${event.id}?source=voor-jou` as never);
        const bannerStyle = [
          styles.banner,
          { backgroundColor: roles.bgLift, aspectRatio: bannerAspect },
        ];
        const overlays = (
          <>
            {genres.length > 0 && (
              <View style={styles.genresOnBanner}>
                {genres.slice(0, 3).map((g, i) => (
                  <View
                    key={g}
                    style={[
                      styles.genreChip,
                      { backgroundColor: i === 0 ? roles.accent : roles.fg },
                    ]}
                  >
                    <Text
                      style={[
                        styles.genreText,
                        { color: i === 0 ? roles.onAccent : roles.bg },
                      ]}
                    >
                      {g}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            {isFallbackImage && <BannerTitleOverlay title={event.title} />}
            <FriendsOnImage
              friends={occurrence.friendsSaved ?? event.friendsSaved ?? []}
              totalCount={
                occurrence.friendsSavedCount ?? event.friendsSavedCount
              }
            />
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
      <EventActions
        eventId={event.id}
        eventTitle={event.title}
        occurrenceId={occurrence.id}
        ticketUrl={occurrence.ticketUrl ?? event.ticketUrl ?? null}
        invitedCount={event.myInvitesCount ?? 0}
      />
      <Pressable
        onPress={() =>
          router.push(`/event/${event.id}?source=voor-jou` as never)
        }
        style={styles.body}
      >
        <Text style={[styles.title, { color: roles.fg }]} numberOfLines={2}>
          {event.title}
        </Text>
        <Text style={styles.metaLine}>
          {dayLabel && (
            <Text style={[styles.dayChip, { color: roles.fg }]}>
              {dayLabel}{' '}
            </Text>
          )}
          <Text style={[styles.time, { color: roles.accent }]}>{time}</Text>
          {isSoldOut && (
            <Text style={[styles.soldOut, { color: roles.fgMuted }]}>
              {' · '}
              {t('uitverkocht', 'sold out')}
            </Text>
          )}
        </Text>
        {event.reason ? (
          <Text style={[styles.reason, { color: roles.accent }]} numberOfLines={1}>
            {event.reason}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

function dateHeader(iso: string, locale: Locale, isFirst: boolean): string {
  if (isFirst) return locale === 'en' ? 'Tonight' : 'Vanavond';
  const d = new Date(iso);
  const dow = dowMixed(d.getDay(), locale);
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  return `${dow} ${d.getDate()} ${month}`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  card: {
    marginBottom: 28,
  },
  venueHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingBottom: 8,
  },
  venueHeaderLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  venueAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  venueAvatarImg: { width: '100%', height: '100%' },
  venueAvatarFallback: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
  },
  venueHeaderText: { flex: 1, minWidth: 0 },
  venueHeaderName: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  venueHeaderType: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    marginTop: 1,
  },
  banner: {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  genresOnBanner: {
    position: 'absolute',
    top: 10,
    left: 10,
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
    maxWidth: '85%',
  },
  genreChip: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  genreText: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: -0.11,
    textTransform: 'lowercase',
  },
  body: {
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingTop: 4,
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.34,
    marginBottom: 1,
  },
  metaLine: {
    lineHeight: 18,
    marginTop: 2,
  },
  reason: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 3,
  },
  dayChip: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    letterSpacing: -0.13,
  },
  time: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    letterSpacing: -0.13,
  },
  soldOut: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
  },
  dayBar: {
    width: '100%',
    paddingVertical: 10,
    marginTop: 14,
    marginBottom: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayBarText: {
    fontFamily: fontFamily.displayBold,
    fontSize: 16,
    lineHeight: 20,
    letterSpacing: -0.32,
  },
  centerWrap: {
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingVertical: 80,
    alignItems: 'center',
    gap: 10,
  },
  dim: {
    fontFamily: fontFamily.medium,
    fontSize: 16,
    textAlign: 'center',
  },
  dimSub: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 320,
  },
  footerLoading: { paddingVertical: 24, alignItems: 'center' },
  pickerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // AppHeader heeft zIndex 10 — picker moet daarbovenop.
    zIndex: 20,
    elevation: 20,
  },
});
