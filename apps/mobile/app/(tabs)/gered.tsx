import { useScrollToTop } from '@react-navigation/native';
import { router } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { brandEase } from '@/lib/easing';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import type { GeredItem, GeredView } from '@/mocks/gered';
import { GERED, GERED_HEAD } from '@/mocks/gered';
import { useMode, useRoles } from '@/store/mode';
import { useSavedList } from '@/store/saved';
import { fontFamily } from '@/theme/tokens';

const SCREEN_W = Dimensions.get('window').width;

// Until a thumb is part of the data, fall back to a per-category image
// so the saved rows look the same as the Agenda's.
const CATEGORY_THUMB: Record<string, string> = {
  Muziek:
    'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=200&q=60&auto=format&fit=crop',
  Theater:
    'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=200&q=60&auto=format&fit=crop',
  Literatuur:
    'https://images.unsplash.com/photo-1485579149621-3123dd979885?w=200&q=60&auto=format&fit=crop',
  Film: 'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=200&q=60&auto=format&fit=crop',
};

type Group = {
  key: string;
  dow: string;
  num: string;
  month: string;
  items: GeredItem[];
};

function groupByDate(items: GeredItem[]): Group[] {
  const map = new Map<string, Group>();
  for (const item of items) {
    const key = `${item.num}-${item.month}`;
    const existing = map.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      map.set(key, {
        key,
        dow: item.dow,
        num: item.num,
        month: item.month,
        items: [item],
      });
    }
  }
  return Array.from(map.values());
}

export default function Gered() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const upRef = useRef<ScrollView>(null);
  const pastRef = useRef<ScrollView>(null);
  useScrollToTop(upRef);
  useScrollToTop(pastRef);

  const head = GERED_HEAD[mode];
  const [view, setView] = useState<GeredView>('up');
  const pos = useSharedValue(0);
  const savedList = useSavedList();

  const toggle = () => {
    const next: GeredView = view === 'up' ? 'past' : 'up';
    pos.value = withTiming(next === 'past' ? 1 : 0, {
      duration: 320,
      easing: brandEase,
    });
    setView(next);
  };

  const pagesStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -pos.value * SCREEN_W }],
  }));

  const topInset = insets.top + HEADER_HEIGHT;
  const bottomInset = insets.bottom + 96;

  // Saves coming from the heart-button on the detail screen sit above
  // the per-mode mock list under their own "Net opgeslagen" anchor.
  // Filter out any id that is already in the mock so we don't double-render.
  const mockIds = new Set(GERED[mode].up.map((i) => i.id));
  const savedItems: GeredItem[] = savedList.filter((s) => !mockIds.has(s.id));

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <View style={styles.pagesViewport}>
        <Animated.View style={[styles.pages, pagesStyle]}>
          <Page
            scrollRef={upRef}
            kicker="Zin in"
            title={head.title}
            link="Geschiedenis →"
            onLink={toggle}
            items={GERED[mode].up}
            savedItems={savedItems}
            topInset={topInset}
            bottomInset={bottomInset}
          />
          <Page
            scrollRef={pastRef}
            kicker="Goeie tijden"
            title="Geweest."
            link="Mijn planning →"
            onLink={toggle}
            items={GERED[mode].past}
            topInset={topInset}
            bottomInset={bottomInset}
          />
        </Animated.View>
      </View>
      <AppHeader />
    </View>
  );
}

function Page({
  scrollRef,
  kicker,
  title,
  link,
  onLink,
  items,
  savedItems,
  topInset,
  bottomInset,
}: {
  scrollRef: React.RefObject<ScrollView | null>;
  kicker: string;
  title: string;
  link: string;
  onLink: () => void;
  items: GeredItem[];
  savedItems?: GeredItem[];
  topInset: number;
  bottomInset: number;
}) {
  const roles = useRoles();
  const groups = useMemo(() => groupByDate(items), [items]);
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.page}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingTop: topInset,
        paddingBottom: bottomInset,
      }}
    >
      <View style={styles.head}>
        <Text style={[styles.headKicker, { color: roles.accent }]}>
          {kicker}
        </Text>
        <View style={styles.headTitleRow}>
          <Text style={[styles.headTitle, { color: roles.fg }]}>{title}</Text>
          <Pressable onPress={onLink} hitSlop={8}>
            <Text style={[styles.archiefLink, { color: roles.fgMuted }]}>
              {link}
            </Text>
          </Pressable>
        </View>
      </View>
      {savedItems && savedItems.length > 0 && (
        <View>
          <SavedAnchor count={savedItems.length} />
          {savedItems.map((item) => (
            <GeredRow key={item.id} item={item} />
          ))}
        </View>
      )}
      {groups.map((group) => (
        <View key={group.key}>
          <DateAnchor group={group} />
          {group.items.map((item) => (
            <GeredRow key={item.id} item={item} />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function SavedAnchor({ count }: { count: number }) {
  const roles = useRoles();
  return (
    <View style={styles.anchor}>
      <View style={styles.anchorLeft}>
        <Text style={[styles.anchorDow, { color: roles.fg }]}>
          Net opgeslagen
        </Text>
      </View>
      <Text style={[styles.anchorCount, { color: roles.fgPlaceholder }]}>
        {count} {count === 1 ? 'plan' : 'plannen'}
      </Text>
    </View>
  );
}

function DateAnchor({ group }: { group: Group }) {
  const roles = useRoles();
  return (
    <View style={styles.anchor}>
      <View style={styles.anchorLeft}>
        <Text style={[styles.anchorDow, { color: roles.fg }]}>
          {group.dow} {group.num}
        </Text>
        <Text style={[styles.anchorMonth, { color: roles.fgMuted }]}>
          {group.month}
        </Text>
      </View>
      <Text style={[styles.anchorCount, { color: roles.fgPlaceholder }]}>
        {group.items.length} {group.items.length === 1 ? 'plan' : 'plannen'}
      </Text>
    </View>
  );
}

function GeredRow({ item }: { item: GeredItem }) {
  return (
    <EventListRow
      time={item.time}
      duration={item.duration}
      thumb={CATEGORY_THUMB[item.category] ?? CATEGORY_THUMB.Muziek}
      title={item.title}
      venue={item.venue}
      tags={[{ label: item.category, tone: item.tick }]}
      friends={item.friends}
      tick={item.tick}
      onPress={() => router.push(`/event/${item.id}`)}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Two-page swipeable container (up | past). The Animated.View is
  // absolutely positioned so it stretches to fill the viewport's height
  // — `flex: 1` together with a fixed `width: 2x` confused the layout
  // and broke vertical scrolling on the inner ScrollViews.
  pagesViewport: { flex: 1, overflow: 'hidden' },
  pages: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
    width: SCREEN_W * 2,
  },
  page: { width: SCREEN_W },

  // Head — kicker + display title with a small archive link
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
  headTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: 6,
    gap: 10,
  },
  headTitle: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    letterSpacing: -0.9,
    lineHeight: 30,
  },
  archiefLink: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },

  // Date anchor
  anchor: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 22,
    paddingTop: 14,
    paddingBottom: 6,
    gap: 10,
  },
  anchorLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  anchorDow: {
    fontFamily: fontFamily.display,
    fontSize: 22,
    letterSpacing: -0.44,
  },
  anchorMonth: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  anchorCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

});
