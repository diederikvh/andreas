import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ApiEvent, ApiSeriesListItem } from '@/lib/api';
import { eventImageUrl, monthShort } from '@/lib/eventDisplay';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Horizontale strook met "wat loopt er nu?": eerst actieve series
 * (ADE, Lenteballet, ...) en daarna doorlopende tentoonstellingen.
 *
 * Een tentoonstelling is een event met `kind: 'exhibition'` — typisch
 * één lange occurrence met `endsAt` ver in de toekomst. Een serie is
 * een verzamel-entiteit met een `endsAt` die nog moet komen of
 * `endsAt: null` voor doorlopend. Beide passen slecht in de dag-bucket
 * structuur van Avond/Agenda — dus tonen we ze hier samen, altijd
 * zichtbaar zolang ze lopen.
 *
 * Volgorde: series eerst (vaak herkenbare merknamen, sturen events),
 * exhibitions daarna (veelal vaste-locatie programmering).
 */
export function RunningStrip({
  series,
  exhibitionEvents,
  kicker,
}: {
  series: ApiSeriesListItem[];
  /** Volledige event-lijst — wij filteren intern op `kind: 'exhibition'`
      zodat callers gewoon de events-data uit useEvents kunnen doorgeven
      zonder zelf te filteren. */
  exhibitionEvents: ApiEvent[];
  /** Optionele kop-tekst boven de strook. Default: "Loopt nu". */
  kicker?: string;
}) {
  const roles = useRoles();
  const t = useT();
  const exhibitions = exhibitionEvents.filter((e) => e.kind === 'exhibition');
  const total = series.length + exhibitions.length;
  if (total === 0) return null;

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={[styles.headLabel, { color: roles.fg }]}>
          {kicker ?? t('Loopt nu', 'Running now')}
        </Text>
        <Text style={[styles.headCount, { color: roles.fgMuted }]}>
          {total}
          {total === 1 ? t(' serie/expo', ' series/expo') : t(' lopend', ' running')}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroller}
      >
        {series.map((s) => (
          <SeriesCard key={`s-${s.id}`} series={s} />
        ))}
        {exhibitions.map((e) => (
          <ExhibitionCard key={`e-${e.id}`} event={e} />
        ))}
      </ScrollView>
    </View>
  );
}

function SeriesCard({ series }: { series: ApiSeriesListItem }) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const locale = useLocale();
  const t = useT();
  const dateRange = formatSeriesRange(series.startsAt, series.endsAt, locale, t);
  return (
    <Pressable
      onPress={() => router.push(`/series/${series.slug}` as never)}
      style={[
        styles.card,
        {
          backgroundColor: isNacht ? palette.noir2 : palette.paper2,
          borderColor: isNacht ? '#2a2a2d' : palette.paper,
        },
      ]}
    >
      {series.imageUrl ? (
        <Image
          source={{ uri: series.imageUrl }}
          style={styles.cardImg}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.cardImg,
            { backgroundColor: isNacht ? palette.noir3 : palette.paper },
          ]}
        />
      )}
      <View style={styles.cardBody}>
        <Text
          numberOfLines={1}
          style={[styles.cardName, { color: roles.fg }]}
        >
          {series.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.cardMeta, { color: roles.fgMuted }]}
        >
          {[
            dateRange,
            `${series.eventCount} event${series.eventCount === 1 ? '' : 's'}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
    </Pressable>
  );
}

function ExhibitionCard({ event }: { event: ApiEvent }) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const locale = useLocale();
  const t = useT();
  const endsLabel = formatExhibitionEnd(event.endsAt, locale);
  const subtitle = [
    event.venue.name,
    endsLabel
      ? t(`loopt t/m ${endsLabel}`, `runs until ${endsLabel}`)
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      onPress={() => router.push(`/event/${event.id}` as never)}
      style={[
        styles.card,
        {
          backgroundColor: isNacht ? palette.noir2 : palette.paper2,
          borderColor: isNacht ? '#2a2a2d' : palette.paper,
        },
      ]}
    >
      {eventImageUrl(event) ? (
        <Image
          source={{ uri: eventImageUrl(event)! }}
          style={styles.cardImg}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.cardImg,
            { backgroundColor: isNacht ? palette.noir3 : palette.paper },
          ]}
        />
      )}
      <View style={styles.cardBody}>
        <Text
          numberOfLines={1}
          style={[styles.cardName, { color: roles.fg }]}
        >
          {event.title}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.cardMeta, { color: roles.fgMuted }]}
        >
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

function formatExhibitionEnd(
  endsAt: string | null,
  locale: Locale
): string | null {
  if (!endsAt) return null;
  const d = new Date(endsAt);
  return `${d.getDate()} ${monthShort(d.getMonth(), locale).toLowerCase()}`;
}

function formatSeriesRange(
  startsAt: string | null,
  endsAt: string | null,
  locale: Locale,
  t: (nl: string, en: string) => string
): string | null {
  if (!startsAt) return null;
  const start = new Date(startsAt);
  const end = endsAt ? new Date(endsAt) : null;
  const monthName = (d: Date) => monthShort(d.getMonth(), locale).toLowerCase();
  const day = (d: Date) => String(d.getDate());
  if (!end) {
    return t(
      `Vanaf ${day(start)} ${monthName(start)}`,
      `From ${day(start)} ${monthName(start)}`
    );
  }
  const sameMonth =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth();
  if (sameMonth) return `${day(start)} – ${day(end)} ${monthName(start)}`;
  return `${day(start)} ${monthName(start)} – ${day(end)} ${monthName(end)}`;
}

const styles = StyleSheet.create({
  // Zelfde stijl als de oude Series-strook in Venues voor visuele rust.
  section: { paddingTop: 4, paddingBottom: 4 },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 22,
    paddingTop: 6,
    paddingBottom: 8,
  },
  headLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  headCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  scroller: {
    gap: 10,
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
  card: {
    width: 220,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  cardImg: {
    width: '100%',
    height: 100,
  },
  cardBody: {
    padding: 12,
    gap: 4,
  },
  cardName: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
  },
  cardMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
});
