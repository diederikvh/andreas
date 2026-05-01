import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';

import { BackButton } from '@/components/BackButton';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ApiSearchUser } from '@/lib/api';
import {
  useAcceptFriendRequest,
  useSendFriendRequest,
  useUserSearch,
} from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export default function AddFriend() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';

  const [q, setQ] = useState('');
  // Eenvoudige debounce zodat we niet bij elke toets fetchen.
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedQ(q.trim().toLowerCase()),
      200
    );
    return () => clearTimeout(t);
  }, [q]);

  const search = useUserSearch(debouncedQ);
  const sendRequest = useSendFriendRequest();
  const acceptRequest = useAcceptFriendRequest();

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: roles.bg }]}
    >
      <View
        style={[
          styles.topBar,
          { paddingTop: insets.top + 6, paddingBottom: 8 },
        ]}
      >
        <BackButton />
        <Text style={[styles.topTitle, { color: roles.fg }]}>Toevoegen</Text>
        <View style={styles.topBarSpacer} />
      </View>

      <View style={styles.body}>
        <View
          style={[
            styles.searchField,
            {
              borderColor: isNacht ? '#2a2a2d' : palette.paper,
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            },
          ]}
        >
          <Ionicons name="search" size={16} color={roles.fgMuted} />
          <Text style={[styles.atPrefix, { color: roles.fgMuted }]}>@</Text>
          <TextInput
            value={q}
            onChangeText={(t) =>
              setQ(t.toLowerCase().replace(/[^a-z0-9_]/g, ''))
            }
            placeholder="zoek op handle"
            placeholderTextColor={roles.fgPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            style={[styles.searchInput, { color: roles.fg }]}
          />
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        >
          {debouncedQ.length < 2 ? (
            <Text style={[styles.hint, { color: roles.fgMuted }]}>
              Typ minstens 2 tekens om te zoeken.
            </Text>
          ) : search.isLoading ? (
            <Text style={[styles.hint, { color: roles.fgMuted }]}>Zoeken…</Text>
          ) : (search.data ?? []).length === 0 ? (
            <Text style={[styles.hint, { color: roles.fgMuted }]}>
              Geen handle gevonden voor "@{debouncedQ}".
            </Text>
          ) : (
            (search.data ?? []).map((u) => (
              <ResultRow
                key={u.id}
                user={u}
                onAdd={async () => {
                  if (!u.handle) return;
                  try {
                    await sendRequest.mutateAsync(u.handle);
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  } catch {
                    Haptics.notificationAsync(
                      Haptics.NotificationFeedbackType.Error
                    );
                  }
                }}
                onAccept={async () => {
                  try {
                    await acceptRequest.mutateAsync(u.id);
                    Haptics.notificationAsync(
                      Haptics.NotificationFeedbackType.Success
                    );
                  } catch {
                    Haptics.notificationAsync(
                      Haptics.NotificationFeedbackType.Error
                    );
                  }
                }}
                busy={sendRequest.isPending || acceptRequest.isPending}
              />
            ))
          )}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

function ResultRow({
  user,
  onAdd,
  onAccept,
  busy,
}: {
  user: ApiSearchUser;
  onAdd: () => void;
  onAccept: () => void;
  busy: boolean;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  return (
    <View style={[styles.row, { borderColor: roles.bgChip }]}>
      {user.avatarUrl ? (
        <Image
          source={{ uri: user.avatarUrl }}
          style={styles.rowAvatar}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.rowAvatar,
            styles.rowAvatarFallback,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        >
          <Text
            style={[styles.rowAvatarInitial, { color: roles.fgMuted }]}
          >
            {(user.name.trim()[0] ?? '?').toUpperCase()}
          </Text>
        </View>
      )}
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[styles.rowName, { color: roles.fg }]}>
          {user.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.rowHandle, { color: roles.fgMuted }]}
        >
          @{user.handle}
        </Text>
      </View>
      <RowAction
        relation={user.relation}
        onAdd={onAdd}
        onAccept={onAccept}
        busy={busy}
      />
    </View>
  );
}

function RowAction({
  relation,
  onAdd,
  onAccept,
  busy,
}: {
  relation: ApiSearchUser['relation'];
  onAdd: () => void;
  onAccept: () => void;
  busy: boolean;
}) {
  const roles = useRoles();
  if (relation === 'accepted') {
    return (
      <View style={[styles.actionPill, styles.actionPillMuted, { borderColor: roles.fgMuted }]}>
        <Text style={[styles.actionText, { color: roles.fgMuted }]}>Vriend</Text>
      </View>
    );
  }
  if (relation === 'outgoing') {
    return (
      <View style={[styles.actionPill, styles.actionPillMuted, { borderColor: roles.fgMuted }]}>
        <Text style={[styles.actionText, { color: roles.fgMuted }]}>
          Aangevraagd
        </Text>
      </View>
    );
  }
  if (relation === 'incoming') {
    return (
      <Pressable
        onPress={onAccept}
        disabled={busy}
        style={[
          styles.actionPill,
          {
            backgroundColor: roles.accent,
            borderColor: roles.accent,
            opacity: busy ? 0.6 : 1,
          },
        ]}
      >
        <Text style={[styles.actionText, { color: roles.onAccent }]}>
          Accepteer
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={onAdd}
      disabled={busy}
      style={[
        styles.actionPill,
        {
          backgroundColor: roles.accent,
          borderColor: roles.accent,
          opacity: busy ? 0.6 : 1,
        },
      ]}
    >
      <Text style={[styles.actionText, { color: roles.onAccent }]}>
        + Toevoegen
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    gap: 8,
  },
  topBarSpacer: { width: 40, height: 40 },
  topTitle: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
    textAlign: 'center',
  },
  body: { flex: 1, paddingHorizontal: 22, gap: 14 },

  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 12,
    marginTop: 8,
  },
  atPrefix: {
    fontFamily: fontFamily.mono,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  searchInput: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 16,
    letterSpacing: 0.4,
    padding: 0,
  },

  hint: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    paddingVertical: 14,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowAvatar: { width: 40, height: 40, borderRadius: 999 },
  rowAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  rowAvatarInitial: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.4,
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  rowHandle: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginTop: 4,
  },

  actionPill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  actionPillMuted: { backgroundColor: 'transparent' },
  actionText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
});
