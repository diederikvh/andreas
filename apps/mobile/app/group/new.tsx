import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackButton } from '@/components/BackButton';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import type { ApiFriend } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { safeBack } from '@/lib/navigation';
import { useCreateGroup, useFriends } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Nieuwe groep aanmaken. Naam + multi-select uit friend-lijst. Bij succes
 * navigeren we direct naar /group/[id] zodat de gebruiker meteen de
 * groep-detail ziet (incl. add-members als hij er meer wil toevoegen).
 */
export default function NewGroup() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const t = useT();

  const { data: friends } = useFriends();
  const createGroup = useCreateGroup();

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sortedFriends = useMemo(() => {
    return [...(friends ?? [])].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [friends]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    Haptics.selectionAsync();
  };

  const onCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const res = await createGroup.mutateAsync({
        name: trimmed,
        memberIds: Array.from(selected),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Vervang current-route met group-detail i.p.v. push, anders kom je
      // via back terecht op een lege "Nieuwe groep"-flow.
      router.replace(`/group/${res.id}` as never);
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const canCreate = name.trim().length > 0 && !createGroup.isPending;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <BackButton onPress={() => safeBack()} />
        <Text style={[styles.title, { color: roles.fg }]}>
          {t('Nieuwe groep', 'New group')}
        </Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 160 }}
      >
        <View
          style={[
            styles.field,
            {
              borderColor: isNacht ? '#2a2a2d' : palette.paper,
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            },
          ]}
        >
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t(
              'bv. Vrijdagclub of Bandvrienden',
              'e.g. Friday crew or Band friends'
            )}
            placeholderTextColor={roles.fgPlaceholder}
            maxLength={80}
            style={[styles.input, { color: roles.fg }]}
          />
        </View>

        <Text style={[styles.sectionHead, { color: roles.fg }]}>
          {t('Leden', 'Members')}
        </Text>
        {sortedFriends.length === 0 ? (
          <Text style={[styles.empty, { color: roles.fgMuted }]}>
            {t(
              'Voeg eerst vrienden toe via Sociaal → Toevoegen.',
              'Add friends first via Social → Add.'
            )}
          </Text>
        ) : (
          sortedFriends.map((f) => (
            <FriendCheckRow
              key={f.id}
              friend={f}
              checked={selected.has(f.id)}
              onPress={() => toggle(f.id)}
            />
          ))
        )}
      </ScrollView>

      <View
        style={[
          styles.dock,
          {
            paddingBottom: Math.max(insets.bottom, 12),
            backgroundColor: roles.bg,
            borderTopColor: roles.bgChip,
          },
        ]}
      >
        <Pressable
          onPress={onCreate}
          disabled={!canCreate}
          style={[
            styles.cta,
            {
              backgroundColor: isNacht ? palette.acid : palette.red,
              opacity: canCreate ? 1 : 0.5,
            },
          ]}
        >
          <Ionicons
            name="people"
            size={16}
            color={isNacht ? palette.noir : palette.paper3}
          />
          <Text
            style={[
              styles.ctaText,
              { color: isNacht ? palette.noir : palette.paper3 },
            ]}
          >
            {createGroup.isPending
              ? t('Aanmaken…', 'Creating…')
              : selected.size === 0
                ? t('Groep aanmaken (zonder leden)', 'Create group (no members)')
                : t(
                    `Groep aanmaken (${selected.size + 1} leden)`,
                    `Create group (${selected.size + 1} members)`
                  )}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function FriendCheckRow({
  friend,
  checked,
  onPress,
}: {
  friend: ApiFriend;
  checked: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, { borderColor: roles.bgChip }]}
    >
      <ProfileAvatar
        avatarUrl={friend.avatarUrl}
        name={friend.name}
        size={36}
      />
      <View style={styles.rowBody}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text
            numberOfLines={1}
            style={[styles.rowName, { color: roles.fg, flexShrink: 1 }]}
          >
            {friend.name}
          </Text>
          {friend.favorite ? (
            <Ionicons name="star" size={13} color={roles.accent} />
          ) : null}
        </View>
        {friend.handle && (
          <Text
            numberOfLines={1}
            style={[styles.rowHandle, { color: roles.fgMuted }]}
          >
            @{friend.handle}
          </Text>
        )}
      </View>
      <View
        style={[
          styles.checkBox,
          checked
            ? { backgroundColor: roles.accent, borderColor: roles.accent }
            : { borderColor: roles.fgPlaceholder },
        ]}
      >
        {checked && (
          <Ionicons name="checkmark" size={16} color={roles.onAccent} />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 12,
    gap: 8,
  },
  title: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 18,
    letterSpacing: -0.36,
    textAlign: 'center',
  },
  sectionHead: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
    paddingHorizontal: 22,
    paddingTop: 26,
    paddingBottom: 8,
  },
  field: {
    marginHorizontal: 22,
    marginTop: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 12,
  },
  input: {
    fontFamily: fontFamily.body,
    fontSize: 15,
    padding: 0,
  },
  empty: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 19,
    paddingHorizontal: 22,
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  rowHandle: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  checkBox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 22,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 14,
  },
  ctaText: {
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.07,
  },
});
