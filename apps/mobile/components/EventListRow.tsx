import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useLocale, type Locale } from '@/lib/i18n';
import type { BadgeTone, Friend } from '@/lib/types';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';
import { TONE } from '@/theme/tones';


export type EventTag = { label: string; tone: BadgeTone };

type Props = {
  /** Optional — feed rows don't have a prominent time column. */
  time?: string;
  /** Small subline under the time, e.g. "2u" / "deuren". */
  duration?: string;
  thumb: string;
  title: string;
  venue: string;
  /** Optional — when set, render the venue as the first pill in the
      tag-row (in venue-type tone). The venue is then dropped from the
      mono-uppercase subline so it doesn't appear twice. */
  venueTone?: BadgeTone;
  /** Optional — when set, the venue pill becomes tappable. Used by
      Vandaag/Agenda om de venue-type filter te toggelen vanuit de rij
      zelf (zonder eerst de filter-sheet te openen). */
  onVenuePress?: () => void;
  tags?: EventTag[];
  /** Optional outline tag, e.g. "Uitverkocht" / "nog 3". */
  status?: string;
  /** Naam van een serie waar dit event onderdeel van is (bv. "ADE 2026").
      Niet-tappable in de rij — render als subtiele monospace-tag voor
      ontdekking; de doorklik gaat via event-detail. */
  seriesLabel?: string;
  /** Eerste genre van het event (bv. "techno"). Zelfde stijl als
      seriesLabel — neutrale `bgTag` mono uppercase. */
  genreLabel?: string;
  friends?: Friend[];
  /** Markeert dit event als de "lead" van z'n sublijst — toont een
      kleine ster vóór de titel. Gebruikt op Vandaag waar elke
      categorie-sublijst z'n eigen uitlicht-event krijgt. */
  featured?: boolean;
  /** Side accent stripe colour. */
  tick: BadgeTone;
  /** Optional: override thumb size (default 76). Agenda gebruikt 96 om
      het beeld meer ruimte te geven naast de tekst-zware rij. */
  thumbSize?: number;
  /** Wanneer aan: tijd + datum verschijnen als kleine bold-regel
      bóven de titel, in een iets lichtere kleur dan de titel.
      Vervangt de mono-uppercase subline boven de tags. Gebruikt op de
      venue-pagina waar volgorde datum → titel → labels gewenst is. */
  dateAbove?: boolean;
  /** Optioneel: dag-deel boven de titel (bv. "Fr 29 may"). Wordt
      gecombineerd met `time` als de regel boven de titel: "Fr 29 may
      · 20:00". Zonder deze prop blijft de oude `[time, duration]`-
      compositie gelden. De rechter rotated-tick gebruikt 'm nooit —
      die bevat alleen `time` zodat 'ie smal en leesbaar blijft. */
  dateLabel?: string;
  onPress?: () => void;
  /** Optionele knoppen rechts in de rij, vóór de accent-tick. Gebruikt
      door /new voor de ja/nee-beoordeling. Vervangt de tijd-kolom —
      die twee vechten anders om dezelfde ruimte. */
  actions?: ReactNode;
};

/**
 * Shared row for the Agenda and Gered screens. Layout: time | thumb |
 * title/venue/tags/friends | accent tick. Only renders sections that
 * have data, so the same component handles "agenda with tags" and
 * "gered with a friends-pill".
 */
export function EventListRow({
  time,
  duration,
  thumb,
  title,
  venue,
  venueTone,
  onVenuePress,
  tags,
  status,
  seriesLabel,
  genreLabel,
  friends,
  featured = false,
  tick,
  thumbSize,
  dateAbove = false,
  dateLabel,
  onPress,
  actions,
}: Props) {
  const mode = useMode();
  const roles = useRoles();
  const tickColor = TONE[mode][tick];
  const venueAsPill = venueTone !== undefined;
  // Wanneer venueAsPill aanstaat (Vandaag/Agenda) gaat de tijd naar
  // een eigen kolom rechts; subline wordt dan compact (alleen
  // duration als die meekomt). Anders: oude subline-layout.
  const showTimeRight = venueAsPill && Boolean(time) && !actions;
  const dateAboveText = dateAbove
    ? [dateLabel, time, duration].filter(Boolean).join(' · ')
    : '';
  // Subline-content hangt af van de combinatie van dateAbove en
  // venueAsPill. Belangrijk: wanneer venueAsPill aanstaat staat venue
  // al als gekleurde pill in de tag-row — dan moeten we 'm niet
  // dubbel in de subline tonen (was een bug op de artist-page).
  const subline = dateAbove
    ? venueAsPill
      ? ''
      : [venue].filter(Boolean).join(' · ')
    : venueAsPill
      ? [duration].filter(Boolean).join(' · ')
      : [time, duration, venue].filter(Boolean).join(' · ');
  const venuePillColor = venueAsPill ? TONE[mode][venueTone] : null;
  const hasTagsRow =
    venueAsPill ||
    featured ||
    Boolean(tags?.length) ||
    Boolean(status) ||
    Boolean(seriesLabel) ||
    Boolean(genreLabel) ||
    Boolean(friends?.length);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View style={[styles.row, { borderColor: roles.bgChip }]}>
        <Image
          source={{ uri: thumb }}
          style={[
            styles.rowThumb,
            thumbSize ? { width: thumbSize, height: thumbSize } : null,
          ]}
          contentFit="cover"
        />
        <View style={styles.rowBody}>
          {dateAbove && dateAboveText.length > 0 && (
            <Text
              numberOfLines={1}
              style={[styles.rowDateAbove, { color: roles.fgMuted }]}
            >
              {dateAboveText}
            </Text>
          )}
          <Text
            numberOfLines={2}
            style={[styles.rowTitle, { color: roles.fg }]}
          >
            {title}
          </Text>
          {subline.length > 0 && (
            <Text
              numberOfLines={1}
              style={[styles.rowVenue, { color: roles.fgMuted }]}
            >
              {subline}
            </Text>
          )}
          {hasTagsRow && (
            <View style={styles.rowTags}>
              {venueAsPill && venuePillColor && (
                <Pressable
                  onPress={onVenuePress}
                  disabled={!onVenuePress}
                  hitSlop={4}
                  style={[
                    styles.tag,
                    { backgroundColor: `${venuePillColor}26` },
                  ]}
                >
                  <Text
                    style={[
                      styles.tagText,
                      { color: toneForLabelText(venuePillColor, mode) },
                    ]}
                    numberOfLines={1}
                  >
                    {venue}
                  </Text>
                </Pressable>
              )}
              {featured && (
                <View
                  style={[
                    styles.tag,
                    { backgroundColor: `${tickColor}26` },
                  ]}
                >
                  <Ionicons
                    name="star"
                    size={10}
                    color={toneForLabelText(tickColor, mode)}
                  />
                </View>
              )}
              {tags?.map((tag) => {
                const tone = TONE[mode][tag.tone];
                const bg = `${tone}26`; // ~15% alpha
                const textColor = toneForLabelText(tone, mode);
                return (
                  <View
                    key={tag.label}
                    style={[styles.tag, { backgroundColor: bg }]}
                  >
                    <Text style={[styles.tagText, { color: textColor }]}>
                      {tag.label}
                    </Text>
                  </View>
                );
              })}
              {status && (
                <View
                  style={[styles.tagOutline, { borderColor: roles.fgMuted }]}
                >
                  <Text style={[styles.tagText, { color: roles.fgMuted }]}>
                    {status}
                  </Text>
                </View>
              )}
              {seriesLabel && (
                <View
                  style={[
                    styles.seriesTag,
                    { backgroundColor: roles.bgTag },
                  ]}
                >
                  <Text style={[styles.seriesTagText, { color: roles.fg }]}>
                    {seriesLabel}
                  </Text>
                </View>
              )}
              {genreLabel && (
                <View
                  style={[
                    styles.seriesTag,
                    { backgroundColor: roles.bgTag },
                  ]}
                >
                  <Text style={[styles.seriesTagText, { color: roles.fg }]}>
                    {genreLabel}
                  </Text>
                </View>
              )}
              {friends && friends.length > 0 && (
                <FriendsPill friends={friends} accent={tickColor} />
              )}
            </View>
          )}
        </View>
        {actions}
        {showTimeRight && (
          <View style={styles.rowTimeCol}>
            <View style={styles.rowTimeRotate}>
              <Text
                numberOfLines={1}
                style={[styles.rowTimeText, { color: roles.fg }]}
              >
                {time}
              </Text>
            </View>
          </View>
        )}
        <View style={[styles.tick, { backgroundColor: tickColor }]} />
      </View>
    </Pressable>
  );
}

// Mengt een hex-kleur met wit voor extra leesbaarheid op donkere bg.
// `amount` = 0 (origineel) tot 1 (puur wit).
function lightenHex(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const blend = (c: number) =>
    Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `#${blend(r)}${blend(g)}${blend(b)}`;
}

/** Tone-kleur voor leesbare tekst-op-getinte-bg labels. Nacht-mode
 *  krijgt een subtiele lift; dag-mode blijft de donkere variant. */
function toneForLabelText(hex: string, mode: 'nacht' | 'dag'): string {
  return mode === 'nacht' ? lightenHex(hex, 0.35) : hex;
}

function FriendsPill({
  friends,
  accent,
}: {
  friends: Friend[];
  accent: string;
}) {
  const roles = useRoles();
  const mode = useMode();
  const locale = useLocale();
  const bg = `${accent}1f`; // ~12% alpha
  const textColor = toneForLabelText(accent, mode);
  return (
    <View style={[styles.friendsPill, { backgroundColor: bg }]}>
      <View style={styles.avstack}>
        {friends.map((f, i) =>
          f.avatar ? (
            <Image
              key={`${f.name}-${i}`}
              source={{ uri: f.avatar }}
              style={[
                styles.avatar,
                { marginLeft: i === 0 ? 0 : -6, borderColor: roles.bg },
              ]}
            />
          ) : (
            <View
              key={`${f.name}-${i}`}
              style={[
                styles.avatar,
                styles.avatarFallback,
                {
                  marginLeft: i === 0 ? 0 : -6,
                  borderColor: roles.bg,
                  backgroundColor:
                    mode === 'nacht' ? palette.noir2 : palette.paper2,
                },
              ]}
            >
              <Text style={[styles.avatarInitial, { color: accent }]}>
                {(f.name.trim()[0] ?? '?').toUpperCase()}
              </Text>
            </View>
          )
        )}
      </View>
      <Text style={[styles.friendsText, { color: textColor }]}>
        {friendsLabel(friends.map((f) => f.name), locale)}
      </Text>
    </View>
  );
}

function friendsLabel(names: string[], _locale: Locale): string {
  // "ook"/"too"-suffix bewust weggelaten — een save is geen
  // belofte-om-te-gaan, alleen een interesse-signaal. Een naam alleen
  // communiceert dat al ("Diederik" → Diederik vindt dit relevant).
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} +${names.length - 1}`;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowThumb: {
    width: 76,
    height: 76,
    borderRadius: 10,
  },
  rowBody: { flex: 1, minWidth: 0, gap: 4 },
  rowTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
    lineHeight: 18,
  },
  rowVenue: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  // Datum/tijd boven de titel — normaal bold font, geen mono, geen
  // uppercase, in een iets gedempte kleur (`fgMuted`) zodat de titel
  // visueel dominant blijft. Gebruikt op de venue-pagina
  // (`dateAbove`) waar volgorde datum → titel → labels gewenst is.
  rowDateAbove: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    letterSpacing: -0.1,
    marginBottom: 2,
  },
  // Rechter tijd-kolom — vertikaal gecentreerd, smal. De tekst zit in
  // een wrapper-View die -90° wordt gedraaid (transforms direct op
  // <Text/> worden in RN niet altijd toegepast). De wrapper shrinkt
  // naar de natuurlijke tekstbreedte (~50px) en is na rotatie visueel
  // 16×50 — past in de 22px-kolom dankzij de royale row-hoogte van
  // de thumb. Alleen actief in de Vandaag/Agenda-layout (venueAsPill).
  rowTimeCol: {
    width: 18,
    alignSelf: 'stretch',
    justifyContent: 'center',
    alignItems: 'center',
    // Trekt de tijd-kolom dichter naar de tick-strook toe — overrulet
    // de row-gap van 12. Effectieve afstand tijd → tick ~4px.
    marginRight: -8,
  },
  rowTimeRotate: {
    // Expliciete breedte zodat de Text z'n natuurlijke breedte kan
    // krijgen ipv te wrappen onder de 22px van de kolom. Royaal genoeg
    // voor "20:00" en "Hele dag" / "All day". RotateView overlapt de
    // kolom-grenzen en wordt na rotatie visueel ~16×60 (verticaal
    // gecentreerd in de row).
    width: 60,
    alignItems: 'center',
    transform: [{ rotate: '-90deg' }],
  },
  rowTimeText: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.2,
  },
  rowTags: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  tag: {
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagOutline: {
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seriesTag: {
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seriesTagText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  tagText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  tick: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 2,
    marginVertical: 6,
  },

  // Friends pill
  friendsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 24,
    paddingLeft: 3,
    paddingRight: 10,
    borderRadius: 999,
  },
  avstack: { flexDirection: 'row' },
  avatar: {
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 9,
    letterSpacing: 0,
  },
  friendsText: {
    fontFamily: fontFamily.medium,
    fontSize: 11,
  },
});
