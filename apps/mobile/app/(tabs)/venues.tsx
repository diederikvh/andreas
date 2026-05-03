import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import type { ApiVenueListItem, VenueCategory } from '@/lib/api';
import { CATEGORY_TICK } from '@/lib/eventDisplay';
import { useVenues } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const CATEGORIES: VenueCategory[] = [
  'Muziek',
  'Theater',
  'Literatuur',
  'Film',
];

const TONE: Record<
  'nacht' | 'dag',
  Record<'acid' | 'flare' | 'plum' | 'azure', string>
> = {
  nacht: {
    acid: palette.acid,
    flare: palette.flare,
    plum: palette.plum,
    azure: palette.azure,
  },
  dag: {
    acid: palette.red,
    flare: palette.forest,
    plum: palette.cobalt,
    azure: '#8a5b00',
  },
};

const CHIPROW_HEIGHT = 48;

/**
 * Venues-tab — bladerbare lijst van alle venues met categorie-chips
 * en zoekveld. URL-synced via `?cat=` en `?q=` zodat deeplinks (bv.
 * filter-tap elders) direct landen op de juiste view.
 */
export default function Venues() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  // Filter is een union: 'alles' (default), 'volgend' (alleen venues
  // die ik volg, client-side filter), of een VenueCategory.
  type Filter = 'alles' | 'volgend' | VenueCategory;
  const params = useLocalSearchParams<{ cat?: string; q?: string }>();
  const activeFilter = useMemo<Filter>(() => {
    if (!params.cat) return 'alles';
    if (params.cat === 'volgend') return 'volgend';
    return (CATEGORIES as string[]).includes(params.cat)
      ? (params.cat as VenueCategory)
      : 'alles';
  }, [params.cat]);
  const initialQ = params.q ?? '';

  const [q, setQ] = useState(initialQ);
  const [debouncedQ, setDebouncedQ] = useState(initialQ);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  // Server filtert op category (en query). 'volgend' is een client-
  // side filter — we hebben de hele lijst sowieso al, en `volgend`
  // hangt af van per-user state.
  const categoryParam =
    activeFilter === 'alles' || activeFilter === 'volgend'
      ? undefined
      : activeFilter;
  const { data: venuesAll, isLoading } = useVenues({
    q: debouncedQ,
    category: categoryParam,
  });
  const venues = useMemo(() => {
    if (!venuesAll) return [];
    if (activeFilter === 'volgend') {
      return venuesAll.filter((v) => v.myFollowState === 'volgen');
    }
    return venuesAll;
  }, [venuesAll, activeFilter]);

  const setFilter = (f: Filter) => {
    router.setParams({ cat: f === 'alles' ? '' : f });
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: roles.bg }]}
    >
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT,
          paddingBottom: insets.bottom + 96,
        }}
      >
        <View style={styles.head}>
          <Text style={[styles.headKicker, { color: roles.accent }]}>
            Venues
          </Text>
          <Text style={[styles.headTitle, { color: roles.fg }]}>
            Plekken in de stad.
          </Text>
        </View>

        <ChipRow
          activeFilter={activeFilter}
          query={q}
          onFilter={setFilter}
          onQuery={setQ}
        />

        {isLoading ? (
          <Text style={[styles.hint, { color: roles.fgMuted }]}>Laden…</Text>
        ) : venues.length === 0 ? (
          <Text style={[styles.hint, { color: roles.fgMuted }]}>
            {debouncedQ.length > 0
              ? `Geen venue gevonden voor "${debouncedQ}".`
              : activeFilter === 'volgend'
                ? 'Je volgt nog geen venues.'
                : activeFilter !== 'alles'
                  ? `Geen ${activeFilter.toLowerCase()}-venues op dit moment.`
                  : 'Geen venues om te tonen.'}
          </Text>
        ) : (
          venues.map((v) => <VenueRow key={v.id} venue={v} />)
        )}
      </ScrollView>
      <AppHeader />
    </KeyboardAvoidingView>
  );
}

function VenueRow({ venue }: { venue: ApiVenueListItem }) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  return (
    <Pressable
      onPress={() => router.push(`/venue/${venue.slug}` as never)}
      style={[styles.row, { borderColor: roles.bgChip }]}
    >
      {venue.imageUrl ? (
        <Image
          source={{ uri: venue.imageUrl }}
          style={styles.thumb}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.thumb,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        />
      )}
      <View style={styles.body}>
        <Text numberOfLines={1} style={[styles.name, { color: roles.fg }]}>
          {venue.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.address, { color: roles.fgMuted }]}
        >
          {venue.address}
        </Text>
        {(venue.categories ?? []).length > 0 && (
          <View style={styles.tags}>
            {(venue.categories ?? []).map((cat) => {
              const tone = TONE[mode][CATEGORY_TICK[cat]];
              return (
                <View
                  key={cat}
                  style={[styles.tag, { backgroundColor: `${tone}26` }]}
                >
                  <Text
                    style={[styles.tagText, { color: toneText(tone, mode) }]}
                  >
                    {cat}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </View>
      <FollowBadge state={venue.myFollowState} />
    </Pressable>
  );
}

function FollowBadge({
  state,
}: {
  state: ApiVenueListItem['myFollowState'];
}) {
  const mode = useMode();
  const roles = useRoles();
  if (state === 'normaal') return null;
  const isVolgen = state === 'volgen';
  const tone = isVolgen
    ? mode === 'nacht'
      ? palette.acid
      : palette.red
    : roles.fgPlaceholder;
  return (
    <View style={[styles.followBadge, { borderColor: `${tone}80` }]}>
      <Ionicons
        name={isVolgen ? 'heart' : 'ban-outline'}
        size={12}
        color={tone}
      />
    </View>
  );
}

function ChipRow({
  activeFilter,
  query,
  onFilter,
  onQuery,
}: {
  activeFilter: 'alles' | 'volgend' | VenueCategory;
  query: string;
  onFilter: (f: 'alles' | 'volgend' | VenueCategory) => void;
  onQuery: (q: string) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);
  // Het zoekveld is "open" zodra het focus heeft of tekst bevat. Idle
  // = alleen de magnifier; open = ruim genoeg om te typen, en groeit
  // mee met de inhoud zodat lange queries niet worden afgekapt.
  const open = focused || query.length > 0;
  const COLLAPSED_W = 36;
  const MIN_OPEN_W = 110;
  const MAX_OPEN_W = 240;
  const textWidthEstimate = 36 + query.length * 7 + 16;
  const width = !open
    ? COLLAPSED_W
    : Math.min(MAX_OPEN_W, Math.max(MIN_OPEN_W, textWidthEstimate));

  const onIconPress = () => {
    if (open) {
      onQuery('');
      inputRef.current?.blur();
    } else {
      inputRef.current?.focus();
    }
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRow}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={[
          styles.searchChip,
          {
            backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            borderColor: isNacht ? '#2a2a2d' : palette.paper,
            width,
          },
        ]}
      >
        <Pressable onPress={onIconPress} hitSlop={6} style={styles.searchIcon}>
          <Ionicons
            name={open ? 'close' : 'search'}
            size={14}
            color={roles.fgMuted}
          />
        </Pressable>
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={onQuery}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={open ? 'ZOEK' : ''}
          placeholderTextColor={roles.fgPlaceholder}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.searchInput, { color: roles.fg }]}
        />
      </View>
      <CatChip
        label="Alles"
        active={activeFilter === 'alles'}
        onPress={() => onFilter('alles')}
      />
      <CatChip
        label="Volgend"
        active={activeFilter === 'volgend'}
        onPress={() =>
          onFilter(activeFilter === 'volgend' ? 'alles' : 'volgend')
        }
      />
      {CATEGORIES.map((cat) => (
        <CatChip
          key={cat}
          label={cat}
          active={activeFilter === cat}
          onPress={() =>
            onFilter(activeFilter === cat ? 'alles' : cat)
          }
        />
      ))}
    </ScrollView>
  );
}

function CatChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.catChip,
        {
          borderColor: active
            ? roles.fg
            : isNacht
              ? '#2a2a2d'
              : palette.paper,
          backgroundColor: active
            ? roles.fg
            : isNacht
              ? palette.noir2
              : palette.paper2,
        },
      ]}
    >
      <Text
        style={[
          styles.catChipText,
          { color: active ? roles.bg : roles.fgMuted },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// Helper: lichte mix van tone-color voor leesbare tekst-op-getinte-bg
// labels — zelfde patroon als in EventListRow.
function toneText(hex: string, mode: 'nacht' | 'dag'): string {
  if (mode === 'dag') return hex;
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const blend = (c: number) =>
    Math.round(c + (255 - c) * 0.35)
      .toString(16)
      .padStart(2, '0');
  return `#${blend(r)}${blend(g)}${blend(b)}`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  head: {
    paddingHorizontal: 22,
    paddingTop: 4,
    paddingBottom: 12,
  },
  headKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  headTitle: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    letterSpacing: -0.9,
    lineHeight: 30,
    marginTop: 6,
  },

  hint: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },

  // Chip-row — gespiegeld op Agenda zodat 't visueel matcht
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 22,
    paddingVertical: 6,
    height: CHIPROW_HEIGHT,
  },
  searchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
  },
  searchIcon: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchInput: {
    flex: 1,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    padding: 0,
    margin: 0,
    height: 20,
  },
  catChip: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    letterSpacing: -0.06,
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thumb: { width: 76, height: 76, borderRadius: 10 },
  body: { flex: 1, minWidth: 0, gap: 4 },
  name: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
    lineHeight: 18,
  },
  address: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  tags: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  tag: {
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },

  followBadge: {
    width: 26,
    height: 26,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
});
