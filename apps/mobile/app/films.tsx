/**
 * Andreas × Film — overzicht van alle films die komende week draaien
 * in de Amsterdamse filmhuizen. 2-koloms poster-grid (Letterboxd-vibe);
 * per film tonen we titel + venue-samenvatting ("Eye + 3 venues") +
 * de eerstvolgende paar tijden van vandaag.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useMemo } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import type { ApiEvent } from '@/lib/api';
import { eventImageUrl } from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { useEvents } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HORIZONTAL_PADDING = 22;
const GRID_GAP = 12;

export default function Films() {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const { width: windowWidth } = useWindowDimensions();

  // Komende 7 dagen — venster bewust kort zodat de grid een "deze week
  // in de bios"-overzicht is, niet een eindeloze catalogus.
  const range = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
    };
  }, []);

  const { data: events, isLoading, error } = useEvents({
    from: range.from,
    to: range.to,
    category: 'Film',
  });

  // Dedupe op event-id (occurrencesInRange kan een film meerdere keren
  // representeren als we 't via die route renderen — voor deze pagina
  // willen we elk event maar één keer).
  const films = useMemo<ApiEvent[]>(() => {
    if (!events) return [];
    const seen = new Set<string>();
    const out: ApiEvent[] = [];
    for (const e of events) {
      if (e.category !== 'Film') continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    // Sorteer op aantal occurrences DESC zodat populaire films
    // (veel screenings deze week) bovenaan staan. Bij gelijke tellingen
    // alfabetisch op title voor consistente volgorde.
    return out.sort((a, b) => {
      const ac = a.occurrenceCount ?? 0;
      const bc = b.occurrenceCount ?? 0;
      if (ac !== bc) return bc - ac;
      return a.title.localeCompare(b.title);
    });
  }, [events]);

  const cardWidth = (windowWidth - HORIZONTAL_PADDING * 2 - GRID_GAP) / 2;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT + 8,
          paddingBottom: insets.bottom + 24,
        }}
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
              {t('Kon films niet laden.', 'Couldn’t load films.')}
            </Text>
          </View>
        )}
        {films.length === 0 && !isLoading && !error && (
          <View style={styles.centerWrap}>
            <Text style={[styles.dim, { color: roles.fgMuted }]}>
              {t(
                'Geen films deze week.',
                'No films this week.'
              )}
            </Text>
          </View>
        )}
        {films.length > 0 && (
          <View style={styles.grid}>
            {films.map((film) => (
              <FilmCard
                key={film.id}
                film={film}
                width={cardWidth}
                locale={locale}
                t={t}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <AppHeader
        title={t('Films', 'Films')}
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

function FilmCard({
  film,
  width,
  locale,
  t,
}: {
  film: ApiEvent;
  width: number;
  locale: ReturnType<typeof useLocale>;
  t: ReturnType<typeof useT>;
}) {
  const roles = useRoles();
  const poster = eventImageUrl(film);

  // Venue-samenvatting: unieke venues uit occurrencesInRange. Pak de
  // primary venue als display-naam en hint bij ≥ 2 venues "+ N".
  const venueLabel = useMemo(() => {
    const occs = film.occurrencesInRange ?? [];
    const names = new Set<string>();
    for (const o of occs) names.add(o.venue?.name ?? film.venue.name);
    if (names.size === 0) names.add(film.venue.name);
    const list = [...names];
    if (list.length === 1) return list[0];
    // Primary first (waar event-niveau aan hangt), dan + N.
    const primary = film.venue.name;
    const others = list.filter((n) => n !== primary).length;
    return `${primary} + ${others}`;
  }, [film]);

  // Vandaag's tijden (tot max 3) als praktische "kan ik vanavond?"-info.
  const todayTimes = useMemo(() => {
    const occs = film.occurrencesInRange ?? [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const todayMs = today.getTime();
    const tomorrowMs = tomorrow.getTime();
    const nowMs = Date.now();
    const times: number[] = [];
    for (const o of occs) {
      const ts = new Date(o.startsAt).getTime();
      if (ts >= nowMs && ts >= todayMs && ts < tomorrowMs) {
        times.push(ts);
      }
    }
    return times
      .sort((a, b) => a - b)
      .slice(0, 3)
      .map((ms) => {
        const d = new Date(ms);
        return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      });
  }, [film]);

  return (
    <Pressable
      onPress={() => router.push(`/event/${film.id}?source=films` as never)}
      style={{ width }}
    >
      <View
        style={[
          styles.poster,
          { backgroundColor: roles.bgLift, borderColor: roles.bgChip },
        ]}
      >
        {poster ? (
          <Image source={{ uri: poster }} style={styles.posterImg} contentFit="cover" />
        ) : null}
      </View>
      <Text
        numberOfLines={2}
        style={[styles.title, { color: roles.fg }]}
      >
        {film.title}
      </Text>
      <Text
        numberOfLines={1}
        style={[styles.venueLine, { color: roles.fgMuted }]}
      >
        {venueLabel}
      </Text>
      {todayTimes.length > 0 ? (
        <Text
          numberOfLines={1}
          style={[styles.timesLine, { color: roles.accent }]}
        >
          {t(`vandaag ${todayTimes.join(' · ')}`, `today ${todayTimes.join(' · ')}`)}
        </Text>
      ) : (
        <Text
          numberOfLines={1}
          style={[styles.timesLine, { color: roles.fgPlaceholder }]}
        >
          {t(
            `${film.occurrenceCount ?? 0} × deze week`,
            `${film.occurrenceCount ?? 0} × this week`
          )}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: HORIZONTAL_PADDING,
    gap: GRID_GAP,
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
  poster: {
    aspectRatio: 2 / 3,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 8,
  },
  posterImg: { width: '100%', height: '100%' },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    lineHeight: 18,
    letterSpacing: -0.21,
    marginBottom: 4,
  },
  venueLine: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  timesLine: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
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
