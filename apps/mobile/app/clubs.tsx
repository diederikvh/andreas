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

interface ClubNight {
  id: string;
  event: ApiEvent;
  occurrence: ApiOccurrence;
}

export default function Clubs() {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();

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

  // Group by logical-day (06:00 boundary — clubs die 02:00 op zaterdag
  // draaien horen bij vrijdag-nacht). dateKey = "YYYYMMDD" van de
  // logische dag.
  const sections = useMemo(() => {
    const buckets = new Map<string, ClubNight[]>();
    for (const n of nights) {
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
  }, [nights, locale]);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner
        visible={refreshing}
        topOffset={insets.top + HEADER_HEIGHT + 8}
      />
      <SectionList
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
        renderSectionHeader={({ section }) => (
          <View>
            {!section.isFirst && (
              <View
                style={[styles.dayDivider, { backgroundColor: roles.accent }]}
              />
            )}
            <Text
              style={[
                styles.dateHeader,
                {
                  color: section.isFirst ? roles.accent : roles.fg,
                  paddingTop: section.isFirst ? 4 : 20,
                },
              ]}
            >
              {section.title}
            </Text>
          </View>
        )}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT,
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
            progressViewOffset={insets.top + HEADER_HEIGHT + 60}
          />
        }
        windowSize={7}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        removeClippedSubviews
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
      />
    </View>
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
  const time = rowTimeLabel(occurrence.startsAt, occurrence.endsAt, locale);
  const lineup = occurrence.lineup ?? [];
  const genres = event.genres ?? [];
  const isSoldOut = occurrence.status === 'sold_out';

  // Toon dag-label op de card zelf wanneer 't NIET vandaag is — zodra
  // je een paar cards verder scrollt mis je 't section-header en denk
  // je anders dat alles vandaag is.
  const dayLabel = (() => {
    if (isToday) return null;
    const d = new Date(occurrence.startsAt);
    // Pre-06:00 → logische dag is gisteren (zelfde regel als bucket-key).
    const display = new Date(d);
    if (d.getHours() < 6) display.setDate(display.getDate() - 1);
    const dow = dowMixed(display.getDay(), locale);
    const month = monthShort(display.getMonth(), locale).toLowerCase();
    return `${dow} ${display.getDate()} ${month}`;
  })();

  return (
    <Pressable
      onPress={() =>
        router.push(
          `/event/${event.id}?o=${occurrence.id}&source=clubs` as never
        )
      }
      style={styles.card}
    >
      <View
        style={[
          styles.banner,
          { backgroundColor: roles.bgLift },
        ]}
      >
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
      </View>
      <View style={styles.body}>
        <View style={styles.metaRow}>
          {dayLabel && (
            <Text style={[styles.dayChip, { color: roles.accent }]}>
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
    // paddingTop wordt inline gezet — meer ruimte ná de divider voor
    // duidelijke dag-overgang.
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
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 10,
  },
  bannerImg: { width: '100%', height: '100%' },
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
