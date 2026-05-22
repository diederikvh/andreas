/**
 * Andreas × Live — overzicht van livemuziek op podia (Paradiso,
 * Melkweg, Bimhuis, Q-Factory, etc.) komende ~7 dagen. Date-
 * gegroepeerd ('Vanavond' / 'Vr 23 mei'), per concert banner-image,
 * tijd + venue, titel/lineup en genre-chips.
 *
 * Verschil met /clubs: alleen events met start vóór 23:00 — late
 * podium-feesten horen bij clubs, niet bij Live.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { RefreshBanner } from '@/components/RefreshBanner';
import type { ApiEvent, ApiOccurrence } from '@/lib/api';
import {
  dowMixed,
  eventImageUrl,
  monthShort,
  rowTimeLabel,
} from '@/lib/eventDisplay';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { useEvents } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HORIZONTAL_PADDING = 14;
const CHIPROW_HEIGHT = 36;

interface LiveShow {
  id: string;
  event: ApiEvent;
  occurrence: ApiOccurrence;
}

type GenreBucket =
  | 'rock'
  | 'hiphop'
  | 'jazz'
  | 'klassiek'
  | 'pop'
  | 'electronic'
  | 'wereld'
  | 'overig';

const BUCKET_LABELS: Record<GenreBucket, { nl: string; en: string }> = {
  rock: { nl: 'Rock/Indie', en: 'Rock/Indie' },
  hiphop: { nl: 'Hip-hop', en: 'Hip-hop' },
  jazz: { nl: 'Jazz', en: 'Jazz' },
  klassiek: { nl: 'Klassiek', en: 'Classical' },
  pop: { nl: 'Pop', en: 'Pop' },
  electronic: { nl: 'Electronic', en: 'Electronic' },
  wereld: { nl: 'Wereld', en: 'World' },
  overig: { nl: 'Overig', en: 'Other' },
};

/** Map alle vrije-vorm genres uit de DB naar één van 7 buckets.
    Eerste-match wint — meer specifieke buckets staan eerst zodat
    "indie folk" niet als 'pop' eindigt. Events zonder match → overig. */
function bucketFor(event: ApiEvent): GenreBucket {
  const genres = (event.genres ?? []).map((g) => g.toLowerCase());
  const all = genres.join(' ');
  if (/\b(klassiek|classical|symfon|symphony|kamermuziek|chamber|opera-?music|orkest)\b/.test(all))
    return 'klassiek';
  if (/\b(jazz|bebop|swing|big[- ]?band|fusion|nu[- ]?jazz)\b/.test(all))
    return 'jazz';
  if (/\b(hip[- ]?hop|rap|trap|urban|r&b|rnb|r ?and ?b)\b/.test(all))
    return 'hiphop';
  if (/\b(electronic|elektronisch|ambient|idm|drone|experimental|electronica)\b/.test(all))
    return 'electronic';
  if (/\b(world|wereld|latin|latino|afro|afrobeat|reggae|dub|ska|cumbia|balkan|gypsy)\b/.test(all))
    return 'wereld';
  if (/\b(indie|alternative|alt[- ]?rock|rock|post[- ]?rock|punk|metal|hardcore|garage|noise|grunge|emo|shoegaze)\b/.test(all))
    return 'rock';
  if (/\b(pop|singer[- ]?songwriter|acoustic|folk|country|top[- ]?40)\b/.test(all))
    return 'pop';
  return 'overig';
}

export default function Live() {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<GenreBucket | 'all'>('all');

  // Vandaag t/m eerstvolgende zondag (zelfde patroon als /clubs).
  const range = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const dow = from.getDay();
    const daysIncluded = dow === 0 ? 8 : 8 - dow;
    const to = new Date(from);
    to.setDate(to.getDate() + daysIncluded);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

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

  // Filter: venue.type='podium' AND category='Muziek' EN start < 23:00
  // (late shows behoren bij clubs-page). Bimhuis (jazz, 20:30), Q-
  // Factory, Patronaat, Paradiso main hall (concerten 19:30-21:00),
  // Melkweg podium, etc.
  const shows = useMemo<LiveShow[]>(() => {
    if (!events) return [];
    const now = Date.now();
    const out: LiveShow[] = [];
    for (const e of events) {
      if (e.category !== 'Muziek') continue;
      if (e.venue.type !== 'podium') continue;
      for (const o of e.occurrencesInRange ?? []) {
        const ts = new Date(o.startsAt).getTime();
        if (ts < now - 4 * 3600 * 1000) continue;
        const hour = new Date(o.startsAt).getHours();
        // Late events (≥23:00) zijn club-nachten — die zien we op
        // /clubs. Live is voor de eerdere concert-shows.
        if (hour >= 23) continue;
        out.push({ id: `${e.id}::${o.id}`, event: e, occurrence: o });
      }
    }
    return out.sort(
      (a, b) =>
        new Date(a.occurrence.startsAt).getTime() -
        new Date(b.occurrence.startsAt).getTime()
    );
  }, [events]);

  // Counts per bucket — voor de chip-labels. Lege buckets verbergen
  // we zodat de chip-row consistent oogt over runs (geen klassiek-chip
  // als er deze week niets klassieks is).
  const counts = useMemo(() => {
    const c: Record<GenreBucket, number> = {
      rock: 0,
      hiphop: 0,
      jazz: 0,
      klassiek: 0,
      pop: 0,
      electronic: 0,
      wereld: 0,
      overig: 0,
    };
    for (const s of shows) c[bucketFor(s.event)] += 1;
    return c;
  }, [shows]);

  const visibleChips: GenreBucket[] = (
    ['rock', 'hiphop', 'jazz', 'klassiek', 'pop', 'electronic', 'wereld', 'overig'] as GenreBucket[]
  ).filter((b) => counts[b] > 0);

  const filtered = useMemo(() => {
    if (selected === 'all') return shows;
    return shows.filter((s) => bucketFor(s.event) === selected);
  }, [shows, selected]);

  // Groeperen per kalenderdag (geen 06:00-shift zoals clubs — Live-
  // events lopen niet typisch over middernacht).
  const grouped = useMemo(() => {
    const buckets = new Map<string, LiveShow[]>();
    for (const s of filtered) {
      const d = new Date(s.occurrence.startsAt);
      const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const list = buckets.get(key);
      if (list) list.push(s);
      else buckets.set(key, [s]);
    }
    return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

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
      <ScrollView
        contentContainerStyle={{
          paddingTop:
            insets.top +
            HEADER_HEIGHT +
            (visibleChips.length > 0 ? CHIPROW_HEIGHT : 0),
          paddingBottom: insets.bottom + 24,
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
            progressViewOffset={
              insets.top +
              HEADER_HEIGHT +
              (visibleChips.length > 0 ? CHIPROW_HEIGHT : 0) +
              60
            }
          />
        }
      >
        {isLoading && (
          <View style={styles.centerWrap}>
            <Text style={[styles.dim, { color: roles.fgMuted }]}>
              {t('Laden…', 'Loading…')}
            </Text>
          </View>
        )}
        {error && (
          <View style={styles.centerWrap}>
            <Text style={[styles.dim, { color: roles.fgMuted }]}>
              {t('Kon live niet laden.', 'Couldn’t load live.')}
            </Text>
          </View>
        )}
        {shows.length === 0 && !isLoading && !error && (
          <View style={styles.centerWrap}>
            <Text style={[styles.dim, { color: roles.fgMuted }]}>
              {t('Geen concerten deze week.', 'No live shows this week.')}
            </Text>
          </View>
        )}
        {grouped.map(([key, items], idx) => (
          <View key={key}>
            {idx > 0 && (
              <View style={[styles.dayDivider, { backgroundColor: roles.accent }]} />
            )}
            <Text
              style={[
                styles.dateHeader,
                {
                  color: idx === 0 ? roles.accent : roles.fg,
                  paddingTop: idx === 0 ? 4 : 20,
                },
              ]}
            >
              {dateHeader(items[0].occurrence.startsAt, locale, idx === 0)}
            </Text>
            {items.map((s) => (
              <LiveShowCard
                key={s.id}
                show={s}
                locale={locale}
                t={t}
                isToday={idx === 0}
              />
            ))}
          </View>
        ))}
      </ScrollView>

      <AppHeader
        title={t('Live', 'Live')}
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
                count={shows.length}
                active={selected === 'all'}
                onPress={() => setSelected('all')}
              />
              {visibleChips.map((b) => (
                <Chip
                  key={b}
                  label={BUCKET_LABELS[b][locale === 'en' ? 'en' : 'nl']}
                  count={counts[b]}
                  active={selected === b}
                  onPress={() => setSelected(b)}
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
          // Inactief: half-transparante bg-tint zodat de AppHeader-
          // blur er doorheen scheen. Actief: accent-vlak. Geen border.
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

function LiveShowCard({
  show,
  locale,
  t,
  isToday,
}: {
  show: LiveShow;
  locale: Locale;
  t: ReturnType<typeof useT>;
  isToday: boolean;
}) {
  const roles = useRoles();
  const { event, occurrence } = show;
  const banner = eventImageUrl(event);
  const time = rowTimeLabel(occurrence.startsAt, occurrence.endsAt, locale);
  const lineup = occurrence.lineup ?? [];
  const genres = event.genres ?? [];
  const isSoldOut = occurrence.status === 'sold_out';

  const dayLabel = (() => {
    if (isToday) return t('Vandaag', 'Today');
    const d = new Date(occurrence.startsAt);
    const dow = dowMixed(d.getDay(), locale);
    const month = monthShort(d.getMonth(), locale).toLowerCase();
    return `${dow} ${d.getDate()} ${month}`;
  })();

  return (
    <Pressable
      onPress={() =>
        router.push(
          `/event/${event.id}?o=${occurrence.id}&source=live` as never
        )
      }
      style={styles.card}
    >
      <View style={[styles.banner, { backgroundColor: roles.bgLift }]}>
        {banner ? (
          <Image
            source={{ uri: banner }}
            style={styles.bannerImg}
            contentFit="cover"
          />
        ) : null}
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
      </View>
      <View style={styles.body}>
        <View style={styles.metaRow}>
          {dayLabel && (
            <Text
              style={[
                styles.dayChip,
                { color: isToday ? roles.accent : roles.fg },
              ]}
            >
              {dayLabel}
            </Text>
          )}
          <Text style={[styles.time, { color: roles.accent }]}>{time}</Text>
          <Text
            style={[styles.venue, { color: roles.fgMuted }]}
            numberOfLines={1}
          >
            {event.venue.name}
          </Text>
          {isSoldOut && (
            <Text style={[styles.soldOut, { color: roles.fgMuted }]}>
              {t('uitverkocht', 'sold out')}
            </Text>
          )}
        </View>
        <Text style={[styles.title, { color: roles.fg }]} numberOfLines={2}>
          {event.title}
        </Text>
        {lineup.length > 0 && (
          <Text style={[styles.lineup, { color: roles.fgRead }]}>
            {lineup.map((l) => l.name).join(' · ')}
          </Text>
        )}
      </View>
    </Pressable>
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
  dateHeader: {
    fontFamily: fontFamily.displayBold,
    fontSize: 18,
    lineHeight: 22,
    letterSpacing: -0.36,
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingBottom: 10,
  },
  dayDivider: {
    height: 4,
    marginTop: 14,
    width: '100%',
  },
  card: {
    paddingHorizontal: HORIZONTAL_PADDING,
    marginBottom: 22,
  },
  banner: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 10,
  },
  bannerImg: { width: '100%', height: '100%' },
  genresOnBanner: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    maxWidth: '70%',
  },
  body: { gap: 0 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 2,
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
