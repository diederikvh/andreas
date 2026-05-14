import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { tinyTap } from '@/lib/haptics';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Generieke horizontale rail voor de Vandaag-lobby. Eén kicker-titel
 * met optionele tone-kleur, een rechter-aanduiding (count of "Meer →"-
 * link), en een horizontale ScrollView die generieke items rendert.
 *
 * Niet voor verticale lijsten — daar gebruiken we EventListRow op
 * Agenda/Gered/venue-detail. Niet voor 1-item-display — daar past
 * FeaturedCarousel beter.
 */
export function Rail({
  kicker,
  kickerTone,
  count,
  moreLabel,
  onMore,
  children,
  emptyText,
}: {
  /** Korte uppercase titel links boven de scroller. */
  kicker: string;
  /** Optionele tone-kleur voor de kicker (matcht meestal de
      categorie-tone uit CATEGORY_TICK). Default: roles.fg. */
  kickerTone?: string;
  /** Optionele count rechts naast de kicker — overrult door `moreLabel`
      als die ook gezet is. */
  count?: number;
  /** Tekst voor de "Meer →"-knop rechts. Pas als `onMore` ook gezet is
      wordt 'm tappable; anders blijft 't gewoon de count. */
  moreLabel?: string;
  /** Tap-callback voor de "Meer →"-knop. Vaak een router.push naar
      Agenda met een cat-deeplink. */
  onMore?: () => void;
  /** Item-renderer roept zelf de scroller niet aan — wij wrappen in
      een horizontale ScrollView. Vergeet niet zelf de keys te zetten. */
  children: ReactNode;
  /** Optionele plaintext fallback wanneer de caller niets te tonen
      heeft. Als gezet en geen children, render een rustige lege-rail. */
  emptyText?: string;
}) {
  const roles = useRoles();
  // Telt alleen daadwerkelijke React-elements (filtert false/null/undefined
  // die conditioneel-renderende callers in een array stoppen). Bepaalt
  // single-item state — bij precies één kaart renderen we vol-breed
  // i.p.v. een 220px-card in een lege scroller.
  const items = Children.toArray(children).filter((c) =>
    isValidElement(c)
  ) as ReactElement<{ wide?: boolean }>[];
  const hasChildren = items.length > 0;
  const isSingle = items.length === 1;
  if (!hasChildren && !emptyText) return null;

  const onMoreTap = onMore
    ? () => {
        tinyTap();
        onMore();
      }
    : undefined;

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text
          style={[
            styles.headLabel,
            { color: kickerTone ?? roles.fg },
          ]}
          numberOfLines={1}
        >
          {kicker}
        </Text>
        {moreLabel && onMoreTap ? (
          <Pressable onPress={onMoreTap} hitSlop={8}>
            <Text style={[styles.headMore, { color: roles.fgMuted }]}>
              {moreLabel}
            </Text>
          </Pressable>
        ) : count !== undefined ? (
          <Text style={[styles.headCount, { color: roles.fgMuted }]}>
            {count}
          </Text>
        ) : null}
      </View>
      {hasChildren ? (
        isSingle ? (
          // Single item — vol-breed renderen, geen scroller. Klonen
          // van het kind injecteert `wide`, zodat de card z'n width
          // naar 100% schakelt.
          <View style={styles.singleWrap}>
            {cloneElement(items[0], { wide: true })}
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.scroller}
          >
            {children}
          </ScrollView>
        )
      ) : (
        <View style={styles.emptyWrap}>
          <Text style={[styles.emptyText, { color: roles.fgPlaceholder }]}>
            {emptyText}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingTop: 14, paddingBottom: 4 },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 22,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 10,
  },
  headLabel: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
    flexShrink: 1,
  },
  headMore: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
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
  // Wrapper voor single-item: zelfde horizontal inset als de scroller
  // zodat 't visueel op dezelfde plek begint, vol-breed card.
  singleWrap: {
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
  emptyWrap: {
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  emptyText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
  },
});

/** Standaard kaart-afmetingen — gedeeld door alle rail-item-componenten
 *  zodat de scroller een gelijkmatige flow houdt. */
export const RAIL_CARD_WIDTH = 220;
export const RAIL_CARD_IMG_HEIGHT = 130;

export const railCardSurface = {
  nacht: {
    bg: palette.noir2,
    border: '#2a2a2d',
    fallback: palette.noir3,
  },
  dag: {
    bg: palette.paper2,
    border: palette.paper,
    fallback: palette.paper,
  },
} as const;

export function useRailCardStyles() {
  const mode = useMode();
  const surface = railCardSurface[mode];
  return { surface };
}
