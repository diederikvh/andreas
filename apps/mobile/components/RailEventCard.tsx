import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  RAIL_CARD_IMG_HEIGHT,
  RAIL_CARD_WIDTH,
  useRailCardStyles,
} from '@/components/Rail';
import type { ApiEvent } from '@/lib/api';
import {
  dowMixed,
  eventImageUrl,
  formatDateRange,
  isAllDayRange,
  isMultiDay,
  monthShort,
  rowTimeLabel,
} from '@/lib/eventDisplay';
import { useLocale } from '@/lib/i18n';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/** Compacte event-kaart voor in een horizontale rail.
 *  Image-header + body (titel + venue + tijd). Tap navigeert naar
 *  event-detail; optioneel met occurrence-id zodat de drawer/hero op
 *  de juiste avond opent.
 */
export function RailEventCard({
  event,
  occurrenceId,
  occurrenceStartsAt,
  occurrenceEndsAt,
  occurrenceVenueName,
  wide = false,
  showDate = false,
  reason,
}: {
  event: ApiEvent;
  /** Optionele specifieke occurrence — als gezet, geeft 'm mee als
      ?o=... query-param naar event-detail. */
  occurrenceId?: string;
  /** Wanneer een specifieke occurrence wordt getoond: tijd-label gebruikt
      díe occurrence ipv de event-level startsAt. */
  occurrenceStartsAt?: string;
  occurrenceEndsAt?: string | null;
  /** Voor films met meerdere bioscopen: venue van de getoonde occurrence.
      Bij `null`/`undefined` valt 't terug op `event.venue.name` (= eerste
      bioscoop die de film scrapete; voor concerts/theater altijd correct). */
  occurrenceVenueName?: string | null;
  /** Vol-breed renderen i.p.v. de standaard 220px. Rail injecteert dit
      automatisch wanneer er één item in de rail zit. */
  wide?: boolean;
  /** Toon weekdag + datum vóór de tijd ("Za 31 mei · 21:00"). Gebruikt
      in rails die items over meerdere dagen spreiden (bv. "Voor jou").
      Voor "Vandaag"-rails niet nodig — die zijn impliciet vandaag. */
  showDate?: boolean;
  /** Uitlegbare aanbevelings-reden ("Omdat je vaker techno redt"). Alleen
      gevuld in de "Voor jou"-rail; rendert een subtiele regel onder de venue. */
  reason?: string | null;
}) {
  const roles = useRoles();
  const locale = useLocale();
  const { surface } = useRailCardStyles();
  // `surface.bg`/`surface.border` worden alleen nog gebruikt voor de
  // fallback-tint van de image-placeholder; de kaart zelf is borderless
  // en achtergrond-loos (Letterboxd/Spotify-vibe, zoals FilmRailCard).

  const startsAt = occurrenceStartsAt ?? event.startsAt;
  const endsAt = occurrenceEndsAt ?? event.endsAt;
  // Multi-day events tonen een datum-range ("13 mei – 5 jul") i.p.v.
  // een tijd — voor exhibitions die meerdere dagen lopen is een
  // klokuur niet zinvol; de venue is dan tijdens openingstijden open.
  // Single-day events houden een tijd-label (of "Hele dag" voor
  // synthetische 00:00→23:59 ranges). Met `showDate` plakken we de
  // dow + datum ervoor zodat events buiten "vandaag" duidelijk gedateerd
  // zijn.
  const timeLabel = (() => {
    if (!startsAt) return null;
    if (isMultiDay(startsAt, endsAt)) {
      return formatDateRange(startsAt, endsAt, locale);
    }
    if (showDate) {
      const d = new Date(startsAt);
      const datePart = `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(d.getMonth(), locale).toLowerCase()}`;
      if (isAllDayRange(startsAt, endsAt)) return datePart;
      return `${datePart} · ${rowTimeLabel(startsAt, endsAt, locale)}`;
    }
    return rowTimeLabel(startsAt, endsAt, locale);
  })();

  const onPress = () => {
    const path = occurrenceId
      ? `/event/${event.id}?o=${occurrenceId}`
      : `/event/${event.id}`;
    router.push(path as never);
  };

  return (
    <Pressable
      onPress={onPress}
      style={[styles.card, wide && styles.cardWide]}
    >
      <View
        style={[
          styles.cardImgWrap,
          wide && styles.cardImgWrapWide,
          { backgroundColor: surface.fallback },
        ]}
      >
        {eventImageUrl(event) ? (
          <Image
            source={{ uri: eventImageUrl(event)! }}
            style={styles.cardImg}
            contentFit="cover"
          />
        ) : null}
      </View>
      <View style={styles.cardBody}>
        <Text
          numberOfLines={2}
          style={[styles.cardName, { color: roles.fg }]}
        >
          {event.title}
        </Text>
        <View style={styles.cardMetaRow}>
          {timeLabel && (
            <Text style={[styles.cardTime, { color: roles.accent }]}>
              {timeLabel}
            </Text>
          )}
          <Text
            numberOfLines={1}
            style={[styles.cardVenue, { color: roles.fgMuted }]}
          >
            {occurrenceVenueName ?? event.venue.name}
          </Text>
        </View>
        {reason ? (
          <Text numberOfLines={1} style={[styles.cardReason, { color: roles.accent }]}>
            {reason}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: RAIL_CARD_WIDTH,
  },
  cardWide: {
    width: '100%',
  },
  // Image-wrap geeft borderRadius + clipt de Image. Background dient
  // alleen als placeholder-tint terwijl de Image laadt of als 'r geen
  // image is.
  cardImgWrap: {
    width: '100%',
    height: RAIL_CARD_IMG_HEIGHT,
    borderRadius: 10,
    overflow: 'hidden',
  },
  cardImgWrapWide: {
    height: 220,
  },
  cardImg: {
    width: '100%',
    height: '100%',
  },
  cardBody: {
    paddingTop: 8,
    gap: 4,
  },
  cardName: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
    lineHeight: 18,
  },
  cardMetaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  cardTime: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    letterSpacing: -0.2,
  },
  cardVenue: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  cardReason: {
    fontFamily: fontFamily.body,
    fontSize: 11,
    lineHeight: 14,
    marginTop: 2,
  },
});
