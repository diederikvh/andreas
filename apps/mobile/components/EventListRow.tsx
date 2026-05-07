import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useLocale, type Locale } from '@/lib/i18n';
import type { BadgeTone } from '@/mocks/feed';
import type { Friend } from '@/mocks/gered';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const TONE = {
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

export type EventTag = { label: string; tone: BadgeTone };

type Props = {
  /** Optional — feed rows don't have a prominent time column. */
  time?: string;
  /** Small subline under the time, e.g. "2u" / "deuren". */
  duration?: string;
  thumb: string;
  title: string;
  venue: string;
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
  onPress?: () => void;
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
  tags,
  status,
  seriesLabel,
  genreLabel,
  friends,
  featured = false,
  tick,
  onPress,
}: Props) {
  const mode = useMode();
  const roles = useRoles();
  const tickColor = TONE[mode][tick];

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View style={[styles.row, { borderColor: roles.bgChip }]}>
        <Image
          source={{ uri: thumb }}
          style={styles.rowThumb}
          contentFit="cover"
        />
        <View style={styles.rowBody}>
          <Text
            numberOfLines={2}
            style={[styles.rowTitle, { color: roles.fg }]}
          >
            {title}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.rowVenue, { color: roles.fgMuted }]}
          >
            {[time, duration, venue].filter(Boolean).join(' · ')}
          </Text>
          {(featured || tags?.length || status || seriesLabel || genreLabel || friends?.length) && (
            <View style={styles.rowTags}>
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

function friendsLabel(names: string[], locale: Locale): string {
  const tail = locale === 'nl' ? 'ook' : 'too';
  if (names.length === 1) return `${names[0]} ${tail}`;
  if (names.length === 2) return `${names[0]} & ${names[1]} ${tail}`;
  return `${names[0]} +${names.length - 1} ${tail}`;
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
