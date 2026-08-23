/**
 * Globale zoek-overlay die in-place op /avond rijst. Vervangt de
 * route-based /search-aanpak omdat de overgang dan veel natuurlijker
 * voelt: backdrop fade-in, zoekbar slide-up, content erin onderaan.
 * Geen navigation-jank, geen "pop"-feel.
 *
 * Verantwoordelijkheden:
 *  - Absoluut bovenaan /avond gerenderd (zIndex boven de tab-bar).
 *  - Pakt focus + opent keyboard zodra `visible` true wordt.
 *  - Close-knop + backdrop-tap → animeer uit, callback naar parent.
 *  - Debounced API-fetch via /search; infinite scroll op de
 *    events-sectie zodat je niet plotseling vastloopt op een limiet.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';

import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { EventListRow } from '@/components/EventListRow';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { SpinningCross } from '@/components/SpinningCross';
import { search, type ApiSearchVenue, type ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  dowMixed,
  eventImageUrl,
  monthShort,
  rowTimeLabel,
  translateCategory,
  translateVenueType,
  formatWijk,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import type { BadgeTone } from '@/lib/types';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const ENTER_MS = 260;
const EXIT_MS = 200;
const DEBOUNCE_MS = 220;

export function SearchOverlay({
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
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // Houd 'm in de DOM tijdens de exit-animatie; pas daarna unmount.
  const [mounted, setMounted] = useState(visible);
  // Trackt keyboard-hoogte zodat empty-state tussen searchbar en
  // toetsenbord gecentreerd kan worden (anders verdwijnt 'ie achter
  // het keyboard).
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKbHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const backdrop = useSharedValue(0);
  const sheet = useSharedValue(0);

  // Debounce — voorkomt fetch-per-keystroke. 220ms voelt levendig genoeg
  // dat resultaten direct verschijnen, langzaam genoeg dat we niet
  // onnodig de DB hameren bij typen.
  useEffect(() => {
    const tid = setTimeout(() => setDebouncedQuery(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(tid);
  }, [query]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      backdrop.value = withTiming(1, {
        duration: ENTER_MS,
        easing: Easing.out(Easing.cubic),
      });
      sheet.value = withTiming(1, {
        duration: ENTER_MS,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      backdrop.value = withTiming(0, {
        duration: EXIT_MS,
        easing: Easing.in(Easing.cubic),
      });
      sheet.value = withTiming(
        0,
        { duration: EXIT_MS, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setMounted)(false);
        }
      );
    }
  }, [visible, backdrop, sheet]);

  // Auto-focus + keyboard zodra de overlay vol opacity heeft. Iets
  // wachten zodat animatie + keyboard niet samen jankken. Bij sluiten
  // resetten we de query zodat 'n volgende open weer leeg start.
  useEffect(() => {
    if (visible) {
      const tid = setTimeout(() => inputRef.current?.focus(), ENTER_MS - 80);
      return () => clearTimeout(tid);
    }
    setQuery('');
    setDebouncedQuery('');
  }, [visible]);

  const enabled = debouncedQuery.length > 0;
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['search', debouncedQuery],
    queryFn: ({ pageParam }) => search(debouncedQuery, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.eventsHasMore) return undefined;
      const seenEvents = allPages.reduce((n, p) => n + p.events.length, 0);
      return seenEvents;
    },
    enabled,
    staleTime: 60_000,
    // Houd het vorige resultaat zichtbaar terwijl de nieuwe query
    // fetcht — anders flitst de spinner bij elke keystroke en raak
    // je je context kwijt.
    placeholderData: keepPreviousData,
  });

  // Venues komen alleen op page 0 — pluk ze daar uit. Events
  // concatten over alle pages (paginated).
  const venues: ApiSearchVenue[] = data?.pages[0]?.venues ?? [];
  const events: ApiEvent[] = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.events),
    [data]
  );

  const sections = useMemo(() => {
    if (!enabled) return [];
    const out: {
      kind: 'venues' | 'events';
      data: (ApiSearchVenue | ApiEvent)[];
    }[] = [];
    if (venues.length > 0) out.push({ kind: 'venues', data: venues });
    if (events.length > 0) out.push({ kind: 'events', data: events });
    return out;
  }, [enabled, venues, events]);

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  const onResultPress = useCallback(() => {
    // Toetsenbord weg zodat 't detail-scherm volle hoogte heeft, maar
    // de overlay zelf blijft gemount — komt de gebruiker terug, dan
    // staat z'n zoek-lijst + scroll-positie nog netjes klaar.
    Keyboard.dismiss();
  }, []);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdrop.value,
  }));
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: sheet.value,
    transform: [{ translateY: (1 - sheet.value) * 24 }],
  }));

  if (!mounted) return null;

  const renderItem = ({
    item,
    section,
  }: {
    item: ApiSearchVenue | ApiEvent;
    section: { kind: 'venues' | 'events' };
  }) =>
    section.kind === 'venues' ? (
      <VenueRow venue={item as ApiSearchVenue} onPress={onResultPress} />
    ) : (
      <EventResultRow
        event={item as ApiEvent}
        locale={locale}
        onPress={onResultPress}
      />
    );

  return (
    <View style={styles.root} pointerEvents="box-none">
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: isNacht
              ? 'rgba(0,0,0,0.65)'
              : 'rgba(20,18,12,0.45)',
          },
          backdropStyle,
        ]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
      </Animated.View>

      <Animated.View
        style={[
          styles.sheet,
          { backgroundColor: roles.bg },
          sheetStyle,
        ]}
      >
        {/* Body — staat onder de top-zone. paddingTop pakt de hoogte
            van de top-zone inclusief safe-area zodat content er
            mooi onderdoor scrollt. */}
        {!enabled ? (
          <View
            style={[
              styles.hintWrap,
              {
                paddingTop: insets.top + TOP_ZONE_BELOW_SAFE,
                paddingBottom: kbHeight,
              },
            ]}
          >
            <Ionicons
              name="search-outline"
              size={44}
              color={roles.fgPlaceholder}
            />
            <Text style={[styles.hint, { color: roles.fgMuted }]}>
              {t(
                'Begin te typen om venues en events te zoeken.',
                'Start typing to search venues and events.'
              )}
            </Text>
          </View>
        ) : sections.length === 0 ? (
          <View
            style={[
              styles.hintWrap,
              {
                paddingTop: insets.top + TOP_ZONE_BELOW_SAFE,
                paddingBottom: kbHeight,
              },
            ]}
          >
            {isFetching ? (
              <SpinningCross size={24} color={roles.fgPlaceholder} />
            ) : (
              <>
                <Ionicons
                  name="cloud-offline-outline"
                  size={44}
                  color={roles.fgPlaceholder}
                />
                <Text style={[styles.hint, { color: roles.fgMuted }]}>
                  {t(
                    `Geen resultaten voor “${debouncedQuery}”.`,
                    `No results for “${debouncedQuery}”.`
                  )}
                </Text>
              </>
            )}
          </View>
        ) : (
          <SectionList
            sections={sections}
            keyExtractor={(item, idx) =>
              `${'id' in item ? item.id : idx}-${idx}`
            }
            renderItem={renderItem}
            renderSectionHeader={({ section }) => (
              <View
                style={[styles.sectionHead, { backgroundColor: roles.bg }]}
              >
                <Text
                  style={[styles.sectionHeadText, { color: roles.fg }]}
                >
                  {section.kind === 'venues'
                    ? t('Venues', 'Venues')
                    : t('Events', 'Events')}
                </Text>
              </View>
            )}
            stickySectionHeadersEnabled={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            onEndReached={() => {
              if (hasNextPage && !isFetchingNextPage) fetchNextPage();
            }}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              isFetchingNextPage ? (
                <View style={styles.footerLoading}>
                  <SpinningCross size={20} color={roles.fgPlaceholder} />
                </View>
              ) : null
            }
            contentContainerStyle={{
              paddingTop: insets.top + TOP_ZONE_BELOW_SAFE,
              paddingBottom: insets.bottom + 24,
            }}
            windowSize={7}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
          />
        )}

        {/* Top-zone — AppHeader-stijl blur+gradient fade-out aan de
            onderkant zodat content er natuurlijk onderdoor scrollt
            i.p.v. tegen een harde rand te knallen. */}
        <View
          style={[styles.topZone, { paddingTop: insets.top + 8 }]}
          pointerEvents="box-none"
        >
          {Platform.OS === 'android' ? (
            <LinearGradient
              colors={
                isNacht
                  ? ['rgba(10,10,11,0.92)', 'rgba(10,10,11,0.88)', 'transparent']
                  : ['rgba(255,255,255,0.94)', 'rgba(255,255,255,0.9)', 'transparent']
              }
              locations={[0, 0.7, 1]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
          ) : (
            <MaskedView
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
              maskElement={
                <LinearGradient
                  colors={['#000', '#000', 'transparent']}
                  locations={[0, 0.7, 1]}
                  style={StyleSheet.absoluteFill}
                />
              }
            >
              <BlurView
                intensity={40}
                tint={isNacht ? 'dark' : 'light'}
                style={StyleSheet.absoluteFill}
              />
            </MaskedView>
          )}
          <View style={styles.topRow}>
            <View
              style={[
                styles.inputWrap,
                { backgroundColor: roles.bgLift, borderColor: roles.bgChip },
              ]}
            >
              <Ionicons name="search" size={18} color={roles.fgMuted} />
              <TextInput
                ref={inputRef}
                value={query}
                onChangeText={setQuery}
                placeholder={t(
                  'Zoek venues, events, artiesten…',
                  'Search venues, events, artists…'
                )}
                placeholderTextColor={roles.fgMuted}
                style={[styles.input, { color: roles.fg }]}
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
              />
              {query.length > 0 ? (
                <Pressable
                  onPress={() => {
                    setQuery('');
                    inputRef.current?.focus();
                  }}
                  hitSlop={8}
                >
                  <Ionicons
                    name="close-circle"
                    size={18}
                    color={roles.fgMuted}
                  />
                </Pressable>
              ) : null}
            </View>
            <Pressable
              onPress={handleClose}
              hitSlop={4}
              style={[
                styles.closeBtnSquare,
                { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
              ]}
            >
              <Ionicons name="close" size={22} color={roles.fg} />
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

// Hoogte onder de safe-area inset: 8 (top padding) + 48 (search bar) +
// 20 (fade-zone). Body krijgt deze padding zodat content begint onder
// de blur-strip; gradient fade-out zorgt voor 'n soft overgang.
const TOP_ZONE_BELOW_SAFE = 8 + 48 + 20;

function VenueRow({
  venue,
  onPress,
}: {
  venue: ApiSearchVenue;
  onPress: () => void;
}) {
  const roles = useRoles();
  const locale = useLocale();
  const subtitle = [
    venue.type ? translateVenueType(venue.type, locale) : null,
    venue.wijk ? formatWijk(venue.wijk) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      onPress={() => {
        onPress();
        router.push(`/venue/${venue.slug}` as never);
      }}
      style={styles.venueRow}
    >
      <ProfileAvatar
        avatarUrl={venue.imageUrl}
        name={venue.name}
        size={40}
      />
      <View style={styles.venueText}>
        <Text
          numberOfLines={1}
          style={[styles.venueName, { color: roles.fg }]}
        >
          {venue.name}
        </Text>
        {subtitle.length > 0 ? (
          <Text
            numberOfLines={1}
            style={[styles.venueSub, { color: roles.fgMuted }]}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function EventResultRow({
  event,
  locale,
  onPress,
}: {
  event: ApiEvent;
  locale: ReturnType<typeof useLocale>;
  onPress: () => void;
}) {
  const venueTone =
    event.venue.type &&
    (VENUE_TYPE_TICK as Record<string, BadgeTone>)[event.venue.type]
      ? (VENUE_TYPE_TICK as Record<string, BadgeTone>)[event.venue.type]
      : undefined;
  const tone = CATEGORY_TICK[event.category];
  const start = event.startsAt;
  if (!start) return null;
  const d = new Date(start);
  const dow = dowMixed(d.getDay(), locale);
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  const time = rowTimeLabel(start, event.endsAt ?? null, locale);
  const dateLabel = `${dow} ${d.getDate()} ${month}`;
  return (
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
        onPress();
        router.push(`/event/${event.id}?source=search` as never);
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 20,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    paddingHorizontal: 0,
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
  // Top-zone — absolute over de body, hoogte = insets.top + ~76. Bevat
  // blur+gradient (AppHeader-stijl) zodat content er onderdoor fade't.
  topZone: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    paddingBottom: 8,
    zIndex: 10,
  },
  // Top-row: alleen de input + vierkante sluitknop ernaast. Beide 48px
  // hoog zodat ze visueel als één balk lezen.
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 22,
  },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    height: 48,
    borderRadius: 999,
    borderWidth: 1,
  },
  closeBtnSquare: {
    width: 48,
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 15,
    letterSpacing: -0.1,
    paddingVertical: 0,
  },
  // Empty/no-results — vertical-center op het scherm, smal genoeg
  // zodat lange zinnen over twee regels lopen. Icoon erboven voor
  // wat visueel ankertje.
  hintWrap: {
    flex: 1,
    paddingHorizontal: 56,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  hint: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  // Section-headers — zelfde display-stijl als de category-headers
  // op /agenda en /new: dikke font-titel, geen mono-kicker.
  sectionHead: {
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 6,
  },
  sectionHeadText: {
    fontFamily: fontFamily.displayBold,
    fontSize: 18,
    letterSpacing: -0.36,
  },
  // Venue-rij: compact (40px avatar + naam + subline) — anders dan
  // EventListRow zodat venues visueel onderscheidend zijn van events.
  venueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  venueText: { flex: 1, minWidth: 0 },
  venueName: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
  },
  venueSub: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  footerLoading: {
    paddingVertical: 20,
    alignItems: 'center',
  },
});
