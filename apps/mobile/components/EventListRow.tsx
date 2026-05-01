import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

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
  friends?: Friend[];
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
  friends,
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
          {(tags?.length || status || friends?.length) && (
            <View style={styles.rowTags}>
              {tags?.map((tag) => {
                const tone = TONE[mode][tag.tone];
                const bg = `${tone}26`; // ~15% alpha
                return (
                  <View
                    key={tag.label}
                    style={[styles.tag, { backgroundColor: bg }]}
                  >
                    <Text style={[styles.tagText, { color: tone }]}>
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

function FriendsPill({
  friends,
  accent,
}: {
  friends: Friend[];
  accent: string;
}) {
  const roles = useRoles();
  const bg = `${accent}1f`; // ~12% alpha
  return (
    <View style={[styles.friendsPill, { backgroundColor: bg }]}>
      <View style={styles.avstack}>
        {friends.map((f, i) => (
          <Image
            key={f.name}
            source={{ uri: f.avatar }}
            style={[
              styles.avatar,
              { marginLeft: i === 0 ? 0 : -6, borderColor: roles.bg },
            ]}
          />
        ))}
      </View>
      <Text style={[styles.friendsText, { color: accent }]}>
        {friendsLabel(friends.map((f) => f.name))}
      </Text>
    </View>
  );
}

function friendsLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} ook`;
  if (names.length === 2) return `${names[0]} & ${names[1]} ook`;
  return `${names[0]} +${names.length - 1} ook`;
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
  friendsText: {
    fontFamily: fontFamily.medium,
    fontSize: 11,
  },
});
