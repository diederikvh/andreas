import { useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useRef } from 'react';
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
  // Re-tap op de Vandaag-tab scrollt deze strook terug naar het begin.
  // useScrollToTop bindt aan een ScrollView-ref en vuurt op tabPress
  // wanneer dit scherm focused is — werkt 1-op-1 voor horizontale en
  // verticale ScrollViews. Hook staat vóór de early-return zodat
  // Rules of Hooks gerespecteerd blijven.
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const exhibitions = exhibitionEvents.filter((e) => e.kind === 'exhibition');
  const total = series.length + exhibitions.length;
  if (total === 0) return null;

  // Bij precies één item: ipv een horizontale scroller een vol-brede
  // card. Geen scroll-affordance is dan onnodig en de single hero
  // krijgt zo z'n eigen ademruimte.
  const single = total === 1;

  // Kicker als lege string of undefined → geen kop. Vandaag laat 'm
  // bewust weg omdat de ene rij festivals/exhibitions visueel
  // duidelijk genoeg is zonder label.
  const showHead = Boolean(kicker && kicker.length > 0);

  return (
    <View style={styles.section}>
      {showHead && (
        <View style={styles.head}>
          <Text style={[styles.headLabel, { color: roles.fg }]}>
            {kicker}
          </Text>
        </View>
      )}
      {single ? (
        <View style={styles.singleWrap}>
          {series.map((s) => (
            <SeriesCard key={`s-${s.id}`} series={s} wide />
          ))}
          {exhibitions.map((e) => (
            <ExhibitionCard key={`e-${e.id}`} event={e} wide />
          ))}
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
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
      )}
    </View>
  );
}

function SeriesCard({
  series,
  wide,
}: {
  series: ApiSeriesListItem;
  wide?: boolean;
}) {
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
        wide && styles.cardWide,
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

function ExhibitionCard({
  event,
  wide,
}: {
  event: ApiEvent;
  wide?: boolean;
}) {
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
      onPress={() => router.push(`/event/${event.id}?source=avond` as never)}
      style={[
        styles.card,
        wide && styles.cardWide,
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
  // Visueel gematcht aan de Rail-component zodat de strook dezelfde
  // kop-typografie heeft als de andere rails op Vandaag.
  section: { paddingTop: 4, paddingBottom: 4 },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 22,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 10,
  },
  headLabel: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
    flexShrink: 1,
  },
  scroller: {
    gap: 10,
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
  // Wrapper voor de single-card-mode: zelfde inset als de scroller
  // zodat de card visueel op dezelfde plek begint als 'ie tussen
  // andere cards zou staan.
  singleWrap: {
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
  card: {
    width: 220,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  // Override voor single-card-mode: vol-breed binnen de wrapper.
  cardWide: {
    width: '100%',
  },
  cardImg: {
    width: '100%',
    height: 130,
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
