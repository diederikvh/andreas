import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackButton } from '@/components/BackButton';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import type { ApiFriend, ApiGroupMember } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { safeBack } from '@/lib/navigation';
import { useSession } from '@/lib/authClient';
import {
  useAddGroupMembers,
  useDeleteGroup,
  useFriends,
  useGroup,
  useRemoveGroupMember,
  useRenameGroup,
  useToggleGroupMute,
} from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Groep-detail. Toont leden, eigen mute-toggle, en — voor de creator —
 * naam-edit en knoppen om leden toe te voegen of te verwijderen. Niet-
 * creator ziet alleen de lijst + Verlaten-knop voor zichzelf.
 */
export default function GroupDetail() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ?? '';
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const t = useT();

  const { data: session } = useSession();
  const myId = session?.user?.id ?? null;
  const { data: group, isLoading, error } = useGroup(id);

  const renameGroup = useRenameGroup();
  const deleteGroup = useDeleteGroup();
  const toggleMute = useToggleGroupMute();
  const removeMember = useRemoveGroupMember();

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [addMembersOpen, setAddMembersOpen] = useState(false);

  if (isLoading) {
    return (
      <View
        style={[styles.root, styles.center, { backgroundColor: roles.bg }]}
      >
        <ActivityIndicator color={roles.fgMuted} />
      </View>
    );
  }
  if (error || !group) {
    return (
      <View
        style={[styles.root, styles.center, { backgroundColor: roles.bg }]}
      >
        <Text style={[styles.errorText, { color: roles.fgMuted }]}>
          {t('Deze groep is niet beschikbaar.', 'This group is not available.')}
        </Text>
        <Pressable onPress={() => safeBack()} style={{ paddingTop: 16 }}>
          <Text style={{ color: roles.accent, fontFamily: fontFamily.medium }}>
            {t('Terug', 'Back')}
          </Text>
        </Pressable>
      </View>
    );
  }

  const isCreator = group.isCreator;
  const onRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === group.name) {
      setRenameOpen(false);
      return;
    }
    try {
      await renameGroup.mutateAsync({ id, name: trimmed });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setRenameOpen(false);
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const onToggleMute = () => {
    toggleMute.mutate({ id, mute: !group.muted });
  };

  const onDelete = () => {
    Alert.alert(
      t('Groep verwijderen?', 'Delete group?'),
      t(
        'De groep verdwijnt voor alle leden. Dit kan niet ongedaan worden gemaakt.',
        'The group disappears for everyone. This cannot be undone.'
      ),
      [
        { text: t('Annuleer', 'Cancel'), style: 'cancel' },
        {
          text: t('Verwijder', 'Delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteGroup.mutateAsync(id);
              setRenameOpen(false);
              safeBack();
            } catch {
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Error
              );
            }
          },
        },
      ]
    );
  };

  const onLeave = () => {
    if (!myId) return;
    Alert.alert(
      t('Groep verlaten?', 'Leave group?'),
      t(
        'Andere leden zien dat je bent vertrokken. Je krijgt geen nieuwe uitnodigingen via deze groep.',
        'Other members will see you left. You won’t get new invitations through this group.'
      ),
      [
        { text: t('Annuleer', 'Cancel'), style: 'cancel' },
        {
          text: t('Verlaten', 'Leave'),
          style: 'destructive',
          onPress: async () => {
            try {
              await removeMember.mutateAsync({ groupId: id, userId: myId });
              safeBack();
            } catch {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            }
          },
        },
      ]
    );
  };

  const onKick = (member: ApiGroupMember) => {
    Alert.alert(
      t('Lid verwijderen?', 'Remove member?'),
      t(
        `${member.name} wordt uit de groep gehaald.`,
        `${member.name} will be removed from the group.`
      ),
      [
        { text: t('Annuleer', 'Cancel'), style: 'cancel' },
        {
          text: t('Verwijderen', 'Remove'),
          style: 'destructive',
          onPress: () => {
            removeMember.mutate({ groupId: id, userId: member.id });
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <BackButton onPress={() => safeBack()} />
        <Text
          numberOfLines={1}
          style={[styles.title, { color: roles.fg }]}
        >
          {group.name}
        </Text>
        <View style={styles.headerActions}>
          {isCreator && (
            <Pressable
              onPress={() => {
                setRenameValue(group.name);
                setRenameOpen(true);
              }}
              hitSlop={6}
              style={[
                styles.iconBtn,
                {
                  backgroundColor: isNacht ? palette.noir2 : palette.paper2,
                },
              ]}
            >
              <Ionicons name="create-outline" size={18} color={roles.fg} />
            </Pressable>
          )}
          <Pressable
            onPress={onToggleMute}
            hitSlop={6}
            style={[
              styles.iconBtn,
              {
                backgroundColor: isNacht ? palette.noir2 : palette.paper2,
              },
            ]}
          >
            <Ionicons
              name={group.muted ? 'notifications-off' : 'notifications-outline'}
              size={18}
              color={group.muted ? roles.fgMuted : roles.fg}
            />
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
      >
        <View style={styles.sectionHeadRow}>
          <Text style={[styles.sectionHead, { color: roles.fg }]}>
            {t('Leden', 'Members')}
          </Text>
          {isCreator && (
            <Pressable
              onPress={() => setAddMembersOpen(true)}
              accessibilityLabel={t('Leden toevoegen', 'Add members')}
              hitSlop={8}
              style={[
                styles.sectionAddBtn,
                { backgroundColor: roles.accent },
              ]}
            >
              <Ionicons name="add" size={20} color={roles.onAccent} />
            </Pressable>
          )}
        </View>

        {group.members.map((m) => {
          const isMe = m.id === myId;
          const isMemberCreator = m.id === group.creatorId;
          return (
            <View
              key={m.id}
              style={[styles.memberRow, { borderColor: roles.bgChip }]}
            >
              <ProfileAvatar
                avatarUrl={m.avatarUrl}
                name={m.name}
                size={36}
              />
              <View style={styles.memberBody}>
                <View style={styles.memberNameLine}>
                  <Text
                    numberOfLines={1}
                    style={[styles.memberName, { color: roles.fg }]}
                  >
                    {m.name}
                    {isMe ? t(' (jij)', ' (you)') : ''}
                  </Text>
                  {isMemberCreator ? (
                    <View
                      style={[
                        styles.adminPill,
                        { borderColor: `${roles.fgMuted}80` },
                      ]}
                    >
                      <Text
                        style={[
                          styles.adminPillText,
                          { color: roles.fgMuted },
                        ]}
                      >
                        {t('Creator', 'Creator')}
                      </Text>
                    </View>
                  ) : null}
                </View>
                {m.handle && (
                  <Text
                    numberOfLines={1}
                    style={[styles.memberHandle, { color: roles.fgMuted }]}
                  >
                    @{m.handle}
                  </Text>
                )}
              </View>
              {isCreator && !isMe && !isMemberCreator ? (
                <Pressable
                  onPress={() => onKick(m)}
                  hitSlop={8}
                  style={styles.kickBtn}
                >
                  <Ionicons name="close" size={18} color={roles.fgMuted} />
                </Pressable>
              ) : null}
            </View>
          );
        })}

        {!isCreator && (
          <Pressable
            onPress={onLeave}
            style={[
              styles.leaveBtn,
              {
                borderColor: isNacht ? '#2a2a2d' : palette.paper,
              },
            ]}
          >
            <Ionicons name="exit-outline" size={16} color={roles.fgMuted} />
            <Text style={[styles.leaveText, { color: roles.fgMuted }]}>
              {t('Groep verlaten', 'Leave group')}
            </Text>
          </Pressable>
        )}
      </ScrollView>

      <RenameSheet
        visible={renameOpen}
        value={renameValue}
        onChange={setRenameValue}
        onClose={() => setRenameOpen(false)}
        onSave={onRename}
        saving={renameGroup.isPending}
        canDelete={isCreator}
        onDelete={onDelete}
        deleting={deleteGroup.isPending}
      />

      <AddMembersSheet
        visible={addMembersOpen}
        groupId={id}
        existingIds={new Set(group.members.map((m) => m.id))}
        onClose={() => setAddMembersOpen(false)}
      />
    </View>
  );
}

/**
 * Wrapper voor bottom-sheets met:
 *  - Fade-in backdrop (Modal animationType="fade" → backdrop blijft op
 *    z'n plek, schuift niet mee).
 *  - Slide-up entering-animatie op de sheet zelf.
 *  - Swipe-down dismiss via gesture-handler — drag de sheet naar
 *    beneden, en als de drag de threshold overschrijdt (of snelheid
 *    > 800px/s), roept-ie onClose. Onder threshold snap-back naar 0.
 */
/** Off-screen offset voor de slide-in/slide-out animatie. Hoog genoeg
    om een full-height sheet onder de viewport te plaatsen op alle
    iPhone-formaten. */
const SHEET_OFFSCREEN = 900;

function SwipeDismissSheet({
  visible,
  onClose,
  paddingBottom,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  paddingBottom: number;
  children: React.ReactNode;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  // Start off-screen zodat de eerste paint de sheet niet zichtbaar
  // maakt vóór de slide-in animatie kan beginnen.
  const translateY = useSharedValue(SHEET_OFFSCREEN);

  // Open-animatie: reset naar off-screen en animeer naar 0. Bij re-open
  // na een swipe-close zorgt de expliciete reset dat de sheet altijd
  // weer vanaf de bodem omhoog komt — niet onzichtbaar blijft hangen.
  useEffect(() => {
    if (visible) {
      translateY.value = SHEET_OFFSCREEN;
      translateY.value = withTiming(0, { duration: 280 });
    }
  }, [visible, translateY]);

  // Slide-out → fade backdrop → unmount. Backdrop tap én swipe-end
  // gebruiken beide dit pad zodat de close-animatie consistent is.
  const animateClose = () => {
    translateY.value = withTiming(
      SHEET_OFFSCREEN,
      { duration: 220 },
      (finished) => {
        'worklet';
        if (finished) runOnJS(onClose)();
      }
    );
  };

  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .onUpdate((e) => {
      if (e.translationY > 0) translateY.value = e.translationY;
    })
    .onEnd((e) => {
      // Sluit bij >100px sleepafstand óf snelle flick (>800 px/s).
      if (e.translationY > 100 || e.velocityY > 800) {
        translateY.value = withTiming(
          SHEET_OFFSCREEN,
          { duration: 220 },
          (finished) => {
            'worklet';
            if (finished) runOnJS(onClose)();
          }
        );
      } else {
        translateY.value = withTiming(0);
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={animateClose}
      statusBarTranslucent
    >
      <Pressable style={styles.modalBackdrop} onPress={animateClose}>
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              styles.bottomSheet,
              {
                backgroundColor: isNacht ? palette.noir : palette.paper3,
                paddingBottom,
              },
              animatedStyle,
            ]}
            onStartShouldSetResponder={() => true}
            onTouchEnd={(e) => e.stopPropagation()}
          >
            <View style={styles.sheetHandleWrap}>
              <View
                style={[styles.sheetHandle, { backgroundColor: roles.bgChip }]}
              />
            </View>
            {children}
          </Animated.View>
        </GestureDetector>
      </Pressable>
    </Modal>
  );
}

function RenameSheet({
  visible,
  value,
  onChange,
  onClose,
  onSave,
  saving,
  canDelete,
  onDelete,
  deleting,
}: {
  visible: boolean;
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  canDelete?: boolean;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const insets = useSafeAreaInsets();
  return (
    <SwipeDismissSheet
      visible={visible}
      onClose={onClose}
      paddingBottom={Math.max(insets.bottom, 12)}
    >
      <Text style={[styles.sheetTitle, { color: roles.fg }]}>
        {t('Naam wijzigen', 'Rename group')}
      </Text>
      <View style={{ paddingHorizontal: 22 }}>
        <TextInput
          value={value}
          onChangeText={onChange}
          maxLength={80}
          autoFocus
          style={[
            styles.modalInput,
            {
              color: roles.fg,
              borderColor: isNacht ? '#2a2a2d' : palette.paper,
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            },
          ]}
        />
      </View>
      <View
        style={{
          flexDirection: 'row',
          gap: 12,
          paddingHorizontal: 22,
          paddingTop: 16,
        }}
      >
        <Pressable
          onPress={onClose}
          style={[
            styles.sheetBtn,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        >
          <Text style={[styles.sheetBtnText, { color: roles.fg }]}>
            {t('Annuleer', 'Cancel')}
          </Text>
        </Pressable>
        <Pressable
          onPress={onSave}
          disabled={saving}
          style={[styles.sheetBtn, { backgroundColor: roles.accent }]}
        >
          <Text style={[styles.sheetBtnText, { color: roles.onAccent }]}>
            {saving ? t('Bezig…', 'Saving…') : t('Opslaan', 'Save')}
          </Text>
        </Pressable>
      </View>
      {canDelete && onDelete && (
        <View style={{ paddingHorizontal: 22, paddingTop: 18 }}>
          <Pressable
            onPress={onDelete}
            disabled={deleting}
            style={[
              styles.sheetBtn,
              {
                backgroundColor: 'transparent',
                borderWidth: 1,
                borderColor: isNacht ? '#3a1f1f' : '#e6c6c2',
              },
            ]}
          >
            <Text style={[styles.sheetBtnText, { color: palette.red }]}>
              {deleting
                ? t('Bezig…', 'Deleting…')
                : t('Verwijder groep', 'Delete group')}
            </Text>
          </Pressable>
        </View>
      )}
    </SwipeDismissSheet>
  );
}

function AddMembersSheet({
  visible,
  groupId,
  existingIds,
  onClose,
}: {
  visible: boolean;
  groupId: string;
  existingIds: Set<string>;
  onClose: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const insets = useSafeAreaInsets();
  const { data: friends } = useFriends({ enabled: visible });
  const addMembers = useAddGroupMembers();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset selectie elke keer dat de sheet (her)opent.
  useEffect(() => {
    if (visible) setSelected(new Set());
  }, [visible]);

  const candidates = useMemo(
    () => (friends ?? []).filter((f) => !existingIds.has(f.id)),
    [friends, existingIds]
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onAdd = async () => {
    if (selected.size === 0) {
      onClose();
      return;
    }
    try {
      await addMembers.mutateAsync({
        id: groupId,
        userIds: Array.from(selected),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  return (
    <SwipeDismissSheet
      visible={visible}
      onClose={onClose}
      paddingBottom={Math.max(insets.bottom, 12)}
    >
      <Text style={[styles.sheetTitle, { color: roles.fg }]}>
        {t('Leden toevoegen', 'Add members')}
      </Text>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: '70%' }}
      >
        {candidates.length === 0 ? (
          <Text style={[styles.empty, { color: roles.fgMuted }]}>
            {t(
              'Alle vrienden zitten al in deze groep.',
              'All your friends are already in this group.'
            )}
          </Text>
        ) : (
          candidates.map((f) => (
            <CandidateRow
              key={f.id}
              friend={f}
              checked={selected.has(f.id)}
              onPress={() => toggle(f.id)}
            />
          ))
        )}
      </ScrollView>
      <View
        style={{
          flexDirection: 'row',
          gap: 12,
          paddingHorizontal: 22,
          paddingTop: 12,
        }}
      >
        <Pressable
          onPress={onClose}
          style={[
            styles.sheetBtn,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        >
          <Text style={[styles.sheetBtnText, { color: roles.fg }]}>
            {t('Annuleer', 'Cancel')}
          </Text>
        </Pressable>
        <Pressable
          onPress={onAdd}
          disabled={selected.size === 0 || addMembers.isPending}
          style={[
            styles.sheetBtn,
            {
              backgroundColor: roles.accent,
              opacity: selected.size === 0 ? 0.5 : 1,
            },
          ]}
        >
          <Text style={[styles.sheetBtnText, { color: roles.onAccent }]}>
            {addMembers.isPending
              ? t('Bezig…', 'Adding…')
              : t(
                  `Toevoegen (${selected.size})`,
                  `Add (${selected.size})`
                )}
          </Text>
        </Pressable>
      </View>
    </SwipeDismissSheet>
  );
}

function CandidateRow({
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
      style={[styles.memberRow, { borderColor: roles.bgChip }]}
    >
      <ProfileAvatar avatarUrl={friend.avatarUrl} name={friend.name} size={36} />
      <View style={styles.memberBody}>
        <Text
          numberOfLines={1}
          style={[styles.memberName, { color: roles.fg }]}
        >
          {friend.name}
        </Text>
        {friend.handle && (
          <Text
            numberOfLines={1}
            style={[styles.memberHandle, { color: roles.fgMuted }]}
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
  center: { alignItems: 'center', justifyContent: 'center' },
  errorText: { fontFamily: fontFamily.body, fontSize: 14 },
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 26,
    paddingBottom: 8,
  },
  sectionHead: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
  },
  sectionAddBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  memberBody: { flex: 1, minWidth: 0 },
  memberNameLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  memberName: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
    flexShrink: 1,
  },
  memberHandle: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  adminPill: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  adminPillText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 9,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  kickBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 22,
    marginTop: 32,
    paddingVertical: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  leaveText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  empty: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 19,
    paddingHorizontal: 22,
    paddingVertical: 16,
  },
  checkBox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalInput: {
    fontFamily: fontFamily.body,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
  },

  bottomSheet: {
    paddingTop: 0,
    paddingBottom: 12,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '85%',
  },
  sheetHandleWrap: {
    alignItems: 'center',
    paddingTop: 6,
    paddingBottom: 8,
  },
  sheetHandle: {
    width: 44,
    height: 5,
    borderRadius: 2.5,
  },
  sheetTitle: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
    paddingHorizontal: 22,
    paddingVertical: 8,
  },
  sheetBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  sheetBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.07,
  },
});
