/**
 * De Andreas-gids als in-place overlay (zelfde "vibe" als SearchOverlay):
 * backdrop fade-in + sheet slide-up. Zoeken met filters: periode, soort,
 * genres, stad en een naam. Geen model aan onze kant; zoeken in eigen
 * woorden gaat via je eigen AI (MCP), daar verwijst het scherm onderaan
 * naar.
 *
 * Filters en het laatste resultaat leven in de zoek-store en blijven staan
 * tussen openen en sluiten.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EventListRow } from '@/components/EventListRow';
import { FilterChip } from '@/components/FilterChip';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  dowMixed,
  eventImageUrl,
  monthShort,
  rowTimeLabel,
  translateCategory,
} from '@/lib/eventDisplay';
import { softTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import type { ZoekWhen } from '@/lib/period';
import { useGenreOptions } from '@/lib/queries';
import type { BadgeTone } from '@/lib/types';
import { useMode, useRoles } from '@/store/mode';
import { useZoekStore } from '@/store/zoek';
import { fontFamily, palette } from '@/theme/tokens';

const ENTER_MS = 260;
const EXIT_MS = 200;

const WHENS: { key: ZoekWhen; nl: string; en: string }[] = [
  { key: 'tonight', nl: 'Vanavond', en: 'Tonight' },
  { key: 'tomorrow', nl: 'Morgen', en: 'Tomorrow' },
  { key: 'weekend', nl: 'Dit weekend', en: 'This weekend' },
  { key: 'week', nl: 'Deze week', en: 'This week' },
  { key: 'month', nl: 'Deze maand', en: 'This month' },
  { key: 'any', nl: 'Alles', en: 'Any time' },
];
const CATEGORIES = ['Muziek', 'Film', 'Theater', 'Kunst', 'Lezing', 'Literatuur'] as const;
const CITIES: { key: string; label: string }[] = [
  { key: 'amsterdam', label: 'Amsterdam' },
  { key: 'utrecht', label: 'Utrecht' },
  { key: 'rotterdam', label: 'Rotterdam' },
  { key: 'den-haag', label: 'Den Haag' },
  { key: 'haarlem', label: 'Haarlem' },
  { key: 'eindhoven', label: 'Eindhoven' },
  { key: 'tilburg', label: 'Tilburg' },
  { key: 'nijmegen', label: 'Nijmegen' },
  { key: 'groningen', label: 'Groningen' },
  { key: 'antwerpen', label: 'Antwerpen' },
];

const toggleIn = (list: string[], key: string) =>
  list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

export function GuideOverlay({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();

  const filters = useZoekStore((s) => s.filters);
  const setFilters = useZoekStore((s) => s.setFilters);
  const result = useZoekStore((s) => s.result);
  const sending = useZoekStore((s) => s.sending);
  const error = useZoekStore((s) => s.error);
  const search = useZoekStore((s) => s.search);
  const loadMore = useZoekStore((s) => s.loadMore);
  const loadingMore = useZoekStore((s) => s.loadingMore);
  const reset = useZoekStore((s) => s.reset);
  const { data: genreOptions } = useGenreOptions();

  const [mounted, setMounted] = useState(visible);
  const backdrop = useSharedValue(0);
  const sheet = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      backdrop.value = withTiming(1, { duration: ENTER_MS, easing: Easing.out(Easing.cubic) });
      sheet.value = withTiming(1, { duration: ENTER_MS, easing: Easing.out(Easing.cubic) });
    } else {
      backdrop.value = withTiming(0, { duration: EXIT_MS, easing: Easing.in(Easing.cubic) });
      sheet.value = withTiming(
        0,
        { duration: EXIT_MS, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setMounted)(false);
        }
      );
    }
  }, [visible, backdrop, sheet]);

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: sheet.value,
    transform: [{ translateY: (1 - sheet.value) * 24 }],
  }));

  if (!mounted) return null;

  // Genres van de gekozen soorten; zonder soort alles.
  const shownGenres = (genreOptions ?? []).filter(
    (g) => filters.categories.length === 0 || g.categories.some((c) => filters.categories.includes(c))
  );

  return (
    <View style={styles.root} pointerEvents="box-none">
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: isNacht ? 'rgba(0,0,0,0.65)' : 'rgba(20,18,12,0.45)' },
          backdropStyle,
        ]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
      </Animated.View>

      <Animated.View style={[styles.sheet, { backgroundColor: roles.bg, paddingTop: insets.top }, sheetStyle]}>
        <View style={styles.header}>
          <Pressable
            onPress={handleClose}
            hitSlop={8}
            style={[styles.headerBtn, { backgroundColor: roles.bgLift }]}
          >
            <Ionicons name="chevron-down" size={22} color={roles.fg} />
          </Pressable>
          <Text style={[styles.title, { color: roles.fg }]}>{t('Gids', 'Guide')}</Text>
          <Pressable
            onPress={reset}
            hitSlop={8}
            style={[styles.headerBtn, { backgroundColor: roles.bgLift }]}
            accessibilityLabel={t('Filters wissen', 'Clear filters')}
          >
            <Ionicons name="refresh" size={18} color={roles.fg} />
          </Pressable>
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        >
          <Text style={[styles.label, { color: roles.fg }]}>{t('Wanneer', 'When')}</Text>
          <ChipRow>
            {WHENS.map((w) => (
              <FilterChip
                key={w.key}
                label={t(w.nl, w.en)}
                active={filters.when === w.key}
                onPress={() => {
                  softTap();
                  setFilters({ when: w.key });
                }}
              />
            ))}
          </ChipRow>

          <Text style={[styles.label, { color: roles.fg }]}>{t('Wat', 'What')}</Text>
          <ChipRow>
            {CATEGORIES.map((c) => (
              <FilterChip
                key={c}
                label={translateCategory(c, locale)}
                active={filters.categories.includes(c)}
                onPress={() => {
                  softTap();
                  setFilters({ categories: toggleIn(filters.categories, c) });
                }}
              />
            ))}
          </ChipRow>

          {shownGenres.length > 0 ? (
            <>
              <Text style={[styles.label, { color: roles.fg }]}>{t('Genres', 'Genres')}</Text>
              <View style={styles.wrap}>
                {shownGenres.map((g) => (
                  <FilterChip
                    key={g.key}
                    label={g.label}
                    active={filters.genres.includes(g.key)}
                    onPress={() => {
                      softTap();
                      setFilters({ genres: toggleIn(filters.genres, g.key) });
                    }}
                  />
                ))}
              </View>
            </>
          ) : null}

          <Text style={[styles.label, { color: roles.fg }]}>{t('Waar', 'Where')}</Text>
          <ChipRow>
            <FilterChip
              label={t('Overal', 'Anywhere')}
              active={filters.cities.length === 0}
              onPress={() => {
                softTap();
                setFilters({ cities: [] });
              }}
            />
            {CITIES.map((c) => (
              <FilterChip
                key={c.key}
                label={c.label}
                active={filters.cities.includes(c.key)}
                onPress={() => {
                  softTap();
                  setFilters({ cities: toggleIn(filters.cities, c.key) });
                }}
              />
            ))}
          </ChipRow>

          <Text style={[styles.label, { color: roles.fg }]}>{t('Artiest of titel', 'Artist or title')}</Text>
          <TextInput
            value={filters.query}
            onChangeText={(v) => setFilters({ query: v })}
            placeholder={t('Bijv. Fontaines D.C.', 'E.g. Fontaines D.C.')}
            placeholderTextColor={roles.fgPlaceholder}
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => void search()}
            style={[
              styles.input,
              {
                color: roles.fg,
                borderColor: isNacht ? '#2a2a2d' : palette.paper,
                backgroundColor: isNacht ? palette.noir2 : palette.paper2,
              },
            ]}
          />

          <Pressable
            onPress={() => {
              softTap();
              Keyboard.dismiss();
              void search();
            }}
            disabled={sending}
            style={[styles.bigBtn, { backgroundColor: roles.accent }]}
          >
            <Text style={[styles.bigLabel, { color: roles.onAccent }]}>{t('Zoek', 'Search')}</Text>
          </Pressable>

          {sending ? (
            <View style={styles.waiting}>
              <SpinningCross size={22} color={roles.accent} pulse />
            </View>
          ) : null}
          {error ? <Text style={[styles.error, { color: palette.red }]}>{error}</Text> : null}

          {result && !sending ? (
            <View style={styles.results}>
              <Text style={[styles.reply, { color: roles.fg }]}>{result.reply}</Text>
              {result.events.length > 1 ? (
                // Volgorde: eerst wat bij je past (zalen en artiesten die je
                // volgt, genres die je leuk vindt), of gewoon op datum.
                <View style={styles.sortRow}>
                  {(
                    [
                      ['personal', t('Voor jou', 'For you')],
                      ['date', t('Op datum', 'By date')],
                    ] as const
                  ).map(([key, label]) => (
                    <FilterChip
                      key={key}
                      label={label}
                      active={filters.sort === key}
                      onPress={() => {
                        if (filters.sort === key) return;
                        softTap();
                        setFilters({ sort: key });
                        void search();
                      }}
                    />
                  ))}
                </View>
              ) : null}
              {result.events.map((ev) => (
                <ZoekEventRow key={ev.id} event={ev} reason={result.reasonByEventId[ev.id]} />
              ))}
              {result.events.length < result.total ? (
                <Pressable
                  onPress={() => {
                    softTap();
                    void loadMore();
                  }}
                  disabled={loadingMore}
                  style={[styles.moreBtn, { backgroundColor: roles.bgChip }]}
                >
                  {loadingMore ? (
                    <SpinningCross size={16} color={roles.fgMuted} />
                  ) : (
                    <Text style={[styles.moreLabel, { color: roles.fg }]}>
                      {t(
                        `Meer (nog ${result.total - result.events.length})`,
                        `More (${result.total - result.events.length} left)`
                      )}
                    </Text>
                  )}
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <View style={styles.aiNote}>
            <Text style={[styles.hint, { color: roles.fgMuted }]}>
              {t(
                'Liever in eigen woorden zoeken, zoals "iets met een jaren-90-vibe dit weekend"? Vraag het je eigen AI, zoals Claude of ChatGPT, met Andreas gekoppeld.',
                'Rather search in your own words, like "something with a 90s vibe this weekend"? Ask your own AI, like Claude or ChatGPT, with Andreas connected.'
              )}
            </Text>
            <Pressable
              onPress={() => {
                softTap();
                void Linking.openURL('https://andreas.amsterdam/ai');
              }}
              hitSlop={10}
            >
              <Text style={[styles.link, { color: roles.fg }]}>{t('Zo koppel je Andreas →', 'How to connect Andreas →')}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

/** Een rij chips die tot de rand doorloopt, onder de duim weg te vegen. */
function ChipRow({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.chipScroll}
      contentContainerStyle={styles.chips}
    >
      {children}
    </ScrollView>
  );
}

/** ApiEvent → EventListRow, identiek aan de mapping in SearchOverlay zodat de
    kaarten overal hetzelfde lezen. Toont de per-event reden eronder. */
function ZoekEventRow({
  event,
  reason,
}: {
  event: ApiEvent;
  reason?: string;
}) {
  const roles = useRoles();
  const locale = useLocale();
  const start = event.startsAt;
  if (!start) return null;

  const venueTone =
    event.venue.type && (VENUE_TYPE_TICK as Record<string, BadgeTone>)[event.venue.type]
      ? (VENUE_TYPE_TICK as Record<string, BadgeTone>)[event.venue.type]
      : undefined;
  const tone = CATEGORY_TICK[event.category];
  const d = new Date(start);
  const dow = dowMixed(d.getDay(), locale);
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  const time = rowTimeLabel(start, event.endsAt ?? null, locale);
  const dateLabel = `${dow} ${d.getDate()} ${month}`;

  return (
    <View style={styles.eventBlock}>
      <EventListRow
        thumb={eventImageUrl(event) ?? ''}
        thumbSize={96}
        title={event.title}
        venue={event.venue.name}
        venueTone={venueTone}
        time={time}
        dateLabel={dateLabel}
        dateAbove
        tags={[{ label: translateCategory(event.category, locale), tone }]}
        genreLabel={(event.genres ?? [])[0]}
        tick={tone}
        onPress={() => {
          // Alleen toetsenbord weg — overlay blijft open (zoals de zoek),
          // zodat je na 'terug' weer bij je resultaten staat.
          Keyboard.dismiss();
          router.push(`/event/${event.id}?source=search` as never);
        }}
      />
      {reason ? <Text style={[styles.reason, { color: roles.fgMuted }]}>{reason}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 1000, elevation: 20 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.2,
        shadowOffset: { width: 0, height: -4 },
        shadowRadius: 16,
      },
      android: { elevation: 20 },
    }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontFamily: fontFamily.displayBold, fontSize: 18, letterSpacing: -0.36 },
  content: { paddingHorizontal: 22, paddingTop: 4, gap: 10 },
  label: { fontFamily: fontFamily.bold, fontSize: 14, marginTop: 6 },
  // De chip-rijen lopen tot de rand door: negatieve marge tegen de
  // padding van de pagina, zodat je ze onder de duim wegveegt.
  chipScroll: { marginHorizontal: -22 },
  chips: { gap: 6, paddingHorizontal: 22 },
  // Genres zijn er te veel voor één veegrij: die lopen door naar onder.
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  input: {
    fontFamily: fontFamily.medium,
    fontSize: 16,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  bigBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 13, borderRadius: 8, marginTop: 10 },
  bigLabel: { fontFamily: fontFamily.bold, fontSize: 15 },
  waiting: { paddingVertical: 14, alignItems: 'flex-start' },
  error: { fontFamily: fontFamily.body, fontSize: 13 },
  results: { gap: 8, paddingTop: 10 },
  reply: { fontFamily: fontFamily.medium, fontSize: 15, lineHeight: 21 },
  sortRow: { flexDirection: 'row', gap: 6 },
  moreBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 13, borderRadius: 8, marginTop: 6 },
  moreLabel: { fontFamily: fontFamily.bold, fontSize: 15 },
  eventBlock: { marginHorizontal: -22 },
  reason: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 22,
    marginTop: -4,
    marginBottom: 6,
  },
  hint: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20 },
  aiNote: { gap: 8, paddingTop: 24 },
  link: { fontFamily: fontFamily.bold, fontSize: 14 },
});
