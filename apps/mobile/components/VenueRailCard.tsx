import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  RAIL_CARD_IMG_HEIGHT,
  RAIL_CARD_WIDTH,
  useRailCardStyles,
} from '@/components/Rail';
import type { VenueType } from '@/lib/api';
import { translateVenueType } from '@/lib/eventDisplay';
import { useLocale } from '@/lib/i18n';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/** Compacte venue-kaart voor een rail van gevolgde venues. Toont
 *  image-header + venue-naam + venue-type label. Tap navigeert naar
 *  de venue-detail page met het programma.
 *
 *  Onderscheidt zich van RailEventCard door: 2 regels naam, geen
 *  tijd-pill, type-label als subline. */
export function VenueRailCard({
  slug,
  name,
  imageUrl,
  type,
  wide = false,
}: {
  slug: string;
  name: string;
  imageUrl: string | null | undefined;
  type: VenueType | null | undefined;
  /** Vol-breed renderen — Rail injecteert dit bij single-item rails. */
  wide?: boolean;
}) {
  const roles = useRoles();
  const locale = useLocale();
  const { surface } = useRailCardStyles();

  const onPress = () => {
    router.push(`/venue/${slug}` as never);
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
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
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
          {name}
        </Text>
        {type && (
          <Text
            numberOfLines={1}
            style={[styles.cardType, { color: roles.fgMuted }]}
          >
            {translateVenueType(type, locale)}
          </Text>
        )}
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
  cardType: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
});
