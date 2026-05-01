import { useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useMemo, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  DOW_NL_UPPER,
  formatTime,
} from '@/lib/eventDisplay';
import { useEvents } from '@/lib/queries';
import type { PhotoCard } from '@/mocks/feed';
import { FEED } from '@/mocks/feed';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

function formatMeta(event: ApiEvent): string {
  const d = new Date(event.startsAt);
  const dow = DOW_NL_UPPER[d.getDay()];
  const price =
    event.priceCents == null
      ? null
      : event.priceCents === 0
        ? 'gratis'
        : `€${(event.priceCents / 100).toFixed(0)}`;
  return [dow, formatTime(event.startsAt), event.venue.name.toUpperCase(), price]
    .filter(Boolean)
    .join(' · ');
}

// Avond is "vandaag" — slechts één dag. Wie meer wil, scrolt door
// naar de Agenda.
const HOME_WINDOW_DAYS = 1;

/** Vanaf welk uur een event als "avond" geldt (anders: "overdag"). */
const NACHT_HOUR_THRESHOLD = 17;

function homeWindow(mode: 'nacht' | 'dag'): {
  from: string;
  to: string;
  refDate: Date;
  shifted: boolean;
} {
  const now = new Date();
  const refDate = new Date(now);
  refDate.setHours(0, 0, 0, 0);
  // Dag-mode na 17:00: vandaag's overdag-window is voorbij, dus
  // verschuif het venster naar morgen. Nacht-mode niet verschuiven —
  // events die om 22:00 starten zijn ook om 02:00 nog "vanavond".
  let shifted = false;
  if (mode === 'dag' && now.getHours() >= NACHT_HOUR_THRESHOLD) {
    refDate.setDate(refDate.getDate() + 1);
    shifted = true;
  }
  const to = new Date(refDate);
  to.setDate(to.getDate() + HOME_WINDOW_DAYS);
  return {
    from: refDate.toISOString(),
    to: to.toISOString(),
    refDate,
    shifted,
  };
}

const DOW_NL_LOWER = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'] as const;
const MONTHS_NL_LONG = [
  'jan', 'feb', 'mrt', 'apr', 'mei', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
] as const;

type Hero = {
  kicker: string;
  titleBefore: string;
  titleEm: string;
  titleAfter: string;
};

/**
 * Hero-copy hangt af van de mode (vanavond vs overdag), de grootte
 * van de gecureerde lijst, en of we naar morgen zijn verschoven
 * (alleen in dag-mode na 17:00).
 */
function buildHero(
  mode: 'nacht' | 'dag',
  count: number,
  refDate: Date,
  shifted: boolean
): Hero {
  const dow = DOW_NL_LOWER[refDate.getDay()];
  const day = refDate.getDate();
  const month = MONTHS_NL_LONG[refDate.getMonth()];
  const datePart = `${dow} ${day} ${month}`;

  if (mode === 'nacht') {
    const kicker = `Vanavond · ${datePart}`;
    if (count === 0) {
      return { kicker, titleBefore: '', titleEm: 'Niets', titleAfter: '\nvoor vanavond.' };
    }
    if (count === 1) {
      return {
        kicker,
        titleBefore: 'Eén ding die\n',
        titleEm: 'vanavond',
        titleAfter: ' telt.',
      };
    }
    return {
      kicker,
      titleBefore: `${count} dingen\ndie `,
      titleEm: 'vanavond',
      titleAfter: ' tellen.',
    };
  }

  // Dag-mode: bij shifted (na 17:00) lopen we naar morgen.
  const dayLabel = shifted ? 'Morgen' : 'Vandaag';
  const planEm = shifted ? 'morgen' : 'overdag';
  const kicker = `${dayLabel} · ${datePart}`;
  if (count === 0) {
    return {
      kicker,
      titleBefore: '',
      titleEm: 'Niets',
      titleAfter: shifted ? '\nvoor morgen overdag.' : '\nvoor overdag.',
    };
  }
  if (count === 1) {
    return {
      kicker,
      titleBefore: 'Eén ding om\n',
      titleEm: planEm,
      titleAfter: ' te plannen.',
    };
  }
  return {
    kicker,
    titleBefore: `${count} dingen om\n`,
    titleEm: planEm,
    titleAfter: ' te plannen.',
  };
}

export default function Avond() {
  const roles = useRoles();
  const mode = useMode();
  const insets = useSafeAreaInsets();
  const data = FEED[mode];
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  const window = useMemo(() => homeWindow(mode), [mode]);
  // Avond toont *alles* binnen het 3-daagse venster, gesplitst op
  // tijd-van-dag. De featured-flag dient alleen om één event als
  // hoofd-artikel boven uit te lichten — niet om de lijst eronder te
  // filteren.
  const { data: events, isLoading, error } = useEvents({
    from: window.from,
    to: window.to,
  });
  const filtered = useMemo(() => {
    if (!events) return [];
    return events.filter((e) => {
      const hour = new Date(e.startsAt).getHours();
      return mode === 'nacht'
        ? hour >= NACHT_HOUR_THRESHOLD
        : hour < NACHT_HOUR_THRESHOLD;
    });
  }, [events, mode]);
  // Hoofd-artikel: random featured event uit de huidige split. Geen
  // featured? Dan eerste event uit de split. useMemo zorgt dat dezelfde
  // pick blijft staan zolang de input-lijst niet verandert.
  const lead = useMemo(() => {
    if (filtered.length === 0) return undefined;
    const featuredCandidates = filtered.filter((e) => e.featured);
    if (featuredCandidates.length === 0) return filtered[0];
    return featuredCandidates[
      Math.floor(Math.random() * featuredCandidates.length)
    ];
  }, [filtered]);
  const rest = lead ? filtered.filter((e) => e.id !== lead.id) : filtered;

  const hero = buildHero(mode, filtered.length, window.refDate, window.shifted);

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
            {hero.kicker}
          </Text>
          <Text style={[styles.heroTitle, { color: roles.fg }]}>
            {hero.titleBefore}
            <Text style={[styles.heroEm, { color: roles.accent }]}>
              {hero.titleEm}
            </Text>
            {hero.titleAfter}
          </Text>
        </View>

        {/* Cat-tabs zijn shortcuts naar de Agenda met categorie voorgefilterd.
            Avond filtert nooit op categorie zelf — die rol heeft Agenda. */}
        <CategoryTabs />

        {/* Hoofd-artikel: eerste featured event als grote kaart bovenaan.
            Tot we een dedicated lead-flag hebben pakken we de eerstvolgende
            featured-pick. */}
        {lead && (
          <Pressable onPress={() => router.push(`/event/${lead.id}`)}>
            <FeaturedCard
              kicker={data.featured.kicker}
              title={lead.title}
              meta={formatMeta(lead)}
              photo={lead.imageUrl ?? data.featured.photo}
            />
          </Pressable>
        )}

        {isLoading && <ListState text="Laden…" />}
        {error && <ListState text="Kon events niet laden." tone="error" />}
        {!isLoading && !error && filtered.length === 0 && events && (
          <ListState
            text={
              mode === 'nacht'
                ? 'Vanavond niets gepland.'
                : window.shifted
                  ? 'Morgen overdag niets gepland.'
                  : 'Overdag niets gepland.'
            }
          />
        )}
        {rest.length > 0 && (
          <>
            <SectionTitle
              title={
                mode === 'nacht'
                  ? 'Vanavond'
                  : window.shifted
                    ? 'Morgen overdag'
                    : 'Overdag'
              }
              meta="Alles →"
              onMetaPress={() => router.push('/agenda')}
            />
            {rest.map((e) => <ApiEventRow key={e.id} event={e} />)}
          </>
        )}

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

function CategoryTabs() {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const homeLabel = isNacht ? 'Vanavond' : 'Overdag';
  const cats: { label: string; cat: ApiEvent['category'] | null }[] = [
    { label: homeLabel, cat: null },
    { label: 'Muziek', cat: 'Muziek' },
    { label: 'Theater', cat: 'Theater' },
    { label: 'Literatuur', cat: 'Literatuur' },
    { label: 'Film', cat: 'Film' },
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.catTabs}
    >
      {cats.map(({ label, cat }) => {
        // Eerste chip is de "current view"-indicator: Vanavond/Overdag
        // staat altijd actief op Avond. Tappen doet niets — andere chips
        // springen naar Agenda met de filter voorgeselecteerd.
        const active = cat === null;
        return (
          <Pressable
            key={label}
            onPress={
              active
                ? undefined
                : () =>
                    router.push({
                      pathname: '/agenda',
                      params: { cat: cat as string },
                    })
            }
            style={[
              styles.catTab,
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
                styles.catTabText,
                { color: active ? roles.bg : roles.fgMuted },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ApiEventRow({ event }: { event: ApiEvent }) {
  const friends = event.friendsSaved?.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  return (
    <EventListRow
      thumb={event.imageUrl ?? ''}
      title={event.title}
      venue={formatMeta(event)}
      tags={[{ label: event.category, tone: CATEGORY_TICK[event.category] }]}
      friends={friends && friends.length > 0 ? friends : undefined}
      tick={CATEGORY_TICK[event.category]}
      onPress={() => router.push(`/event/${event.id}`)}
    />
  );
}

function ListState({
  text,
  tone = 'muted',
}: {
  text: string;
  tone?: 'muted' | 'error';
}) {
  const roles = useRoles();
  return (
    <View style={styles.listState}>
      <Text
        style={[
          styles.listStateText,
          { color: tone === 'error' ? '#c9453a' : roles.fgMuted },
        ]}
      >
        {text}
      </Text>
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

function SectionTitle({
  title,
  meta,
  onMetaPress,
}: {
  title: string;
  meta: string;
  onMetaPress?: () => void;
}) {
  const roles = useRoles();
  if (onMetaPress) {
    return (
      <View style={styles.sectionTitle}>
        <Text style={[styles.sectionTitleText, { color: roles.fg }]}>
          {title}
        </Text>
        <Pressable onPress={onMetaPress} hitSlop={8}>
          <Text style={[styles.sectionTitleText, { color: roles.accent }]}>
            {meta}
          </Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.sectionTitle}>
      <Text style={[styles.sectionTitleText, { color: roles.fg }]}>{title}</Text>
      <Text style={[styles.sectionTitleText, { color: roles.fgMuted }]}>{meta}</Text>
    </View>
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

  // Category tabs (Avond) — navigate to Agenda met filter
  catTabs: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 18,
    paddingTop: 4,
    paddingBottom: 14,
  },
  catTab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  catTabText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    letterSpacing: -0.06,
  },

  // List loading / error
  listState: {
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  listStateText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
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
