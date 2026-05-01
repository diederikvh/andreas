import { Ionicons } from '@expo/vector-icons';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Cross } from '@/components/Cross';
import { useModeSwitch } from '@/components/ModeCurtain';
import type { EventRow as EventRowType, PhotoCard } from '@/mocks/feed';
import { FEED } from '@/mocks/feed';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HEADER_HEIGHT = 46;

export default function Avond() {
  const roles = useRoles();
  const mode = useMode();
  const insets = useSafeAreaInsets();
  const data = FEED[mode];

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
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
            <Text style={[styles.heroEm, { color: roles.emphasis }]}>
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
        <View style={styles.eventList}>
          {data.smallRooms.events.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </View>

        <View style={{ height: 28 }} />
        <SectionTitle
          title={data.photoBand.sectionTitle}
          meta={data.photoBand.sectionMeta}
        />
        <PhotoBand cards={data.photoBand.cards} />
      </ScrollView>
      <View style={[styles.headerWrap, { paddingTop: insets.top }]}>
        <MaskedView
          style={StyleSheet.absoluteFill}
          maskElement={
            <LinearGradient
              colors={['#000', '#000', 'transparent']}
              locations={[0, 0.8, 1]}
              style={StyleSheet.absoluteFill}
            />
          }
        >
          <BlurView
            intensity={40}
            tint={mode === 'nacht' ? 'dark' : 'light'}
            style={StyleSheet.absoluteFill}
          />
        </MaskedView>
        <Header />
      </View>
    </View>
  );
}

function Header() {
  const roles = useRoles();
  return (
    <View style={styles.header}>
      <View style={styles.logoLockup}>
        <Text style={[styles.wordmark, { color: roles.fg }]}>Andreas</Text>
        <View style={styles.logoCross}>
          <Cross size={16} thickness={4} color={roles.accent} />
        </View>
      </View>
      <DnSwitch />
    </View>
  );
}

function DnSwitch() {
  const mode = useMode();
  const roles = useRoles();
  const switchMode = useModeSwitch();
  const isNacht = mode === 'nacht';

  const trackBg = isNacht ? 'rgba(31,31,35,0.7)' : 'rgba(235,230,216,0.7)';
  const trackBorder = isNacht ? '#2a2a2d' : palette.paper;
  const idle = roles.fgPlaceholder;

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: isNacht }}
      onPress={switchMode}
      hitSlop={8}
      style={[styles.dnTrack, { backgroundColor: trackBg, borderColor: trackBorder }]}
    >
      {/* Sun: solid dot. Moon: Ionicons filled crescent. */}
      <View style={[styles.dnGlyph, styles.dnSun, { backgroundColor: idle }]} />
      <Ionicons name="moon" size={12} color={idle} style={styles.dnMoonIcon} />
      <View
        style={[
          styles.dnThumb,
          {
            backgroundColor: roles.accent,
            left: isNacht ? undefined : 2,
            right: isNacht ? 2 : undefined,
          },
        ]}
      />
    </Pressable>
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

// Per-mode tone mapping. In nacht the badge IS the brand colour; in
// dag the four brand accents shift to their warm-day counterparts so
// nothing acid/flare leaks into a dag canvas (mock app.html L311-L314).
const BADGE_TONE = {
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
} as const;

function EventRow({ event }: { event: EventRowType }) {
  const mode = useMode();
  const roles = useRoles();

  const tone = BADGE_TONE[mode][event.badgeTone];
  const badgeBg = `${tone}26`; // ~15% alpha hex

  return (
    <Pressable
      onPress={() => router.push(`/event/${event.id}`)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View style={styles.eventRow}>
        <Image
          source={{ uri: event.thumb }}
          style={styles.eventThumb}
          contentFit="cover"
        />
        <View style={styles.eventContent}>
          <Text
            numberOfLines={1}
            style={[styles.eventTitle, { color: roles.fg }]}
          >
            {event.title}
          </Text>
          <View style={styles.eventMetaRow}>
            <View style={[styles.eventBadge, { backgroundColor: badgeBg }]}>
              <Text style={[styles.eventBadgeText, { color: tone }]}>
                {event.badge}
              </Text>
            </View>
            <Text
              numberOfLines={1}
              style={[styles.eventMeta, { color: roles.fgMuted }]}
            >
              {event.meta}
            </Text>
          </View>
        </View>
        <Text style={[styles.eventArrow, { color: roles.fgPlaceholder }]}>›</Text>
      </View>
    </Pressable>
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

  // Header — floating over scroll content with a soft blur
  headerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  header: {
    height: HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  logoLockup: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  // Optical centring against the Archivo Black caps — uppercase has no
  // descenders so the text's visual centre sits above the row centre.
  logoCross: { transform: [{ translateY: -1 }] },
  wordmark: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.18,
    textTransform: 'uppercase',
    lineHeight: 18,
  },

  // Day/night switch (52×28 pill, thumb 22)
  dnTrack: {
    width: 52,
    height: 28,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
  },
  dnGlyph: {
    position: 'absolute',
    top: '50%',
    marginTop: -5, // -height/2
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  dnSun: { left: 8 },
  dnMoon: { right: 8 },
  dnMoonIcon: {
    position: 'absolute',
    top: '50%',
    right: 7,
    marginTop: -6, // -size/2
  },
  dnThumb: {
    position: 'absolute',
    top: '50%',
    marginTop: -11, // -height/2
    width: 22,
    height: 22,
    borderRadius: 999,
  },

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

  // Event row — no container, just rows with breathing room
  eventList: { paddingHorizontal: 18, gap: 16 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  eventThumb: {
    width: 68,
    height: 68,
    borderRadius: 8,
  },
  eventContent: { flex: 1, minWidth: 0 },
  eventTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.2,
    lineHeight: 14 * 1.2,
  },
  eventMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  eventBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  eventBadgeText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  eventMeta: {
    flex: 1,
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  eventArrow: { fontSize: 18 },

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
