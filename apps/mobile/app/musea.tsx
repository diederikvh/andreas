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
import { MuseumCard } from '@/components/MuseumCard';
import { SpinningCross } from '@/components/SpinningCross';
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
          <MuseumCard venue={item} width={cardWidth} source="musea" />
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

const styles = StyleSheet.create({
  root: { flex: 1 },
  gridRow: { gap: GRID_GAP, marginBottom: 18 },
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
