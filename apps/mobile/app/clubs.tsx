/**
 * Andreas × Clubs — overzicht van clubnachten in komende 7 dagen.
 * Per nacht een entry met banner-image, venue, tijd, volledige lineup
 * en genre-chips. Date-gegroepeerd ("VANAVOND", "VR 23 MEI", etc.).
 *
 * Container-loos design (zoals Films-pagina): geen card-chrome, image
 * en tekst direct op de bg — Resident Advisor-vibe.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
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

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { BannerTitleOverlay } from '@/components/BannerTitleOverlay';
import { EventActions } from '@/components/EventActions';
import { FollowVenueButton } from '@/components/FollowVenueButton';
import { FriendsOnImage } from '@/components/FriendsOnImage';
import { PinchableImage } from '@/components/PinchableImage';
import { RefreshBanner } from '@/components/RefreshBanner';
import type { ApiEvent, ApiOccurrence } from '@/lib/api';
import {
  dowMixed,
  eventImageUrl,
  formatWijk,
  monthShort,
  rowTimeLabel,
  translateVenueType,
} from '@/lib/eventDisplay';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { useEvents } from '@/lib/queries';
import { useImageAspect } from '@/lib/useImageAspect';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HORIZONTAL_PADDING = 14;
const CHIPROW_HEIGHT = 36;

interface ClubNight {
  id: string;
  event: ApiEvent;
  occurrence: ApiOccurrence;
}

type GenreBucket =
  | 'house'
  | 'techno'
  | 'bass'
  | 'hiphop'
  | 'wereld'
  | 'electronic'
  | 'overig';

const BUCKET_LABELS: Record<GenreBucket, { nl: string; en: string }> = {
  house: { nl: 'House & disco', en: 'House & disco' },
  techno: { nl: 'Techno', en: 'Techno' },
  bass: { nl: 'Bass & dnb', en: 'Bass & dnb' },
  hiphop: { nl: 'Hip-hop', en: 'Hip-hop' },
  wereld: { nl: 'Wereld', en: 'World' },
  electronic: { nl: 'Electronic', en: 'Electronic' },
  overig: { nl: 'Overig', en: 'Other' },
};

/** Map vrije genres uit de DB naar één van 7 club-buckets. Specifieke
    eerst (techno wint van electronic, bass wint van electronic). */
function bucketFor(event: ApiEvent): GenreBucket {
  const all = (event.genres ?? []).map((g) => g.toLowerCase()).join(' ');
  if (/\b(techno|minimal|industrial|electro-?punk)\b/.test(all)) return 'techno';
  if (/\b(d&b|drum[- ]?(and|n)[- ]?bass|dnb|dubstep|breakbeat|breaks|jungle|bass)\b/.test(all))
    return 'bass';
  if (/\b(hip[- ]?hop|rap|trap|urban|r&b|rnb|r ?and ?b)\b/.test(all))
    return 'hiphop';
  if (/\b(afro|afrobeat|latin|latino|world|wereld|reggae|dancehall|cumbia|baile|balkan|gypsy)\b/.test(all))
    return 'wereld';
  if (/\b(house|disco|funk|soul|garage|nu[- ]?disco|deep[- ]?house|tech[- ]?house)\b/.test(all))
    return 'house';
  if (/\b(electronic|electronica|idm|ambient|experimental|left[- ]?field|drone)\b/.test(all))
    return 'electronic';
  return 'overig';
}

export default function Clubs() {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<GenreBucket | 'all'>('all');
  const listRef = useRef<SectionList<ClubNight>>(null);
  const selectChip = useCallback((b: GenreBucket | 'all') => {
    setSelected(b);
    // scrollToLocation viewOffset 0 scrollt het eerste item naar y=0
    // — onder de floating header door. We willen 'm gewoon naar top
    // van de scrollable (paddingTop intact).
    listRef.current
      ?.getScrollResponder()
      ?.scrollTo({ y: 0, animated: true });
  }, []);

  // Venster: vandaag t/m de eerstvolgende zondag (incl). Op zondag
  // schuift 't door naar de zondag erna zodat je áltijd minimaal een
  // weekend in beeld hebt. Concreet: dow=0 (zo) → 8 dagen, dow=1 (ma)
  // → 7 dagen, dow=6 (za) → 2 dagen.
  const range = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const dow = from.getDay();
    const daysIncluded = dow === 0 ? 8 : 8 - dow;
    const to = new Date(from);
    to.setDate(to.getDate() + daysIncluded);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  // Default limit van /events is 200 — voor een week met veel films
  // is dat te klein om alle weekend-feesten mee te krijgen. Cap hoog.
  // category=Muziek dekt clubs (DJ-feesten zijn altijd Muziek). Type-
  // filter (club vs. podium-met-nachtprogramma) is té breed voor de
  // server omdat Paradiso/Melkweg (type='podium') ook club-nachten
  // hosten — die filtert `nights` hieronder client-side op begintijd.
  const { data: events, isLoading, error } = useEvents({
    from: range.from,
    to: range.to,
    category: 'Muziek',
    lean: true,
    limit: 2000,
  });

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

  // Verzamel club-occurrences. Definitie van "club-nacht":
  //   - Venue is een echte club (type='club'), of
  //   - Event is Muziek-category én begint laat (22:00+) of na
  //     middernacht (00:00-04:59) — vangt DJ-nachten bij Paradiso/
  //     Melkweg/etc. (die zijn type='podium' maar hosten wel feesten).
  // Concerten die om 20:00 starten vallen er buiten — terecht, dat
  // zijn shows geen feesten.
  const nights = useMemo<ClubNight[]>(() => {
    if (!events) return [];
    const now = Date.now();
    const out: ClubNight[] = [];
    for (const e of events) {
      const isClubVenue = e.venue.type === 'club';
      for (const o of e.occurrencesInRange ?? []) {
        const ts = new Date(o.startsAt).getTime();
        if (ts < now - 4 * 3600 * 1000) continue;
        if (!isClubVenue) {
          if (e.category !== 'Muziek') continue;
          const hour = new Date(o.startsAt).getHours();
          // Pas vanaf 23:00 of na middernacht (tot 05:00) tellen we
          // een non-club-Muziek-event als club-nacht. Anders zou een
          // concert van 21:30 ook meedoen — dat is geen feest.
          const isLateNight = hour >= 23 || hour < 5;
          if (!isLateNight) continue;
        }
        out.push({ id: `${e.id}::${o.id}`, event: e, occurrence: o });
      }
    }
    return out.sort(
      (a, b) =>
        new Date(a.occurrence.startsAt).getTime() -
        new Date(b.occurrence.startsAt).getTime()
    );
  }, [events]);

  // Counts per genre-bucket voor de chip-labels. Lege buckets verbergen
  // we zodat de chip-row consistent oogt over runs (geen techno-chip
  // als er deze week niets techno is).
  const counts = useMemo(() => {
    const c: Record<GenreBucket, number> = {
      house: 0,
      techno: 0,
      bass: 0,
      hiphop: 0,
      wereld: 0,
      electronic: 0,
      overig: 0,
    };
    for (const n of nights) c[bucketFor(n.event)] += 1;
    return c;
  }, [nights]);
  const visibleChips: GenreBucket[] = (
    ['house', 'techno', 'bass', 'hiphop', 'wereld', 'electronic', 'overig'] as GenreBucket[]
  ).filter((b) => counts[b] > 0);

  const filtered = useMemo(() => {
    if (selected === 'all') return nights;
    return nights.filter((n) => bucketFor(n.event) === selected);
  }, [nights, selected]);

  // Group by logical-day (06:00 boundary — clubs die 02:00 op zaterdag
  // draaien horen bij vrijdag-nacht). dateKey = "YYYYMMDD" van de
  // logische dag.
  const sections = useMemo(() => {
    const buckets = new Map<string, ClubNight[]>();
    for (const n of filtered) {
      const d = new Date(n.occurrence.startsAt);
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const list = buckets.get(key);
      if (list) list.push(n);
      else buckets.set(key, [n]);
    }
    const ordered = [...buckets.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    return ordered.map(([key, items], idx) => ({
      key,
      isFirst: idx === 0,
      title: dateHeader(items[0].occurrence.startsAt, locale, idx === 0),
      data: items,
    }));
  }, [filtered, locale]);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner
        visible={refreshing}
        topOffset={
          insets.top +
          HEADER_HEIGHT +
          (visibleChips.length > 0 ? CHIPROW_HEIGHT : 0) +
          8
        }
      />
      <SectionList
        ref={listRef}
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item, section }) => (
          <ClubNightCard
            night={item}
            locale={locale}
            t={t}
            isToday={section.isFirst}
          />
        )}
        renderSectionHeader={() => null}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{
          paddingTop:
            insets.top +
            HEADER_HEIGHT +
            (visibleChips.length > 0 ? CHIPROW_HEIGHT : 0) +
            16,
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
                {t('Kon clubs niet laden.', "Couldn't load clubs.")}
              </Text>
            </View>
          ) : (
            <View style={styles.centerWrap}>
              <Text style={[styles.dim, { color: roles.fgMuted }]}>
                {t('Geen clubnachten deze week.', 'No club nights this week.')}
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
            progressViewOffset={
              insets.top +
              HEADER_HEIGHT +
              (visibleChips.length > 0 ? CHIPROW_HEIGHT : 0) +
              60
            }
          />
        }
        windowSize={9}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
      />

      <AppHeader
        title={t('Clubs', 'Clubs')}
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
        {visibleChips.length > 0 && (
          <View style={{ height: CHIPROW_HEIGHT }}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipsRow}
            >
              <Chip
                label={t('Alle', 'All')}
                count={nights.length}
                active={selected === 'all'}
                onPress={() => selectChip('all')}
              />
              {visibleChips.map((b) => (
                <Chip
                  key={b}
                  label={BUCKET_LABELS[b][locale === 'en' ? 'en' : 'nl']}
                  count={counts[b]}
                  active={selected === b}
                  onPress={() => selectChip(b)}
                />
              ))}
            </ScrollView>
          </View>
        )}
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
        <Text style={{ color: active ? roles.onAccent : roles.fgMuted }}>
          {' '}
          {count}
        </Text>
      </Text>
    </Pressable>
  );
}

function ClubNightCard({
  night,
  locale,
  t,
  isToday,
}: {
  night: ClubNight;
  locale: Locale;
  t: ReturnType<typeof useT>;
  isToday: boolean;
}) {
  const roles = useRoles();
  const { event, occurrence } = night;
  const banner = eventImageUrl(event);
  const { aspect: bannerAspect, onLoad: onBannerLoad } = useImageAspect(banner);
  // Fallback-detectie: geen eigen event-image maar wel venue-image →
  // tonen we de event-titel groot over de venue-foto, zoals op de
  // Featured-card op Vandaag.
  const isFallbackImage = !event.imageUrl && Boolean(event.venue.imageUrl);
  const time = rowTimeLabel(occurrence.startsAt, occurrence.endsAt, locale);
  const lineup = occurrence.lineup ?? [];
  const genres = event.genres ?? [];
  const isSoldOut = occurrence.status === 'sold_out';

  // Day-label altijd zichtbaar; "Vandaag" expliciet zodat je 'm ook
  // herkent ná wat scrollen voorbij de section-header.
  const dayLabel = (() => {
    if (isToday) return t('Vandaag', 'Today');
    const d = new Date(occurrence.startsAt);
    // Pre-06:00 → logische dag is gisteren (zelfde regel als bucket-key).
    const display = new Date(d);
    if (d.getHours() < 6) display.setDate(display.getDate() - 1);
    const dow = dowMixed(display.getDay(), locale);
    const month = monthShort(display.getMonth(), locale).toLowerCase();
    return `${dow} ${display.getDate()} ${month}`;
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
          router.push(
            `/event/${event.id}?o=${occurrence.id}&source=clubs` as never
          );
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
                      {
                        backgroundColor: i === 0 ? roles.accent : roles.fg,
                      },
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
              friends={
                occurrence.friendsSaved ?? event.friendsSaved ?? []
              }
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
          router.push(
            `/event/${event.id}?o=${occurrence.id}&source=clubs` as never
          )
        }
        style={styles.body}
      >
        <Text style={[styles.title, { color: roles.fg }]} numberOfLines={2}>
          {event.title}
        </Text>
        <Text style={styles.metaLine}>
          {dayLabel && (
            <Text
              style={[
                styles.dayChip,
                { color: isToday ? roles.accent : roles.fg },
              ]}
            >
              {dayLabel}{' '}
            </Text>
          )}
          <Text style={[styles.time, { color: roles.accent }]}>{time}</Text>
          {lineup.length > 0 && (
            <Text style={[styles.lineup, { color: roles.fgRead }]}>
              {' · '}
              {lineup.map((l) => l.name).join(' · ')}
            </Text>
          )}
          {isSoldOut && (
            <Text style={[styles.soldOut, { color: roles.fgMuted }]}>
              {' · '}
              {t('uitverkocht', 'sold out')}
            </Text>
          )}
        </Text>
      </Pressable>
    </View>
  );
}

/** "Vanavond" voor index 0; daarna "Vr 23 mei" achtig label. */
function dateHeader(iso: string, locale: Locale, isFirst: boolean): string {
  if (isFirst) return locale === 'en' ? 'Tonight' : 'Vanavond';
  const d = new Date(iso);
  const dow = dowMixed(d.getDay(), locale);
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  return `${dow} ${d.getDate()} ${month}`;
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
  // Volle-breedte accent-balk met dag-label gecentreerd erin —
  // vervangt de oude (lijn + tekst eronder) layout.
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
  body: {
    paddingHorizontal: HORIZONTAL_PADDING,
    gap: 0,
  },
  // Eén Text-block dat dag + tijd + lineup achter elkaar zet — Text
  // wrapt netjes via nested Texts en voorkomt dat dj-namen op aparte
  // regels eindigen los van de tijd.
  metaLine: {
    lineHeight: 18,
    marginTop: 2,
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
  // Venue als kicker — mono uppercase, matcht de rail-cards op Vandaag
  // en /films voor visuele consistentie.
  venue: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  soldOut: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.34,
    marginBottom: 1,
  },
  lineup: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: -0.13,
  },
  genresOnBanner: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    maxWidth: '70%',
  },
  // Pill-stijl gespiegeld aan de Featured-label op Vandaag — zelfde
  // padding, font, letter-spacing zodat alle "label op foto" pills
  // visueel één familie zijn.
  genreChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  genreText: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
