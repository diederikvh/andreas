/**
 * "Andreas ✕ Musea" — een raster van musea, niet van tentoonstellingen.
 *
 * Bewust andersom dan /films. Bij film is de film de hoofdzaak en de
 * bioscoop bijzaak: je vraagt "waar draait dit". Bij een museum is het
 * omgekeerd — het gebouw is de constante en de inhoud wisselt, dus je
 * vraagt "wat hangt er in het Stedelijk". Een lijst van losse
 * tentoonstellingen beantwoordt die vraag niet: je moet dan zelf de
 * namen bij elkaar zoeken.
 *
 * Vandaar één tegel per museum, met het beeld van wat er nu te zien is
 * en de titel eronder. Meerdere tentoonstellingen tonen we als "+2" en
 * niet als swipe binnen de tegel: een horizontale scroller in een
 * verticaal raster vecht met het scrollen van de pagina, en de
 * venue-pagina toont het volledige programma toch al.
 */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SpinningCross } from '@/components/SpinningCross';
import type { MuseumVenue } from '@/lib/api';
import { formatWijk } from '@/lib/eventDisplay';
import { softTap } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { useMusea } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HORIZONTAL_PADDING = 14;
const GRID_GAP = 10;

export default function Musea() {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const isNacht = useMode() === 'nacht';
  const t = useT();
  const { width: windowWidth } = useWindowDimensions();
  const { data: venues, isLoading, error } = useMusea();

  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await qc.invalidateQueries({ queryKey: ['musea'] });
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) await new Promise((r) => setTimeout(r, 700 - elapsed));
      setRefreshing(false);
    }
  }, [qc]);

  const cardWidth = (windowWidth - HORIZONTAL_PADDING * 2 - GRID_GAP) / 2;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner
        visible={refreshing}
        topOffset={insets.top + HEADER_HEIGHT + 8}
      />
      <FlatList
        data={venues ?? []}
        keyExtractor={(v) => v.id}
        numColumns={2}
        renderItem={({ item }) => (
          <MuseumCard venue={item} width={cardWidth} t={t} />
        )}
        columnWrapperStyle={
          (venues?.length ?? 0) > 0 ? styles.gridRow : undefined
        }
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT + 8,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: HORIZONTAL_PADDING,
        }}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.centerWrap}>
              <SpinningCross size={28} color={roles.fgPlaceholder} />
            </View>
          ) : (
            <View style={styles.centerWrap}>
              <Text style={[styles.dim, { color: roles.fgMuted }]}>
                {error
                  ? t('Kon musea niet laden.', "Couldn't load museums.")
                  : t(
                      'Er loopt nu nergens een tentoonstelling.',
                      'No exhibitions running right now.'
                    )}
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
            progressViewOffset={insets.top + HEADER_HEIGHT + 30}
          />
        }
        showsVerticalScrollIndicator={false}
        windowSize={7}
        initialNumToRender={8}
      />

      <AppHeader
        title={t('Musea', 'Museums')}
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

function MuseumCard({
  venue,
  width,
  t,
}: {
  venue: MuseumVenue;
  width: number;
  t: ReturnType<typeof useT>;
}) {
  const roles = useRoles();
  const first = venue.exhibitions[0];
  const extra = venue.exhibitions.length - 1;
  // Beeld van de tentoonstelling, niet van het gebouw: een gevel zegt
  // niks over of je er nú heen wilt. De venue-foto is de terugval.
  const image = first?.imageUrl ?? venue.imageUrl;

  return (
    <Pressable
      onPress={() => {
        softTap();
        router.push(`/venue/${venue.slug}?source=musea` as never);
      }}
      style={{ width }}
    >
      <View
        style={[
          styles.poster,
          { backgroundColor: roles.bgLift, borderColor: roles.bgChip },
        ]}
      >
        {image ? (
          <Image
            source={{ uri: image }}
            style={styles.posterImg}
            contentFit="cover"
          />
        ) : null}
        {venue.followed && (
          <View style={[styles.followTick, { backgroundColor: roles.accent }]}>
            <Ionicons name="bookmark" size={11} color={roles.onAccent} />
          </View>
        )}
        {/* Titel als accent-blok ín de foto, net als het datum-blokje op
            de agenda-kaarten op Vandaag. Onder de foto viel 'ie weg
            tegen de museumnaam, terwijl juist die titel bepaalt of je
            gaat — de naam van het gebouw wist je al. */}
        {first ? (
          <View style={[styles.titleBadge, { backgroundColor: roles.accent }]}>
            <Text
              numberOfLines={3}
              style={[styles.titleBadgeText, { color: roles.onAccent }]}
            >
              {first.title}
            </Text>
          </View>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.venueName, { color: roles.fg }]}>
        {venue.name}
      </Text>
      <Text style={[styles.meta, { color: roles.fgPlaceholder }]}>
        {extra > 0
          ? t(`+${extra} meer · `, `+${extra} more · `)
          : ''}
        {venue.wijk ? formatWijk(venue.wijk) : ''}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  gridRow: { gap: GRID_GAP, marginBottom: 18 },
  poster: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  posterImg: { width: '100%', height: '100%' },
  // Klein vlaggetje op de hoek voor venues die je volgt — die staan al
  // bovenaan, dit maakt zichtbaar wáárom.
  followTick: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 22,
    height: 22,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Linksonder, met ruimte rechts zodat 'ie niet de hele breedte vult —
  // een blok dat tot de rand loopt leest als een balk, niet als label.
  titleBadge: {
    position: 'absolute',
    left: 8,
    right: 14,
    bottom: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 7,
  },
  titleBadgeText: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    lineHeight: 16,
    letterSpacing: -0.2,
  },
  venueName: {
    marginTop: 8,
    fontFamily: fontFamily.displayBold,
    fontSize: 14,
    letterSpacing: -0.24,
  },
  meta: {
    marginTop: 3,
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  centerWrap: { paddingHorizontal: HORIZONTAL_PADDING, paddingVertical: 60 },
  dim: { fontFamily: fontFamily.body, fontSize: 14, textAlign: 'center' },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
