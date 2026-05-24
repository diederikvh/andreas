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

import { EventListRow } from '@/components/EventListRow';
import type { ApiArtistEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  dowMixed,
  eventPosterUrl,
  formatTime,
  monthShort,
  VENUE_TYPE_TICK,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { useArtist } from '@/lib/queries';
import type { BadgeTone } from '@/lib/types';
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
          // Geen AppHeader meer (was te zwaar voor deze pagina). Wel
          // safe-area + ruimte voor de floating back-button.
          paddingTop: insets.top + 56,
          paddingBottom: insets.bottom + 24,
        }}
      >
        {isLoading && (
          <Text style={[styles.dim, { color: roles.fgMuted, paddingHorizontal: 22 }]}>
            {t('Laden…', 'Loading…')}
          </Text>
        )}
        {error && (
          <Text style={[styles.dim, { color: roles.fgMuted, paddingHorizontal: 22 }]}>
            {t('Kon artist niet laden.', 'Couldn’t load artist.')}
          </Text>
        )}
        {data && (
          <>
            <View style={styles.intro}>
              <Text style={[styles.name, { color: roles.fg }]}>
                {data.artist.name}
              </Text>

              {/* Description (MB "disambiguation"-veld zoals "soprano",
                  "Dutch DJ") + genres samen in één chip-row. De
                  description is typisch heel kort (1-3 woorden) — past
                  goed als chip naast de genre-chips. Lange beschrijvingen
                  (zeldzaam in MB) blijven onder als paragraph. */}
              {(data.artist.description || data.artist.genres.length > 0) && (
                <View style={styles.genreRow}>
                  {data.artist.description &&
                    data.artist.description.length <= 40 && (
                      <View
                        style={[styles.genreChip, { backgroundColor: `${roles.accent}26` }]}
                      >
                        <Text style={[styles.genreText, { color: roles.accent }]}>
                          {data.artist.description.toLowerCase()}
                        </Text>
                      </View>
                    )}
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

              {data.artist.description && data.artist.description.length > 40 && (
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
            </View>

            {data.events.length > 0 && (
              <>
                {/* Section-header in zelfde stijl als Agenda's
                    CategoryHeader: display-font 18pt in accent-kleur,
                    horizontal padding 22. */}
                <View style={styles.sectionHead}>
                  <Text style={[styles.sectionLabel, { color: roles.accent }]}>
                    {t('Komende voorstellingen', 'Upcoming shows')}
                  </Text>
                  <Text style={[styles.sectionCount, { color: roles.fgPlaceholder }]}>
                    {data.events.length}
                  </Text>
                </View>
                {data.events.map((ev) => {
                  const venueTone: BadgeTone | undefined = ev.venue.type
                    ? VENUE_TYPE_TICK[ev.venue.type]
                    : undefined;
                  const poster = eventPosterUrl({
                    imageUrl: ev.imageUrl,
                    posterUrl: ev.posterUrl,
                    venue: { imageUrl: null },
                  });
                  // Datum bovenaan, tijd in de subline. Jaar alleen
                  // erbij als 't event in een ander jaar valt — anders
                  // ruis.
                  const d = new Date(ev.nextOccurrence.startsAt);
                  const dow = dowMixed(d.getDay(), locale);
                  const num = String(d.getDate()).padStart(2, '0');
                  const month = monthShort(d.getMonth(), locale).toLowerCase();
                  const currentYear = new Date().getFullYear();
                  const yearSuffix =
                    d.getFullYear() !== currentYear ? ` ${d.getFullYear()}` : '';
                  return (
                    <EventListRow
                      key={ev.id}
                      time={formatTime(ev.nextOccurrence.startsAt)}
                      duration={`${dow} ${num} ${month}${yearSuffix}`}
                      thumb={poster ?? ''}
                      thumbSize={96}
                      title={ev.title}
                      venue={ev.venue.name}
                      venueTone={venueTone}
                      tick={CATEGORY_TICK[ev.category]}
                      dateAbove
                      onPress={() => router.push(`/event/${ev.id}` as never)}
                    />
                  );
                })}
              </>
            )}
          </>
        )}
      </ScrollView>

      {/* Floating back-button linksboven — geen header-strook ervoor.
          De artist-naam fungeert zelf als titel onder in de body. */}
      <View
        style={[
          styles.backButtonWrap,
          { top: insets.top + 8 },
        ]}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={[
            styles.backBtn,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        >
          <Ionicons name="chevron-back" size={20} color={roles.fg} />
        </Pressable>
      </View>
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
      <Ionicons name="chevron-forward" size={16} color={roles.fg} />
    </Pressable>
  );
}


const styles = StyleSheet.create({
  root: { flex: 1 },
  dim: { fontFamily: fontFamily.mono, fontSize: 12, letterSpacing: 0.8 },
  // Intro-blok (naam + genres + description + links): paddingHorizontal
  // 22 zelfde als Agenda's body. Sectie eronder (EventListRow's) heeft
  // z'n eigen interne 22 padding, dus we stoppen 'm hier zodat de
  // section-header netjes uitlijnt met de rij-content eronder.
  intro: { paddingHorizontal: 22, marginBottom: 18 },
  name: {
    // Black weight (Archivo 900) — zelfde gewicht als Agenda's
    // category-headers maar groter omdat dit het primaire scherm-
    // onderwerp is.
    fontFamily: fontFamily.display,
    fontSize: 28,
    lineHeight: 30,
    letterSpacing: -0.84,
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
  // Zelfde stijl als Agenda's CategoryHeader: display-font 18pt,
  // accent-kleur, paddingHorizontal 22, paddingTop 12, paddingBottom 6.
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 6,
    gap: 10,
  },
  sectionLabel: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
  },
  sectionCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  // Floating back-button — absolute positioning bovenaan links, geen
  // header-strook. Top wordt run-time gezet op insets.top + 8.
  backButtonWrap: {
    position: 'absolute',
    left: 14,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
