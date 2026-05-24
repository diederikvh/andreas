/**
 * Andreas × Artist — landingspagina voor één artist. Aanlandpunt
 * vanuit lineup-items op event-detail. Toont:
 *   - naam + genres
 *   - streaming-knoppen (Spotify, Apple Music, Bandcamp, YouTube,
 *     official site) — alleen waar URL bekend is
 *   - komende events in Amsterdam waar deze artist op de lineup staat
 *   - fallback search-knoppen wanneer geen specifieke links bekend
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useMemo } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import type { ApiArtistEvent } from '@/lib/api';
import { dowMixed, eventPosterUrl, monthShort, rowTimeLabel } from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { useArtist } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export default function ArtistPage() {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, isLoading, error } = useArtist(slug ?? '');

  const links = useMemo(() => {
    if (!data?.artist) return [];
    const a = data.artist;
    const out: Array<{ key: string; label: string; url: string; icon: keyof typeof Ionicons.glyphMap }> = [];
    if (a.spotifyUrl) out.push({ key: 'spotify', label: 'Spotify', url: a.spotifyUrl, icon: 'musical-notes' });
    if (a.appleMusicUrl) out.push({ key: 'apple', label: 'Apple Music', url: a.appleMusicUrl, icon: 'musical-note' });
    if (a.bandcampUrl) out.push({ key: 'bandcamp', label: 'Bandcamp', url: a.bandcampUrl, icon: 'disc' });
    if (a.youtubeUrl) out.push({ key: 'youtube', label: 'YouTube', url: a.youtubeUrl, icon: 'logo-youtube' });
    if (a.officialUrl) out.push({ key: 'official', label: t('Website', 'Website'), url: a.officialUrl, icon: 'globe-outline' });
    return out;
  }, [data, t]);

  // Geen specifieke links bekend → fallback naar zoeklinks. Maakt de
  // pagina altijd nuttig, ook voor artists waar MB niets had.
  const fallback = useMemo(() => {
    if (!data?.artist || links.length > 0) return [];
    const q = encodeURIComponent(data.artist.name);
    return [
      { key: 's-search', label: t('Zoek op Spotify', 'Search Spotify'), url: `https://open.spotify.com/search/${q}`, icon: 'musical-notes' as const },
      { key: 'a-search', label: t('Zoek op Apple Music', 'Search Apple Music'), url: `https://music.apple.com/nl/search?term=${q}`, icon: 'musical-note' as const },
    ];
  }, [data, links.length, t]);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT + 12,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 22,
        }}
      >
        {isLoading && (
          <Text style={[styles.dim, { color: roles.fgMuted }]}>
            {t('Laden…', 'Loading…')}
          </Text>
        )}
        {error && (
          <Text style={[styles.dim, { color: roles.fgMuted }]}>
            {t('Kon artist niet laden.', 'Couldn’t load artist.')}
          </Text>
        )}
        {data && (
          <>
            <Text style={[styles.name, { color: roles.fg }]}>
              {data.artist.name}
            </Text>

            {data.artist.genres.length > 0 && (
              <View style={styles.genreRow}>
                {data.artist.genres.slice(0, 4).map((g) => (
                  <View
                    key={g}
                    style={[styles.genreChip, { backgroundColor: `${roles.accent}26` }]}
                  >
                    <Text style={[styles.genreText, { color: roles.accent }]}>
                      {g.toLowerCase()}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {data.artist.description && (
              <Text style={[styles.description, { color: roles.fgRead }]}>
                {data.artist.description}
              </Text>
            )}

            {links.length > 0 && (
              <View style={styles.linksGrid}>
                {links.map((l) => (
                  <LinkButton key={l.key} label={l.label} url={l.url} icon={l.icon} />
                ))}
              </View>
            )}

            {fallback.length > 0 && (
              <View style={{ gap: 8, marginTop: 18 }}>
                <Text style={[styles.fallbackHint, { color: roles.fgMuted }]}>
                  {t(
                    'Nog geen directe links — probeer een zoekopdracht:',
                    'No direct links yet — try a search:'
                  )}
                </Text>
                {fallback.map((l) => (
                  <LinkButton key={l.key} label={l.label} url={l.url} icon={l.icon} />
                ))}
              </View>
            )}

            {data.events.length > 0 && (
              <View style={styles.eventsSection}>
                <Text style={[styles.sectionLabel, { color: roles.fg }]}>
                  {t('Komende voorstellingen', 'Upcoming shows')}
                </Text>
                {data.events.map((ev) => (
                  <EventRow key={ev.id} ev={ev} locale={locale} />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>

      <AppHeader
        title={data?.artist.name ?? t('Artist', 'Artist')}
        hideAvatar
        rightSlot={
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            style={[
              styles.closeBtn,
              { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Ionicons name="close" size={20} color={roles.fg} />
          </Pressable>
        }
      />
    </View>
  );
}

function LinkButton({
  label,
  url,
  icon,
}: {
  label: string;
  url: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={() => WebBrowser.openBrowserAsync(url)}
      style={[styles.linkBtn, { backgroundColor: roles.bgLift }]}
    >
      <Ionicons name={icon} size={20} color={roles.accent} />
      <Text style={[styles.linkLabel, { color: roles.fg }]}>{label}</Text>
      <Ionicons name="open-outline" size={16} color={roles.fgMuted} />
    </Pressable>
  );
}

function EventRow({ ev, locale }: { ev: ApiArtistEvent; locale: ReturnType<typeof useLocale> }) {
  const roles = useRoles();
  const d = new Date(ev.nextOccurrence.startsAt);
  const date = `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(d.getMonth(), locale).toLowerCase()}`;
  const time = rowTimeLabel(ev.nextOccurrence.startsAt, ev.nextOccurrence.endsAt, locale);
  const poster = eventPosterUrl({
    imageUrl: ev.imageUrl,
    posterUrl: ev.posterUrl,
    venue: { imageUrl: null },
  });
  return (
    <Pressable
      onPress={() => router.push(`/event/${ev.id}` as never)}
      style={[styles.eventRow, { borderColor: roles.bgChip }]}
    >
      <View style={[styles.eventThumb, { backgroundColor: roles.bgChip }]}>
        {poster ? (
          <Image source={{ uri: poster }} style={styles.eventThumbImg} contentFit="cover" />
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={[styles.eventTitle, { color: roles.fg }]}>
          {ev.title}
        </Text>
        <Text style={[styles.eventMeta, { color: roles.fgMuted }]} numberOfLines={1}>
          {date} · {time} · {ev.venue.name}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  dim: { fontFamily: fontFamily.mono, fontSize: 12, letterSpacing: 0.8 },
  name: {
    fontFamily: fontFamily.bold,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.8,
    marginBottom: 10,
  },
  genreRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 },
  genreChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  genreText: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  description: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  linksGrid: { gap: 8, marginTop: 8 },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    gap: 10,
  },
  linkLabel: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.17,
  },
  fallbackHint: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    fontStyle: 'italic',
  },
  eventsSection: { marginTop: 24 },
  sectionLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 17,
    letterSpacing: -0.34,
    marginBottom: 8,
  },
  eventRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  eventThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    overflow: 'hidden',
  },
  eventThumbImg: { width: '100%', height: '100%' },
  eventTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.17,
  },
  eventMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
