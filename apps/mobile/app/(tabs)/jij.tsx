import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';

import { Cross } from '@/components/Cross';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import {
  JIJ_FRIENDS,
  JIJ_PROFILE,
  JIJ_REQUESTS,
  type JijFriend,
  type JijRequest,
} from '@/mocks/jij';
import { useMode, useModeStore, useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

export default function Jij() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  const resetOnboarding = async () => {
    await useModeStore.persist.clearStorage();
    useModeStore.setState({ mode: 'nacht', hasOnboarded: false });
    router.replace('/');
  };

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
        {/* Profile head */}
        <View style={styles.head}>
          <View style={[styles.avatarWrap, { borderColor: roles.bgChip }]}>
            <Image
              source={{ uri: JIJ_PROFILE.avatar }}
              style={styles.avatar}
              contentFit="cover"
            />
          </View>
          <View style={styles.headText}>
            <Text style={[styles.name, { color: roles.fg }]}>
              {JIJ_PROFILE.name}
            </Text>
            <Text style={[styles.handle, { color: roles.fgMuted }]}>
              {JIJ_PROFILE.handle}
            </Text>
          </View>
        </View>
        <Text style={[styles.bio, { color: roles.fgRead }]}>
          {JIJ_PROFILE.bio}
        </Text>

        {/* Friends */}
        <SectionHead
          label="Vrienden"
          count={JIJ_FRIENDS.length}
          action="+ Toevoegen"
          onAction={() => router.push('/welkom')}
        />
        {JIJ_FRIENDS.map((f) => (
          <FriendRow key={f.id} friend={f} mode={mode} />
        ))}

        {/* Requests */}
        <SectionHead label="Verzoeken" count={JIJ_REQUESTS.length} />
        {JIJ_REQUESTS.map((r) => (
          <RequestRow key={r.id} request={r} />
        ))}

        {/* DEV */}
        <SectionHead label="DEV" />
        <View style={styles.devWrap}>
          <Pressable
            onPress={resetOnboarding}
            style={({ pressed }) => [
              styles.devBtn,
              {
                borderColor: roles.fgPlaceholder,
                opacity: pressed ? 0.5 : 1,
              },
            ]}
          >
            <Text style={[styles.devLabel, { color: roles.fgMuted }]}>
              Reset onboarding
            </Text>
          </Pressable>
        </View>
      </ScrollView>
      <AppHeader />
    </View>
  );
}

function SectionHead({
  label,
  count,
  action,
  onAction,
}: {
  label: string;
  count?: number;
  action?: string;
  onAction?: () => void;
}) {
  const roles = useRoles();
  return (
    <View style={styles.sectionHead}>
      <Text style={[styles.sectionLabel, { color: roles.fgMuted }]}>
        {label}
        {count !== undefined && (
          <Text style={[styles.sectionCount, { color: roles.fgPlaceholder }]}>
            {' · '}
            {count}
          </Text>
        )}
      </Text>
      {action && (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={[styles.sectionAction, { color: roles.accent }]}>
            {action}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function FriendRow({ friend, mode }: { friend: JijFriend; mode: 'nacht' | 'dag' }) {
  const roles = useRoles();
  return (
    <View style={[styles.friend, { borderColor: roles.bgChip }]}>
      <Image
        source={{ uri: friend.avatar }}
        style={styles.friendAvatar}
        contentFit="cover"
      />
      <View style={styles.friendBody}>
        <Text
          numberOfLines={1}
          style={[styles.friendName, { color: roles.fg }]}
        >
          {friend.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[
            styles.friendMeta,
            { color: friend.hot ? roles.accent : roles.fgMuted },
          ]}
        >
          {friend.meta[mode]}
        </Text>
      </View>
      <Pressable
        style={[styles.followBtn, { borderColor: roles.bgChip }]}
      >
        <Text style={[styles.followBtnText, { color: roles.fgRead }]}>
          Volgend
        </Text>
      </Pressable>
    </View>
  );
}

function RequestRow({ request }: { request: JijRequest }) {
  const roles = useRoles();
  return (
    <View style={[styles.friend, { borderColor: roles.bgChip }]}>
      <Image
        source={{ uri: request.avatar }}
        style={styles.friendAvatar}
        contentFit="cover"
      />
      <View style={styles.friendBody}>
        <Text
          numberOfLines={1}
          style={[styles.friendName, { color: roles.fg }]}
        >
          {request.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.friendMeta, { color: roles.fgMuted }]}
        >
          {request.meta}
        </Text>
      </View>
      <View style={styles.twin}>
        <Pressable
          style={[styles.twinBtn, { borderColor: roles.bgChip }]}
        >
          <Cross size={13} thickness={3} color={roles.fgMuted} />
        </Pressable>
        <Pressable
          style={[
            styles.twinBtn,
            { backgroundColor: roles.accent, borderColor: roles.accent },
          ]}
        >
          <Ionicons name="checkmark" size={18} color={roles.onAccent} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Head
  head: {
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 22,
    paddingTop: 6,
    paddingBottom: 8,
    alignItems: 'center',
  },
  avatarWrap: {
    width: 64,
    height: 64,
    borderRadius: 999,
    borderWidth: 2,
    overflow: 'hidden',
  },
  avatar: { width: '100%', height: '100%' },
  headText: { flex: 1, minWidth: 0 },
  name: {
    fontFamily: fontFamily.bold,
    fontSize: 22,
    letterSpacing: -0.55,
    lineHeight: 22 * 1.05,
  },
  handle: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  bio: {
    fontFamily: fontFamily.body,
    fontSize: 12.5,
    lineHeight: 17.5,
    paddingHorizontal: 22,
    paddingBottom: 10,
  },

  // Section header
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 8,
    gap: 12,
  },
  sectionLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  sectionCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  sectionAction: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },

  // Friend / request row
  friend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  friendAvatar: {
    width: 36,
    height: 36,
    borderRadius: 999,
  },
  friendBody: { flex: 1, minWidth: 0 },
  friendName: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
    lineHeight: 14 * 1.15,
  },
  friendMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  followBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  followBtnText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  twin: { flexDirection: 'row', gap: 6 },
  twinBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // DEV
  devWrap: {
    paddingHorizontal: 22,
    paddingTop: 4,
  },
  devBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  devLabel: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
});
