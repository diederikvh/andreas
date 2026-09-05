/**
 * Eén museum als tegel: het beeld van wat er nu te zien is, de titel als
 * accent-blok erin, de naam eronder.
 *
 * De eenheid is de venue en niet het event. Bij film is de film de
 * hoofdzaak en de bioscoop bijzaak — "waar draait dit". Bij een museum
 * is het gebouw de constante en wisselt de inhoud: "wat hangt er in het
 * Stedelijk". Gedeeld tussen het raster op /musea en de rail op Vandaag,
 * zodat die twee niet uit elkaar lopen.
 */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MuseumVenue } from '@/lib/api';
import { formatWijk, monthShort } from '@/lib/eventDisplay';
import { softTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

export function MuseumCard({
  venue,
  width,
  /** Waar de tap vandaan komt, voor de bron-attributie op de venue-pagina. */
  source,
}: {
  venue: MuseumVenue;
  width: number;
  source: string;
}) {
  const roles = useRoles();
  const locale = useLocale();
  const t = useT();
  const first = venue.exhibitions[0];
  const extra = venue.exhibitions.length - 1;
  // Beeld van de tentoonstelling, niet van het gebouw: een gevel zegt
  // niks over of je er nú heen wilt. De venue-foto is de terugval.
  const image = first?.imageUrl ?? venue.imageUrl;

  return (
    <Pressable
      onPress={() => {
        softTap();
        router.push(`/venue/${venue.slug}?source=${source}` as never);
      }}
      style={{ width }}
    >
      <View
        style={[
          styles.poster,
          { backgroundColor: roles.bgLift, borderColor: roles.bgChip },
        ]}
      >
        {image ? (
          <Image
            source={{ uri: image }}
            style={styles.posterImg}
            contentFit="cover"
          />
        ) : null}
        {venue.followed && (
          <View style={[styles.followTick, { backgroundColor: roles.accent }]}>
            <Ionicons name="bookmark" size={11} color={roles.onAccent} />
          </View>
        )}
        {/* Titel als accent-blok ín de foto, net als het datum-blokje op
            de agenda-kaarten op Vandaag. Onder de foto viel 'ie weg
            tegen de museumnaam, terwijl juist die titel bepaalt of je
            gaat — de naam van het gebouw wist je al. */}
        {first ? (
          <View style={[styles.titleBadge, { backgroundColor: roles.accent }]}>
            <Text
              numberOfLines={3}
              style={[styles.titleBadgeText, { color: roles.onAccent }]}
            >
              {first.title}
            </Text>
            <Text style={[styles.titleBadgeDate, { color: roles.onAccent }]}>
              {runLabel(first, locale, t)}
            </Text>
          </View>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.venueName, { color: roles.fg }]}>
        {venue.name}
      </Text>
      <Text style={[styles.meta, { color: roles.fgPlaceholder }]}>
        {extra > 0 ? t(`+${extra} meer · `, `+${extra} more · `) : ''}
        {venue.wijk ? formatWijk(venue.wijk) : ''}
      </Text>
    </Pressable>
  );
}

/**
 * De looptijd in één regel. Voor iets dat nu hangt is de einddatum het
 * enige dat telt — dát is de reden om te gaan, niet wanneer het opende.
 * Wat nog moet beginnen keert het om, en een tentoonstelling zonder
 * einddatum loopt door.
 */
function runLabel(
  show: MuseumVenue['exhibitions'][number],
  locale: ReturnType<typeof useLocale>,
  t: ReturnType<typeof useT>
): string {
  const day = (iso: string) => {
    const d = new Date(iso);
    return `${d.getDate()} ${monthShort(d.getMonth(), locale).toLowerCase()}`;
  };
  const started = new Date(show.startsAt).getTime() <= Date.now();
  if (!started)
    return t(`vanaf ${day(show.startsAt)}`, `from ${day(show.startsAt)}`);
  if (!show.endsAt) return t('doorlopend', 'ongoing');
  return t(`t/m ${day(show.endsAt)}`, `until ${day(show.endsAt)}`);
}

const styles = StyleSheet.create({
  poster: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  posterImg: { width: '100%', height: '100%' },
  // Klein vlaggetje op de hoek voor venues die je volgt — die staan al
  // bovenaan, dit maakt zichtbaar wáárom.
  followTick: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 22,
    height: 22,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Linksonder, met ruimte rechts zodat 'ie niet de hele breedte vult —
  // een blok dat tot de rand loopt leest als een balk, niet als label.
  titleBadge: {
    position: 'absolute',
    left: 8,
    right: 14,
    bottom: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 7,
  },
  titleBadgeText: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    lineHeight: 16,
    letterSpacing: -0.2,
  },
  titleBadgeDate: {
    marginTop: 2,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  venueName: {
    marginTop: 8,
    fontFamily: fontFamily.displayBold,
    fontSize: 14,
    letterSpacing: -0.24,
  },
  meta: {
    marginTop: 3,
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});
