import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ApiEvent } from '@/lib/api';
import { eventImageUrl, monthShort } from '@/lib/eventDisplay';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Horizontale strook met lopende tentoonstellingen ("Doorlopend te zien").
 * Een tentoonstelling is een event met `kind: 'exhibition'` — typisch
 * één lange occurrence met `endsAt` ver in de toekomst. Die past slecht
 * in de dag-bucket structuur van Avond/Agenda (zou alleen op de
 * start-dag verschijnen), dus tonen we 'm hier los, altijd zichtbaar
 * zolang 'ie loopt.
 *
 * Zelfde card-stijl als de Series-strook in Venues voor visuele rust.
 */
export function RunningExhibitions({ events }: { events: ApiEvent[] }) {
  const exhibitions = events.filter((e) => e.kind === 'exhibition');
  if (exhibitions.length === 0) return null;

  return (
    <RunningExhibitionsView exhibitions={exhibitions} />
  );
}

function RunningExhibitionsView({ exhibitions }: { exhibitions: ApiEvent[] }) {
  const roles = useRoles();
  const t = useT();
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={[styles.headLabel, { color: roles.fg }]}>
          {t('Doorlopend te zien', 'On view now')}
        </Text>
        <Text style={[styles.headCount, { color: roles.fgMuted }]}>
          {exhibitions.length}
          {exhibitions.length === 1
            ? t(' tentoonstelling', ' exhibition')
            : t(' tentoonstellingen', ' exhibitions')}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroller}
      >
        {exhibitions.map((e) => (
          <ExhibitionCard key={e.id} event={e} />
        ))}
      </ScrollView>
    </View>
  );
}

function ExhibitionCard({ event }: { event: ApiEvent }) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const locale = useLocale();
  const t = useT();
  const endsLabel = formatExhibitionEnd(event.endsAt, locale);
  const subtitle = [
    event.venue.name,
    endsLabel
      ? t(`loopt t/m ${endsLabel}`, `runs until ${endsLabel}`)
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      onPress={() => router.push(`/event/${event.id}` as never)}
      style={[
        styles.card,
        {
          backgroundColor: isNacht ? palette.noir2 : palette.paper2,
          borderColor: isNacht ? '#2a2a2d' : palette.paper,
        },
      ]}
    >
      {eventImageUrl(event) ? (
        <Image
          source={{ uri: eventImageUrl(event)! }}
          style={styles.cardImg}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.cardImg,
            { backgroundColor: isNacht ? palette.noir3 : palette.paper },
          ]}
        />
      )}
      <View style={styles.cardBody}>
        <Text
          numberOfLines={1}
          style={[styles.cardName, { color: roles.fg }]}
        >
          {event.title}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.cardMeta, { color: roles.fgMuted }]}
        >
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

function formatExhibitionEnd(
  endsAt: string | null,
  locale: Locale
): string | null {
  if (!endsAt) return null;
  const d = new Date(endsAt);
  return `${d.getDate()} ${monthShort(d.getMonth(), locale).toLowerCase()}`;
}

const styles = StyleSheet.create({
  // Zelfde stijl als Venues-tab series-strook voor visuele rust.
  section: { paddingTop: 4, paddingBottom: 4 },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 22,
    paddingTop: 6,
    paddingBottom: 8,
  },
  headLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    letterSpacing: 0.5,
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
  card: {
    width: 220,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  cardImg: {
    width: '100%',
    height: 100,
  },
  cardBody: {
    padding: 12,
    gap: 4,
  },
  cardName: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
  },
  cardMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
});
