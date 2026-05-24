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
import { useMemo } from 'react';
import {
  Linking,
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
                <StreamingRail tiles={links} />
              )}

              {fallback.length > 0 && (
                <View style={{ marginTop: 14, gap: 8 }}>
                  <Text
                    style={[
                      styles.fallbackHint,
                      { color: roles.fgMuted, marginBottom: 4 },
                    ]}
                  >
                    {t(
                      'Nog geen directe links — probeer een zoekopdracht:',
                      'No direct links yet — try a search:'
                    )}
                  </Text>
                  {fallback.map((l) => (
                    <FallbackButton
                      key={l.key}
                      label={l.label}
                      url={l.url}
                      icon={l.icon}
                    />
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

/**
 * Horizontaal-scrollende rail met streaming-tiles. Edge-to-edge: breekt
 * uit de 22px parent-padding via marginHorizontal: -22 en pakt de
 * padding zelf op in contentContainerStyle, zodat de eerste tile netjes
 * uitlijnt met de tekst eromheen.
 */
function StreamingRail({
  tiles,
}: {
  tiles: Array<{
    key: string;
    label: string;
    url: string;
    icon: keyof typeof Ionicons.glyphMap;
  }>;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.streamingRail}
      contentContainerStyle={styles.streamingRailContent}
    >
      {tiles.map((l) => (
        <StreamingTile key={l.key} label={l.label} url={l.url} icon={l.icon} />
      ))}
    </ScrollView>
  );
}

/**
 * Tile in dezelfde stijl als de Vandaag-shortcut-banners (Films / Live
 * / Clubs / Theater): één bgLift-container met icoon links-uitgelijnd
 * bovenaan en label eronder, fixed-width 155px zodat ~2 zichtbaar zijn
 * en de derde peekt — uitnodiging om te swipen.
 *
 * Open URL met `Linking.openURL` — iOS pikt https://open.spotify.com /
 * music.apple.com / youtube.com automatisch op via Universal Links als
 * de bijbehorende app geïnstalleerd is, anders Safari. Dat is wat we
 * willen: native app als 't kan, browser als laatste redmiddel.
 */
function StreamingTile({
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
      onPress={() => {
        Linking.openURL(url).catch(() => {});
      }}
      style={[styles.tile, { backgroundColor: roles.bgLift }]}
    >
      <Ionicons name={icon} size={28} color={roles.accent} />
      <Text
        numberOfLines={2}
        style={[styles.tileLabel, { color: roles.fg }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Volle-breedte fallback-button. Verschijnt alleen als er geen
 * specifieke streaming-URLs bekend zijn — een "Zoek op Spotify"-actie
 * heeft meer uitleg nodig dan een tile aan kan, en is bovendien een
 * minder zelfverzekerde call-to-action dan een directe link.
 */
function FallbackButton({
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
      onPress={() => {
        Linking.openURL(url).catch(() => {});
      }}
      style={[styles.fallbackBtn, { backgroundColor: roles.bgLift }]}
    >
      <Ionicons name={icon} size={20} color={roles.accent} />
      <Text style={[styles.fallbackLabel, { color: roles.fg }]}>{label}</Text>
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
  // Horizontaal-scrollende tile-rail. Edge-to-edge: -22 marge canceleert
  // de parent (intro) 22 padding, contentContainerStyle herstelt 'm zodat
  // de eerste tile uitlijnt met de tekst eromheen.
  streamingRail: { marginTop: 4, marginHorizontal: -22 },
  streamingRailContent: { paddingHorizontal: 22, gap: 10 },
  // Vierkante tiles, 108×108, zodat 3 zichtbaar zijn op een 393px
  // viewport en de 4e net peekt (393 - 44 padding - 2×10 gap = 329 / 3
  // ≈ 109). Zelfde maat-formule als VenueSquareRailCard. Icoon
  // links-uitgelijnd bovenaan + label eronder, beide binnen één
  // bgLift-container.
  tile: {
    width: 108,
    aspectRatio: 1,
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 14,
  },
  tileLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    lineHeight: 16,
    letterSpacing: -0.14,
  },
  // Volle-breedte fallback-button — krijgt meer ruimte voor uitleg
  // ("Zoek op Spotify") dan een tile aan kan, en heeft tegelijk minder
  // visuele lading dan een tile-rail (deze is een laatste redmiddel).
  fallbackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    gap: 12,
  },
  fallbackLabel: {
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
