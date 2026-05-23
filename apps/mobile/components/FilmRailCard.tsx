/**
 * Borderless film-rail kaart — gebruikt op de Vandaag-pagina voor de
 * Film-rails. In tegenstelling tot RailEventCard heeft 'ie geen card-
 * chrome (geen border, geen background-body) — alleen poster met
 * tekst eronder. Letterboxd/Spotify-vibe. Voor andere categorieën
 * blijft RailEventCard de keus omdat venue-images daar minder uniform
 * zijn en de card-body die inconsistentie verbergt.
 */

import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ApiEvent } from '@/lib/api';
import {
  eventPosterUrl,
  isAllDayRange,
  isMultiDay,
  rowTimeLabel,
} from '@/lib/eventDisplay';
import { useLocale } from '@/lib/i18n';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

const CARD_WIDTH = 130;

export function FilmRailCard({
  event,
  occurrenceId,
  occurrenceStartsAt,
  occurrenceEndsAt,
  occurrenceVenueName,
}: {
  event: ApiEvent;
  occurrenceId?: string;
  occurrenceStartsAt?: string;
  occurrenceEndsAt?: string | null;
  occurrenceVenueName?: string | null;
}) {
  const roles = useRoles();
  const locale = useLocale();

  const startsAt = occurrenceStartsAt ?? event.startsAt;
  const endsAt = occurrenceEndsAt ?? event.endsAt;
  const timeLabel = (() => {
    if (!startsAt) return null;
    if (isMultiDay(startsAt, endsAt)) return null;
    if (isAllDayRange(startsAt, endsAt)) return null;
    return rowTimeLabel(startsAt, endsAt, locale);
  })();

  const onPress = () => {
    const path = occurrenceId
      ? `/event/${event.id}?o=${occurrenceId}`
      : `/event/${event.id}`;
    router.push(path as never);
  };

  const venueName = occurrenceVenueName ?? event.venue.name;
  const poster = eventPosterUrl(event);

  return (
    <Pressable onPress={onPress} style={{ width: CARD_WIDTH }}>
      <View
        style={[
          styles.poster,
          { backgroundColor: roles.bgLift },
        ]}
      >
        {poster ? (
          <Image source={{ uri: poster }} style={styles.posterImg} contentFit="cover" />
        ) : null}
      </View>
      <Text numberOfLines={2} style={[styles.title, { color: roles.fg }]}>
        {event.title}
      </Text>
      <Text numberOfLines={1} style={[styles.venue, { color: roles.fgMuted }]}>
        {venueName}
      </Text>
      {timeLabel && (
        <Text numberOfLines={1} style={[styles.time, { color: roles.accent }]}>
          {timeLabel}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  poster: {
    aspectRatio: 2 / 3,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 8,
  },
  posterImg: { width: '100%', height: '100%' },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    lineHeight: 18,
    letterSpacing: -0.21,
    marginBottom: 1,
  },
  venue: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: -0.12,
    marginBottom: 2,
  },
  time: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: -0.12,
  },
});
