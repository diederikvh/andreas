import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { Cross } from '@/components/Cross';
import type {
  ApiFriend,
  ApiFriendRequest,
  ApiInvite,
  ApiMe,
} from '@/lib/api';
import { getMe, updateMe, uploadAvatar } from '@/lib/api';
import { authClient, useSession } from '@/lib/authClient';
import { DOW_NL_MIXED, formatTime } from '@/lib/eventDisplay';
import {
  useAcceptFriendRequest,
  useAcceptInvite,
  useDeclineFriendRequest,
  useDeclineInvite,
  useFriendRequests,
  useFriends,
  useInvites,
  useOutgoingFriendRequests,
} from '@/lib/queries';
import { useMode, useModeStore, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

type Stage = 'phone' | 'code' | 'profile' | 'authed';

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export default function Jij() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const { data: me, refetch: refetchMe } = useQuery<ApiMe | null>({
    queryKey: ['me', session?.user?.id ?? null],
    queryFn: () => getMe(),
    enabled: Boolean(session?.user?.id),
  });
  const authedAndOnboarded = Boolean(session?.user?.id && me?.handle);
  const { data: friends } = useFriends({ enabled: authedAndOnboarded });
  const { data: requests } = useFriendRequests({ enabled: authedAndOnboarded });
  const { data: outgoing } = useOutgoingFriendRequests({
    enabled: authedAndOnboarded,
  });
  const { data: invites } = useInvites({ enabled: authedAndOnboarded });
  const acceptRequest = useAcceptFriendRequest();
  const declineRequest = useDeclineFriendRequest();
  const acceptInvite = useAcceptInvite();
  const declineInvite = useDeclineInvite();

  // Stage uit sessie + me afgeleid; tijdelijke override voor de
  // "code"-stap die geen server-state heeft.
  const sessionStage: Stage = !session
    ? 'phone'
    : !me?.handle
      ? 'profile'
      : 'authed';
  const [stageOverride, setStageOverride] = useState<Stage | null>(null);
  const stage = stageOverride ?? sessionStage;

  // Reset override als de afgeleide stage 'm inhaalt (bv. na verify of saven).
  useEffect(() => {
    if (stageOverride && stageOverride === sessionStage) {
      setStageOverride(null);
    }
  }, [stageOverride, sessionStage]);

  // Auth-form state
  const [local, setLocal] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [handleTouched, setHandleTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<TextInput>(null);
  const phone = `+31${local.replace(/^0+/, '')}`;

  // Onboarding (eerste keer profile-stap zonder handle): laat het
  // naam-veld leeg als de DB-naam nog het telefoonnummer is.
  useEffect(() => {
    if (stage === 'profile' && me && !me.handle && me.name && !me.name.startsWith('+')) {
      setName(me.name);
    }
  }, [stage, me]);

  function deriveHandle(fromName: string): string {
    return (fromName.trim().split(/\s+/)[0] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 20);
  }

  const sendCode = async () => {
    if (local.length < 9) {
      setError('Vul een geldig nummer in.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.phoneNumber.sendOtp({
      phoneNumber: phone,
    });
    setBusy(false);
    if (err) {
      setError(err.message ?? 'Versturen mislukt.');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStageOverride('code');
    setTimeout(() => codeRef.current?.focus(), 120);
  };

  const verifyCode = async () => {
    if (code.length !== 6) {
      setError('Code is 6 cijfers.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.phoneNumber.verify({
      phoneNumber: phone,
      code,
    });
    if (err) {
      setBusy(false);
      setError(err.message ?? 'Code klopt niet.');
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setBusy(false);
    setCode('');
    // Sessie state zal zich updaten en stage naar 'profile' brengen.
    setStageOverride(null);
  };

  const saveProfile = async () => {
    const trimmedName = name.trim();
    if (trimmedName.length < 1) {
      setError('Naam is verplicht.');
      return;
    }
    if (!HANDLE_RE.test(handle)) {
      setError('Handle: 3–20 kleine letters, cijfers of underscore.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateMe({ name: trimmedName, handle });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refetchMe();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt.');
    } finally {
      setBusy(false);
    }
  };

  const onLogout = async () => {
    await authClient.signOut();
    // Wis de hele query-cache zodat de volgende ingelogde user (of
    // empty state) geen stale data van de vorige sessie ziet.
    queryClient.clear();
    setLocal('');
    setCode('');
    setName('');
    setHandle('');
    setHandleTouched(false);
    setStageOverride(null);
  };

  const onBackToPhone = () => {
    setCode('');
    setError(null);
    setStageOverride(null); // Terug naar sessionStage = 'phone'
  };

  const onEditProfile = () => {
    if (me) {
      setName(me.name && !me.name.startsWith('+') ? me.name : '');
      setHandle(me.handle ?? '');
      setHandleTouched(Boolean(me.handle));
    }
    setError(null);
    setStageOverride('profile');
  };

  const onCancelProfileEdit = () => {
    setError(null);
    setStageOverride(null);
  };

  const [avatarUploading, setAvatarUploading] = useState(false);
  const onPickAvatar = async () => {
    if (avatarUploading) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Geen toegang tot foto-bibliotheek.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    // eslint-disable-next-line no-console
    console.log('[avatar] picked', picked);
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) return;
    setAvatarUploading(true);
    setError(null);
    try {
      // eslint-disable-next-line no-console
      console.log('[avatar] uploading', asset.uri, asset.mimeType);
      const updated = await uploadAvatar({
        uri: asset.uri,
        mimeType: asset.mimeType ?? 'image/jpeg',
      });
      // eslint-disable-next-line no-console
      console.log('[avatar] uploaded', updated.avatarUrl);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refetchMe();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[avatar] failed', e);
      setError(e instanceof Error ? e.message : 'Upload mislukt.');
    } finally {
      setAvatarUploading(false);
    }
  };

  const resetOnboarding = async () => {
    await useModeStore.persist.clearStorage();
    useModeStore.setState({ mode: 'nacht', hasOnboarded: false });
    router.replace('/');
  };

  // ─── Auth views ─────────────────────────────────────────────────────

  if (stage === 'phone' || stage === 'code') {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.root, { backgroundColor: roles.bg }]}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingTop: insets.top + HEADER_HEIGHT + 16,
            paddingBottom: insets.bottom + 96,
            paddingHorizontal: 22,
          }}
        >
          <Text style={[styles.kicker, { color: roles.accent }]}>
            {stage === 'phone' ? 'Inloggen · stap 1/2' : 'Inloggen · stap 2/2'}
          </Text>
          <Text style={[styles.title, { color: roles.fg }]}>
            {stage === 'phone'
              ? 'Wat is je\nnummer?'
              : 'Vul de code\nuit de SMS.'}
          </Text>

          {stage === 'phone' && (
            <Text style={[styles.lead, { color: roles.fgRead }]}>
              Met een account onthoudt Andreas welke events je hebt
              opgeslagen en met wie je optrekt. Geen wachtwoord — alleen
              een SMS-code op je nummer.
            </Text>
          )}

          {stage === 'phone' ? (
            <>
              <View
                style={[
                  styles.field,
                  styles.fieldRow,
                  authFieldStyle(isNacht),
                ]}
              >
                <Text style={[styles.prefix, { color: roles.fgMuted }]}>
                  +31
                </Text>
                <TextInput
                  key="phone"
                  value={local}
                  onChangeText={(t) => setLocal(t.replace(/[^0-9]/g, ''))}
                  placeholder="612345678"
                  placeholderTextColor={roles.fgPlaceholder}
                  keyboardType="phone-pad"
                  autoFocus
                  style={[styles.input, { color: roles.fg }]}
                  returnKeyType="done"
                  onSubmitEditing={sendCode}
                />
              </View>
              <Text style={[styles.helper, { color: roles.fgMuted }]}>
                Je krijgt een SMS met een 6-cijferige code.
              </Text>
            </>
          ) : (
            <>
              <View
                style={[
                  styles.field,
                  styles.fieldRow,
                  authFieldStyle(isNacht),
                ]}
              >
                <TextInput
                  ref={codeRef}
                  key="code"
                  value={code}
                  onChangeText={(t) => setCode(t.replace(/[^0-9]/g, ''))}
                  placeholder="123456"
                  placeholderTextColor={roles.fgPlaceholder}
                  keyboardType="number-pad"
                  maxLength={6}
                  style={[styles.input, styles.codeInput, { color: roles.fg }]}
                  returnKeyType="done"
                  onSubmitEditing={verifyCode}
                />
              </View>
              <Pressable onPress={onBackToPhone}>
                <Text style={[styles.helperLink, { color: roles.fgMuted }]}>
                  Verkeerd nummer? Terug.
                </Text>
              </Pressable>
            </>
          )}

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            onPress={stage === 'phone' ? sendCode : verifyCode}
            disabled={busy}
            style={[
              styles.cta,
              {
                backgroundColor: isNacht ? palette.acid : palette.red,
                opacity: busy ? 0.5 : 1,
              },
            ]}
          >
            <Text
              style={[
                styles.ctaText,
                { color: isNacht ? palette.noir : palette.paper3 },
              ]}
            >
              {busy
                ? 'Bezig…'
                : stage === 'phone'
                  ? 'Stuur code'
                  : 'Inloggen'}
            </Text>
          </Pressable>
        </ScrollView>
        <AppHeader />
      </KeyboardAvoidingView>
    );
  }

  // ─── Profile-onboarding view ────────────────────────────────────────

  if (stage === 'profile') {
    const isEditing = Boolean(me?.handle);
    const onChangeName = (next: string) => {
      setName(next);
      if (!handleTouched) setHandle(deriveHandle(next));
    };
    const onChangeHandle = (next: string) => {
      setHandleTouched(true);
      setHandle(next.toLowerCase().replace(/[^a-z0-9_]/g, ''));
    };

    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.root, { backgroundColor: roles.bg }]}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingTop: insets.top + HEADER_HEIGHT + 16,
            paddingBottom: insets.bottom + 96,
            paddingHorizontal: 22,
          }}
        >
          <Text style={[styles.kicker, { color: roles.accent }]}>
            {isEditing ? 'Profiel bewerken' : 'Even kennismaken'}
          </Text>
          <Text style={[styles.title, { color: roles.fg }]}>
            {isEditing
              ? 'Pas je naam\nof handle aan.'
              : 'Hoe heet je\neigenlijk?'}
          </Text>

          <View style={styles.fieldGroup}>
            <Text style={[styles.label, { color: roles.fgMuted }]}>NAAM</Text>
            <View
              style={[
                styles.field,
                styles.fieldRow,
                authFieldStyle(isNacht),
              ]}
            >
              <TextInput
                key="name"
                value={name}
                onChangeText={onChangeName}
                placeholder="bv. Harry Styles"
                placeholderTextColor={roles.fgPlaceholder}
                autoFocus
                autoCapitalize="words"
                autoCorrect={false}
                style={[styles.input, { color: roles.fg }]}
                returnKeyType="next"
              />
            </View>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={[styles.label, { color: roles.fgMuted }]}>HANDLE</Text>
            <View
              style={[
                styles.field,
                styles.fieldRow,
                authFieldStyle(isNacht),
              ]}
            >
              <Text style={[styles.prefix, { color: roles.fgMuted }]}>@</Text>
              <TextInput
                key="handle"
                value={handle}
                onChangeText={onChangeHandle}
                placeholder="diederik"
                placeholderTextColor={roles.fgPlaceholder}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={20}
                style={[styles.input, { color: roles.fg }]}
                returnKeyType="done"
                onSubmitEditing={saveProfile}
              />
            </View>
            <Text style={[styles.hint, { color: roles.fgPlaceholder }]}>
              3–20 kleine letters, cijfers of underscore. Vrienden vinden je
              hierop.
            </Text>
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            onPress={saveProfile}
            disabled={busy}
            style={[
              styles.cta,
              {
                backgroundColor: isNacht ? palette.acid : palette.red,
                opacity: busy ? 0.5 : 1,
              },
            ]}
          >
            <Text
              style={[
                styles.ctaText,
                { color: isNacht ? palette.noir : palette.paper3 },
              ]}
            >
              {busy
                ? 'Bezig…'
                : isEditing
                  ? 'Opslaan'
                  : 'Doorgaan'}
            </Text>
          </Pressable>
          {isEditing && (
            <Pressable onPress={onCancelProfileEdit} hitSlop={8}>
              <Text style={[styles.cancelLink, { color: roles.fgMuted }]}>
                Annuleren
              </Text>
            </Pressable>
          )}
        </ScrollView>
        <AppHeader />
      </KeyboardAvoidingView>
    );
  }

  // ─── Authed Jij ─────────────────────────────────────────────────────

  const displayName =
    me?.name && !me.name.startsWith('+') ? me.name : 'Jij';
  const displayHandle = me?.handle ? `@${me.handle}` : 'NIEUW';

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
        <View style={styles.head}>
          <Pressable
            onPress={onPickAvatar}
            disabled={avatarUploading}
            style={[
              styles.avatarWrap,
              {
                borderColor: roles.bgChip,
                opacity: avatarUploading ? 0.5 : 1,
              },
            ]}
          >
            {me?.avatarUrl ? (
              <Image
                source={{ uri: me.avatarUrl }}
                style={styles.avatar}
                contentFit="cover"
              />
            ) : (
              <View
                style={[
                  styles.avatar,
                  styles.avatarFallback,
                  {
                    backgroundColor: isNacht ? palette.noir2 : palette.paper2,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.avatarInitial,
                    { color: roles.fgMuted },
                  ]}
                >
                  {initialFor(displayName)}
                </Text>
              </View>
            )}
            <View
              style={[
                styles.avatarBadge,
                { backgroundColor: roles.accent, borderColor: roles.bg },
              ]}
            >
              <Ionicons
                name={avatarUploading ? 'hourglass' : 'camera'}
                size={14}
                color={roles.onAccent}
              />
            </View>
          </Pressable>
          <Text style={[styles.profileName, { color: roles.fg }]}>
            {displayName}
          </Text>
          <Text style={[styles.profileHandle, { color: roles.fgMuted }]}>
            {displayHandle}
          </Text>
          <Pressable
            onPress={onEditProfile}
            style={[styles.editBtn, { borderColor: roles.fgMuted }]}
          >
            <Text style={[styles.editBtnText, { color: roles.fgMuted }]}>
              Bewerk profiel
            </Text>
          </Pressable>
          {error && <Text style={styles.error}>{error}</Text>}
        </View>

        {invites && invites.length > 0 && (
          <>
            <SectionHead label="Uitnodigingen" count={invites.length} />
            {invites.map((inv) => (
              <InviteRow
                key={inv.id}
                invite={inv}
                onAccept={() => acceptInvite.mutate(inv.id)}
                onDecline={() => declineInvite.mutate(inv.id)}
                busy={acceptInvite.isPending || declineInvite.isPending}
              />
            ))}
          </>
        )}

        <SectionHead
          label="Vrienden"
          count={friends?.length ?? 0}
          action="+ Toevoegen"
          onAction={() => router.push('/add-friend' as never)}
        />
        {(friends ?? []).length === 0 ? (
          <Text style={[styles.emptyHint, { color: roles.fgMuted }]}>
            Nog geen vrienden. Tik op + Toevoegen om iemand te zoeken.
          </Text>
        ) : (
          friends!.map((f) => <FriendRow key={f.id} friend={f} />)
        )}

        {outgoing && outgoing.length > 0 && (
          <>
            <SectionHead label="Aangevraagd" count={outgoing.length} />
            {outgoing.map((o) => (
              <PendingRow key={o.id} user={o} />
            ))}
          </>
        )}

        {requests && requests.length > 0 && (
          <>
            <SectionHead label="Verzoeken" count={requests.length} />
            {requests.map((r) => (
              <RequestRow
                key={r.id}
                request={r}
                onAccept={() => acceptRequest.mutate(r.id)}
                onDecline={() => declineRequest.mutate(r.id)}
                busy={acceptRequest.isPending || declineRequest.isPending}
              />
            ))}
          </>
        )}

        <SectionHead label="Account" />
        <View style={styles.devWrap}>
          <Pressable
            onPress={onLogout}
            style={[styles.devBtn, { borderColor: roles.fgMuted }]}
          >
            <Text style={[styles.devLabel, { color: roles.fgMuted }]}>
              Uitloggen
            </Text>
          </Pressable>
        </View>

        <SectionHead label="DEV" />
        <View style={styles.devWrap}>
          <Pressable
            onPress={resetOnboarding}
            style={[styles.devBtn, { borderColor: roles.fgPlaceholder }]}
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

function initialFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith('+')) return '?';
  return trimmed[0].toUpperCase();
}

function authFieldStyle(isNacht: boolean) {
  return {
    borderColor: isNacht ? '#2a2a2d' : palette.paper,
    backgroundColor: isNacht ? palette.noir2 : palette.paper2,
  };
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

function FriendRow({ friend }: { friend: ApiFriend }) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={() => router.push(`/friend/${friend.id}` as never)}
      style={[styles.friend, { borderColor: roles.bgChip }]}
    >
      <ProfileAvatar
        avatarUrl={friend.avatarUrl}
        name={friend.name}
        size={36}
      />
      <View style={styles.friendBody}>
        <Text
          numberOfLines={1}
          style={[styles.friendName, { color: roles.fg }]}
        >
          {friend.name}
        </Text>
        {friend.handle && (
          <Text
            numberOfLines={1}
            style={[styles.friendMeta, { color: roles.fgMuted }]}
          >
            @{friend.handle}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function RequestRow({
  request,
  onAccept,
  onDecline,
  busy,
}: {
  request: ApiFriendRequest;
  onAccept: () => void;
  onDecline: () => void;
  busy: boolean;
}) {
  const roles = useRoles();
  return (
    <View style={[styles.friend, { borderColor: roles.bgChip }]}>
      <ProfileAvatar
        avatarUrl={request.avatarUrl}
        name={request.name}
        size={36}
      />
      <View style={styles.friendBody}>
        <Text
          numberOfLines={1}
          style={[styles.friendName, { color: roles.fg }]}
        >
          {request.name}
        </Text>
        {request.handle && (
          <Text
            numberOfLines={1}
            style={[styles.friendMeta, { color: roles.fgMuted }]}
          >
            @{request.handle}
          </Text>
        )}
      </View>
      <View style={styles.twin}>
        <Pressable
          onPress={onDecline}
          disabled={busy}
          style={[styles.twinBtn, { borderColor: roles.fgPlaceholder }]}
        >
          <Cross size={16} thickness={3.2} color={roles.fgMuted} />
        </Pressable>
        <Pressable
          onPress={onAccept}
          disabled={busy}
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

function InviteRow({
  invite,
  onAccept,
  onDecline,
  busy,
}: {
  invite: ApiInvite;
  onAccept: () => void;
  onDecline: () => void;
  busy: boolean;
}) {
  const roles = useRoles();
  const d = new Date(invite.event.startsAt);
  const dateLabel = `${DOW_NL_MIXED[d.getDay()]} · ${formatTime(invite.event.startsAt)}`;
  return (
    <Pressable
      onPress={() => router.push(`/event/${invite.event.id}` as never)}
      style={[styles.invite, { borderColor: roles.bgChip }]}
    >
      <ProfileAvatar
        avatarUrl={invite.from.avatarUrl}
        name={invite.from.name}
        size={36}
      />
      <View style={styles.inviteBody}>
        <Text
          numberOfLines={2}
          style={[styles.inviteLine, { color: roles.fgRead }]}
        >
          <Text style={[styles.inviteName, { color: roles.fg }]}>
            {invite.from.name}
          </Text>
          {' vraagt je mee naar '}
          <Text style={[styles.inviteEvent, { color: roles.fg }]}>
            {invite.event.title}
          </Text>
          .
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.inviteMeta, { color: roles.fgMuted }]}
        >
          {dateLabel} · {invite.event.venueName}
        </Text>
        {invite.message && (
          <Text
            numberOfLines={2}
            style={[styles.inviteMessage, { color: roles.fgMuted }]}
          >
            “{invite.message}”
          </Text>
        )}
      </View>
      <View style={styles.twin}>
        <Pressable
          onPress={onDecline}
          disabled={busy}
          hitSlop={6}
          style={[styles.twinBtn, { borderColor: roles.fgPlaceholder }]}
        >
          <Cross size={16} thickness={3.2} color={roles.fgMuted} />
        </Pressable>
        <Pressable
          onPress={onAccept}
          disabled={busy}
          hitSlop={6}
          style={[
            styles.twinBtn,
            { backgroundColor: roles.accent, borderColor: roles.accent },
          ]}
        >
          <Ionicons name="checkmark" size={18} color={roles.onAccent} />
        </Pressable>
      </View>
    </Pressable>
  );
}

function PendingRow({ user }: { user: ApiFriendRequest }) {
  const roles = useRoles();
  return (
    <View style={[styles.friend, { borderColor: roles.bgChip }]}>
      <ProfileAvatar
        avatarUrl={user.avatarUrl}
        name={user.name}
        size={36}
      />
      <View style={styles.friendBody}>
        <Text
          numberOfLines={1}
          style={[styles.friendName, { color: roles.fg }]}
        >
          {user.name}
        </Text>
        {user.handle && (
          <Text
            numberOfLines={1}
            style={[styles.friendMeta, { color: roles.fgMuted }]}
          >
            @{user.handle}
          </Text>
        )}
      </View>
      <View
        style={[styles.pendingPill, { borderColor: `${roles.fgMuted}80` }]}
      >
        <Text style={[styles.pendingPillText, { color: roles.fgMuted }]}>
          Wacht op acceptatie
        </Text>
      </View>
    </View>
  );
}

function ProfileAvatar({
  avatarUrl,
  name,
  size,
}: {
  avatarUrl: string | null;
  name: string;
  size: number;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  if (avatarUrl) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        style={{ width: size, height: size, borderRadius: 999 }}
        contentFit="cover"
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: isNacht ? palette.noir2 : palette.paper2,
      }}
    >
      <Text
        style={{
          fontFamily: fontFamily.display,
          fontSize: size * 0.45,
          color: roles.fgMuted,
        }}
      >
        {initialFor(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Auth-form copy
  kicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    lineHeight: 30 * 0.95,
    letterSpacing: -1,
    marginTop: 6,
    marginBottom: 12,
  },
  lead: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 8,
  },

  fieldGroup: { gap: 6, marginTop: 8 },
  label: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
  },
  field: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderRadius: 12,
    marginTop: 4,
  },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  prefix: {
    fontFamily: fontFamily.mono,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  input: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 18,
    letterSpacing: 0.4,
    padding: 0,
  },
  codeInput: {
    fontFamily: fontFamily.mono,
    letterSpacing: 6,
    textAlign: 'center',
  },
  helper: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    lineHeight: 16,
    marginTop: 8,
  },
  helperLink: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    textDecorationLine: 'underline',
    marginTop: 8,
  },
  hint: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.5,
    lineHeight: 14,
    marginTop: 4,
  },
  error: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    color: '#c9453a',
    marginTop: 8,
  },
  cta: {
    marginTop: 16,
    paddingVertical: 15,
    borderRadius: 999,
    alignItems: 'center',
  },
  ctaText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.07,
  },

  // Authed profile head — gecentreerde stack: avatar / naam / handle / edit
  head: {
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 10,
  },
  avatarWrap: {
    width: 96,
    height: 96,
    borderRadius: 999,
    borderWidth: 2,
  },
  avatar: { width: '100%', height: '100%', borderRadius: 999 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: {
    fontFamily: fontFamily.display,
    fontSize: 40,
    letterSpacing: -1,
  },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileName: {
    fontFamily: fontFamily.display,
    fontSize: 26,
    letterSpacing: -0.65,
    lineHeight: 26 * 1.02,
    textAlign: 'center',
    marginTop: 4,
  },
  profileHandle: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  editBtn: {
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  editBtnText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  cancelLink: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    textAlign: 'center',
    marginTop: 12,
    textDecorationLine: 'underline',
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
  // Invite-row — dezelfde container als FriendRow, met extra body-lijnen.
  invite: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inviteBody: { flex: 1, minWidth: 0 },
  inviteLine: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
  },
  inviteName: { fontFamily: fontFamily.bold },
  inviteEvent: { fontFamily: fontFamily.bold },
  inviteMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  inviteMessage: {
    fontFamily: fontFamily.body,
    fontStyle: 'italic',
    fontSize: 12,
    lineHeight: 16.5,
    marginTop: 6,
  },

  pendingPill: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  pendingPillText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 9,
    letterSpacing: 1.1,
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

  emptyHint: {
    fontFamily: fontFamily.body,
    fontSize: 12.5,
    lineHeight: 17.5,
    paddingHorizontal: 22,
    paddingVertical: 8,
  },

  // Account / DEV
  devWrap: { paddingHorizontal: 22, paddingTop: 4 },
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

