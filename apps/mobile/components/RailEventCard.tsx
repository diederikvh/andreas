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
  eventImageUrl,
  formatDateRange,
  isMultiDay,
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
  wide = false,
}: {
  event: ApiEvent;
  /** Optionele specifieke occurrence — als gezet, geeft 'm mee als
      ?o=... query-param naar event-detail. */
  occurrenceId?: string;
  /** Wanneer een specifieke occurrence wordt getoond: tijd-label gebruikt
      díe occurrence ipv de event-level startsAt. */
  occurrenceStartsAt?: string;
  occurrenceEndsAt?: string | null;
  /** Vol-breed renderen i.p.v. de standaard 220px. Rail injecteert dit
      automatisch wanneer er één item in de rail zit. */
  wide?: boolean;
}) {
  const roles = useRoles();
  const locale = useLocale();
  const { surface } = useRailCardStyles();

  const startsAt = occurrenceStartsAt ?? event.startsAt;
  const endsAt = occurrenceEndsAt ?? event.endsAt;
  // Multi-day events tonen een datum-range ("13 mei – 5 jul") i.p.v.
  // een tijd — voor exhibitions die meerdere dagen lopen is een
  // klokuur niet zinvol; de venue is dan tijdens openingstijden open.
  // Single-day events houden een tijd-label (of "Hele dag" voor
  // synthetische 00:00→23:59 ranges).
  const timeLabel = startsAt
    ? isMultiDay(startsAt, endsAt)
      ? formatDateRange(startsAt, endsAt, locale)
      : rowTimeLabel(startsAt, endsAt, locale)
    : null;

  const onPress = () => {
    const path = occurrenceId
      ? `/event/${event.id}?o=${occurrenceId}`
      : `/event/${event.id}`;
    router.push(path as never);
  };

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.card,
        wide && styles.cardWide,
        { backgroundColor: surface.bg, borderColor: surface.border },
      ]}
    >
      {eventImageUrl(event) ? (
        <Image
          source={{ uri: eventImageUrl(event)! }}
          style={[styles.cardImg, wide && styles.cardImgWide]}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.cardImg,
            wide && styles.cardImgWide,
            { backgroundColor: surface.fallback },
          ]}
        />
      )}
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
            {event.venue.name}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: RAIL_CARD_WIDTH,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  cardWide: {
    width: '100%',
  },
  cardImg: {
    width: '100%',
    height: RAIL_CARD_IMG_HEIGHT,
  },
  cardImgWide: {
    height: 220,
  },
  cardBody: {
    padding: 12,
    gap: 6,
    minHeight: 84,
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
});
