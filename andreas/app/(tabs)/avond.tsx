import { useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import type { EventRow as EventRowType, PhotoCard } from '@/mocks/feed';
import { FEED } from '@/mocks/feed';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export default function Avond() {
  const roles = useRoles();
  const mode = useMode();
  const insets = useSafeAreaInsets();
  const data = FEED[mode];
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT,
          paddingBottom: insets.bottom + 96,
        }}
      >
        <View style={styles.hero}>
          <Text style={[styles.heroKicker, { color: roles.accent }]}>
            {data.hero.kicker}
          </Text>
          <Text style={[styles.heroTitle, { color: roles.fg }]}>
            {data.hero.titleBefore}
            <Text style={[styles.heroEm, { color: roles.accent }]}>
              {data.hero.titleEm}
            </Text>
            {data.hero.titleAfter}
          </Text>
        </View>

        <Pressable onPress={() => router.push('/event/featured')}>
          <FeaturedCard
            kicker={data.featured.kicker}
            title={data.featured.title}
            meta={data.featured.meta}
            photo={data.featured.photo}
          />
        </Pressable>

        <SectionTitle
          title={data.smallRooms.sectionTitle}
          meta={data.smallRooms.sectionMeta}
        />
        {data.smallRooms.events.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}

        <View style={{ height: 28 }} />
        <SectionTitle
          title={data.photoBand.sectionTitle}
          meta={data.photoBand.sectionMeta}
        />
        <PhotoBand cards={data.photoBand.cards} />
      </ScrollView>
      <AppHeader />
    </View>
  );
}

function FeaturedCard({
  kicker,
  title,
  meta,
  photo,
}: {
  kicker: string;
  title: string;
  meta: string;
  photo: string;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';

  return (
    <View style={styles.featuredWrap}>
      <View
        style={[
          styles.featured,
          { backgroundColor: isNacht ? palette.noir2 : roles.accent },
        ]}
      >
      <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} contentFit="cover" />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: isNacht
              ? 'rgba(10,10,11,0.55)'
              : 'rgba(201,69,58,0.55)',
          },
        ]}
      />
      <View style={styles.featuredInner}>
        <Text style={[styles.featuredKicker, { color: isNacht ? palette.acid : palette.paper3 }]}>
          {kicker}
        </Text>
        <View>
          <Text style={[styles.featuredTitle, { color: isNacht ? palette.ink : palette.paper3 }]}>
            {title}
          </Text>
          <Text style={[styles.featuredMeta, { color: isNacht ? 'rgba(242,242,239,0.85)' : 'rgba(245,241,232,0.95)' }]}>
            {meta}
          </Text>
        </View>
      </View>
      </View>
    </View>
  );
}

function SectionTitle({ title, meta }: { title: string; meta: string }) {
  const roles = useRoles();
  return (
    <View style={styles.sectionTitle}>
      <Text style={[styles.sectionTitleText, { color: roles.fg }]}>{title}</Text>
      <Text style={[styles.sectionTitleText, { color: roles.fgMuted }]}>{meta}</Text>
    </View>
  );
}

function EventRow({ event }: { event: EventRowType }) {
  return (
    <EventListRow
      thumb={event.thumb}
      title={event.title}
      venue={event.meta}
      tags={[{ label: event.badge, tone: event.badgeTone }]}
      friends={event.friends}
      tick={event.badgeTone}
      onPress={() => router.push(`/event/${event.id}`)}
    />
  );
}

function PhotoBand({ cards }: { cards: PhotoCard[] }) {
  return (
    <View style={styles.photoBand}>
      {cards.map((c) => (
        <View key={c.id} style={styles.photoCard}>
          <Image
            source={{ uri: c.photo }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: 'rgba(0,0,0,0.35)' },
            ]}
          />
          <View style={styles.photoCardContent}>
            <Text style={styles.pcKicker}>{c.kicker}</Text>
            <Text style={styles.pcTitle}>{c.title}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Hero
  hero: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12 },
  heroKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  heroTitle: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    lineHeight: 30 * 0.95,
    letterSpacing: -1,
    marginTop: 6,
  },
  heroEm: {
    fontFamily: fontFamily.body,
    fontStyle: 'italic',
  },

  // Featured — same horizontal inset as the rest of the feed
  featuredWrap: {
    paddingHorizontal: 18,
    marginBottom: 20,
  },
  featured: {
    aspectRatio: 1 / 1.2,
    borderRadius: 18,
    overflow: 'hidden',
    padding: 16,
    justifyContent: 'space-between',
  },
  featuredInner: { flex: 1, justifyContent: 'space-between' },
  featuredKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  featuredTitle: {
    fontFamily: fontFamily.display,
    fontSize: 34,
    lineHeight: 34 * 0.92,
    letterSpacing: -1.4,
  },
  featuredMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 10,
  },

  // Section title
  sectionTitle: {
    paddingHorizontal: 18,
    paddingBottom: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  sectionTitleText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // Photo band
  photoBand: {
    paddingHorizontal: 18,
    paddingBottom: 20,
    flexDirection: 'row',
    gap: 10,
  },
  photoCard: {
    flex: 1,
    aspectRatio: 3 / 4,
    borderRadius: 14,
    overflow: 'hidden',
  },
  photoCardContent: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 10,
  },
  pcKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: palette.ink,
    marginBottom: 4,
  },
  pcTitle: {
    fontFamily: fontFamily.display,
    fontSize: 17,
    lineHeight: 17 * 0.95,
    letterSpacing: -0.42,
    color: palette.ink,
  },
});
