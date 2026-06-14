/**
 * Compacte vierkante venue-tile voor de Vandaag-rails van musea +
 * galleries. Bedoeld om 3-op-een-rij zichtbaar te krijgen in een
 * horizontaal scrollende Rail (Stedelijk / Rijksmuseum / FOAM /
 * etc.) — toont één tile per venue ipv per exhibition.
 *
 * Klik = /venue/{slug}. De gebruiker landt op de venue-pagina waar
 * de exhibitions zichtbaar zijn. Geen tijd-pill of exhibition-titel
 * hier — die schalen niet naar zo'n compacte tile.
 */

import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useRailCardStyles } from '@/components/Rail';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

// 3-op-een-rij in een 393px iPhone-viewport: 393 - 44 (rail-padding
// 22×2) = 349, minus 2 gaps van 10 = 329, /3 ≈ 109 → 108 voor wat
// adem.
export const SQUARE_CARD_WIDTH = 108;

export function VenueSquareRailCard({
  slug,
  name,
  imageUrl,
}: {
  slug: string;
  name: string;
  imageUrl: string | null | undefined;
}) {
  const roles = useRoles();
  const { surface } = useRailCardStyles();

  return (
    <Pressable
      onPress={() => router.push(`/venue/${slug}` as never)}
      style={styles.card}
    >
      <View
        style={[
          styles.cardImgWrap,
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
      <Text
        numberOfLines={2}
        style={[styles.cardName, { color: roles.fg }]}
      >
        {name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: SQUARE_CARD_WIDTH,
  },
  cardImgWrap: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
  },
  cardImg: { width: '100%', height: '100%' },
  cardName: {
    paddingTop: 6,
    fontFamily: fontFamily.bold,
    fontSize: 12,
    lineHeight: 15,
    letterSpacing: -0.17,
  },
});
