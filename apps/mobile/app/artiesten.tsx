import { FontAwesome, Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccountWall } from '@/components/AccountWall';
import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { SearchOverlay } from '@/components/SearchOverlay';
import { SpinningCross } from '@/components/SpinningCross';
import { useIsRegistered } from '@/lib/authClient';
import { softTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import {
  queryKeys,
  useFollowedArtists,
  useToggleArtistFollow,
} from '@/lib/queries';
import { disconnectSpotify, getSpotifyStatus, startSpotifyImport } from '@/lib/api';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/**
 * Artiesten die je volgt, en wat daarvan eraan komt.
 *
 * In deze volgorde, met opzet. Een kale namenlijst open je één keer; de
 * reden om terug te komen is "wat staat er aan te komen van wie ik leuk
 * vind". Daarom bovenaan de avonden en pas daaronder wie je volgt.
 *
 * Het geeft de melding ook een thuis: krijg je bericht en tik je erop,
 * dan land je op het event, maar wil je het overzicht, dan is dit de
 * plek.
 */
export default function ArtiestenScreen() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const authed = useIsRegistered();
  const { data: artists, isLoading: loadingArtists } = useFollowedArtists({
    enabled: authed,
  });
  const toggle = useToggleArtistFollow();

  // De zoek hangt normaal aan de tabs, en dit scherm staat daarbuiten.
  // Vandaar een eigen exemplaar: zonder zoek is de lege staat een
  // opdracht zonder knop -- "zoek een artiest" en dan nergens heen.
  const [searchOpen, setSearchOpen] = useState(false);

  const headerButtons = (
    <View style={styles.headerRow}>
      <Pressable
        onPress={() => {
          softTap();
          setSearchOpen(true);
        }}
        hitSlop={8}
        style={styles.closeBtn}
        accessibilityLabel={t('Zoek een artiest', 'Search for an artist')}
      >
        <Ionicons name="search" size={19} color={roles.fg} />
      </Pressable>
      <Pressable onPress={() => router.back()} hitSlop={8} style={styles.closeBtn}>
        <Ionicons name="close" size={20} color={roles.fg} />
      </Pressable>
    </View>
  );
  const nArtists = (artists ?? []).length;
  const header = (
    <AppHeader
      title={t('Artiesten', 'Artists')}
      hideAvatar
      rightSlot={headerButtons}
    />
  );

  if (!authed) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        <View style={{ flex: 1, paddingTop: insets.top + HEADER_HEIGHT }}>
          <AccountWall
            icon="musical-notes-outline"
            title={t('Artiesten volgen', 'Following artists')}
            body={t(
              'Met een account onthouden we wie je volgt, en krijg je bericht zodra er een avond bij komt.',
              'With an account we remember who you follow, and you hear from us when a new night comes in.',
            )}
          />
        </View>
        {header}
      </View>
    );
  }

  const loading = loadingArtists;
  const nothing = !loading && (artists ?? []).length === 0;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          // Zelfde rekensom als op de agenda: de chip-rij zit vast in
          // de header, dus de content begint eronder. Daar staat alleen
          // nog een dag-kop tussen die de lucht geeft; die hebben wij
          // niet meer sinds de koppen chips werden, dus tellen we z'n
          // bovenmarge er hier bij op.
          paddingTop: insets.top + HEADER_HEIGHT + 8,
          paddingBottom: insets.bottom + 96,
        }}
      >
        {loading ? (
          <View style={styles.center}>
            <SpinningCross size={24} color={roles.fgMuted} />
          </View>
        ) : null}

        {nothing ? (
          <View style={styles.emptyWrap}>
            <Text style={[styles.empty, { color: roles.fgMuted }]}>
              {t(
                'Je volgt nog niemand. Zodra je iemand volgt hoor je het als er een avond bij komt.',
                'You are not following anyone yet. Once you follow someone, you hear from us when a new night comes in.',
              )}
            </Text>
            <Pressable
              onPress={() => {
                softTap();
                setSearchOpen(true);
              }}
              style={[styles.emptyBtn, { backgroundColor: roles.accent }]}
            >
              <Ionicons name="search" size={17} color={roles.onAccent} />
              <Text style={[styles.emptyBtnText, { color: roles.onAccent }]}>
                {t('Zoek een artiest', 'Search for an artist')}
              </Text>
            </Pressable>
            <SpotifyImport />
          </View>
        ) : null}

        {nArtists > 0 ? (
          <>
            {/* Bovenaan: koppelen is een actie op de hele lijst. */}
            <SpotifyImport />
            {(artists ?? []).map((artist) => (
              <Pressable
                key={artist.id}
                onPress={() => {
                  softTap();
                  router.push(`/artist/${artist.id}` as never);
                }}
                style={styles.artistRow}
              >
                <ProfileAvatar
                  avatarUrl={artist.imageUrl}
                  name={artist.name}
                  size={44}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.artistNameRow}>
                    <Text
                      numberOfLines={1}
                      style={[styles.artistName, { color: roles.fg, flexShrink: 1 }]}
                    >
                      {artist.name}
                    </Text>
                    {/* Via Spotify binnengekomen: ontvolgen mag, maar dan
                        zie je dat het een keuze is tegen je Spotify in. */}
                    {artist.source === 'spotify' ? (
                      <FontAwesome
                        name="spotify"
                        size={14}
                        // Spotify wil z'n logo in groen, wit of zwart: de tekstkleur.
                        color={roles.fg}
                        accessibilityLabel={t('Via Spotify', 'Via Spotify')}
                      />
                    ) : null}
                  </View>
                  {artist.genres.length > 0 ? (
                    <Text
                      numberOfLines={1}
                      style={[styles.artistSub, { color: roles.fgMuted }]}
                    >
                      {artist.genres.slice(0, 2).join(' · ')}
                    </Text>
                  ) : null}
                </View>
                {/* Een woord in plaats van een kruisje. Een kruisje kan
                    net zo goed "verberg deze rij" betekenen, en bij iets
                    dat je zelf hebt aangezet wil je zeker weten wat je
                    uitzet. Zacht van kleur, want het is niet waar je
                    voor kwam. */}
                <Pressable
                  onPress={() => {
                    softTap();
                    toggle.mutate({ artistId: artist.id, following: false });
                  }}
                  hitSlop={8}
                  style={[styles.unfollow, { backgroundColor: roles.bgChip }]}
                >
                  <Text
                    style={[styles.unfollowText, { color: roles.fgMuted }]}
                  >
                    {t('Ontvolgen', 'Unfollow')}
                  </Text>
                </Pressable>
              </Pressable>
            ))}
          </>
        ) : null}
      </ScrollView>

      {header}

      <SearchOverlay
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
    </View>
  );
}


/**
 * Spotify koppelen: wie je daar volgt en het meest luistert, volg je hier
 * ook, en elke nacht komen er nieuwe bij.
 *
 * Niet gekoppeld: een knop. De inlog loopt in een browservenster bij
 * Spotify; onze server volgt de artiesten en bewaart de koppeling.
 * Gekoppeld: wat er gebeurt en wanneer het laatst bijgewerkt is, en
 * ontkoppelen. Zolang de Spotify-app in development mode staat, kan alleen
 * wie is toegevoegd koppelen.
 */
// ponytail: schakelaar voor de Spotify-knop. Aan sinds 27 sep 2026 (redirect-
// URI en testgebruikers staan in het dashboard). Werkt het, dan mag hij weg.
const SPOTIFY_READY = true;

function SpotifyImport() {
  const roles = useRoles();
  const t = useT();
  const qc = useQueryClient();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const status = useQuery({ queryKey: ['spotify-status'], queryFn: getSpotifyStatus });

  const run = async () => {
    softTap();
    setBusy(true);
    setMessage(null);
    try {
      const { url, returnUrl } = await startSpotifyImport();
      const res = await WebBrowser.openAuthSessionAsync(url, returnUrl);
      if (res.type !== 'success') return;
      const param = (k: string) => res.url.match(new RegExp(`[?&]${k}=([^&]*)`))?.[1];
      const added = param('added');
      const error = param('error');
      if (added !== undefined) {
        await qc.invalidateQueries({ queryKey: queryKeys.followedArtists() });
        await qc.invalidateQueries({ queryKey: ['spotify-status'] });
        setMessage(
          Number(added) > 0
            ? t(`${added} artiesten uit Spotify gevolgd.`, `Followed ${added} artists from Spotify.`)
            : t('Geen artiesten gevonden op je Spotify.', 'No artists found on your Spotify.'),
        );
      } else if (error === 'geen-toegang') {
        setMessage(
          t(
            'Spotify koppelen is nog in een testfase: je account moet eerst worden toegevoegd. Vraag het ons via de app.',
            'Connecting Spotify is still in a test phase: your account needs to be added first. Ask us through the app.',
          ),
        );
      } else if (error !== 'geweigerd') {
        setMessage(t('Dat lukte niet. Probeer het nog eens.', 'That did not work. Please try again.'));
      }
    } catch {
      setMessage(t('Dat lukte niet. Probeer het nog eens.', 'That did not work. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (!SPOTIFY_READY || status.isLoading) return null;

  if (status.data?.connected) {
    const d = status.data;
    const when = d.lastSyncAt
      ? new Date(d.lastSyncAt).toLocaleDateString(locale === 'en' ? 'en-GB' : 'nl-NL', { day: 'numeric', month: 'long' })
      : null;
    return (
      <View style={styles.spotify}>
        <View style={styles.spotifyLinked}>
          <Ionicons name="checkmark-circle" size={18} color={roles.fg} />
          <Text style={[styles.spotifyText, { color: roles.fg }]}>{t('Gekoppeld met Spotify', 'Connected to Spotify')}</Text>
        </View>
        <Text style={[styles.note, { color: roles.fgMuted, textAlign: 'center' }]}>
          {t(
            `Wie je op Spotify gaat volgen, volg je hier de volgende dag ook.${when ? ` Laatst bijgewerkt ${when}${d.lastAdded ? `, ${d.lastAdded} nieuw` : ''}.` : ''}`,
            `Artists you follow on Spotify are followed here the next day too.${when ? ` Last updated ${when}${d.lastAdded ? `, ${d.lastAdded} new` : ''}.` : ''}`,
          )}
        </Text>
        {message ? <Text style={[styles.note, { color: roles.fgMuted, textAlign: 'center' }]}>{message}</Text> : null}
        <Pressable
          onPress={async () => {
            softTap();
            await disconnectSpotify();
            await qc.invalidateQueries({ queryKey: ['spotify-status'] });
          }}
          hitSlop={8}
        >
          <Text style={[styles.spotifyUnlink, { color: roles.fgMuted }]}>{t('Ontkoppelen', 'Disconnect')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.spotify}>
      <Pressable
        onPress={run}
        disabled={busy}
        style={[styles.spotifyBtn, { backgroundColor: roles.bgChip }]}
      >
        {busy ? (
          <SpinningCross size={16} color={roles.fgMuted} />
        ) : (
          <Ionicons name="musical-notes-outline" size={17} color={roles.fg} />
        )}
        <Text style={[styles.spotifyText, { color: roles.fg }]}>
          {t('Volg wie je op Spotify volgt', 'Follow who you follow on Spotify')}
        </Text>
      </Pressable>
      {message ? <Text style={[styles.note, { color: roles.fgMuted }]}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  spotify: { paddingHorizontal: 22, paddingTop: 4, paddingBottom: 16, gap: 6, alignSelf: 'stretch' },
  // Zelfde maat als de andere secundaire knoppen (Bewerken/Verwijderen bij
  // een melding): vol breed, hoek 8, 13 hoog.
  spotifyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 8,
  },
  spotifyText: { fontFamily: fontFamily.bold, fontSize: 15 },
  artistNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  spotifyLinked: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  spotifyUnlink: { fontFamily: fontFamily.medium, fontSize: 13, textAlign: 'center', textDecorationLine: 'underline' },
  root: { flex: 1 },
  // Vult de vaste rijhoogte in de header, net als op /nieuw -- zo staan
  // de chips verticaal gecentreerd zonder losse paddings.
  center: { paddingTop: 60, alignItems: 'center' },
  sectionTitle: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.4,
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 6,
  },
  artistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  artistName: { fontFamily: fontFamily.bold, fontSize: 15.5, letterSpacing: -0.2 },
  artistSub: { fontFamily: fontFamily.body, fontSize: 12.5 },
  // Zelfde pil als "Gevolgd" in de zoekresultaten, zodat dezelfde stand
  // er overal hetzelfde uitziet.
  unfollow: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  unfollowText: { fontFamily: fontFamily.bold, fontSize: 13 },
  note: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 22,
    paddingBottom: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  emptyWrap: { paddingTop: 60, gap: 20 },
  empty: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 32,
    textAlign: 'center',
  },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 8,
  },
  emptyBtnText: { fontFamily: fontFamily.bold, fontSize: 15 },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
