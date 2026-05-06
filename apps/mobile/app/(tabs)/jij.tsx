import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { Cross } from '@/components/Cross';
import { SpinningCross } from '@/components/SpinningCross';
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
  useRemoveFriend,
} from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
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
  const { data: session, isPending: sessionPending } = useSession();
  const { data: me, refetch: refetchMe } = useQuery<ApiMe | null>({
    queryKey: ['me', session?.user?.id ?? null],
    queryFn: () => getMe(),
    enabled: Boolean(session?.user?.id),
  });
  // Tussen "session er is" en "me terug van server" is sessionStage
  // tijdelijk 'profile' (omdat me?.handle nog undefined is). Dat gaf
  // een flash van "wat is je naam?". Behandel die periode als loading.
  const stageUnknown = sessionPending || (Boolean(session?.user?.id) && me === undefined);
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
  const [showQr, setShowQr] = useState(false);
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

  // ─── Loading: stage nog niet bekend ─────────────────────────────────

  if (stageUnknown) {
    return (
      <View style={[styles.root, styles.loadingRoot, { backgroundColor: roles.bg }]}>
        <SpinningCross size={28} thickness={5} color={roles.fgPlaceholder} />
        <AppHeader />
      </View>
    );
  }

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
              Met een account kun je je planning bewaren, vrienden
              toevoegen en samen naar events gaan, en venues volgen
              waar je niets van wil missen. Geen wachtwoord. Alleen
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
                  textContentType="telephoneNumber"
                  autoComplete="tel"
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
                  // iOS toont de OTP-code in de QuickType-bar zodra de
                  // SMS binnenkomt; Android vult automatisch in.
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  importantForAutofill="yes"
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
            <Pressable
              onPress={onCancelProfileEdit}
              style={[
                styles.editBtn,
                { borderColor: roles.bgChip, marginTop: 10 },
              ]}
            >
              <Text style={[styles.editBtnText, { color: roles.fgMuted }]}>
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
          <View style={styles.profileActions}>
            {me?.handle && (
              <Pressable
                onPress={() => setShowQr(true)}
                style={[styles.editBtn, { borderColor: roles.bgChip }]}
              >
                <Ionicons
                  name="qr-code-outline"
                  size={12}
                  color={roles.fgMuted}
                  style={{ marginRight: 4 }}
                />
                <Text style={[styles.editBtnText, { color: roles.fgMuted }]}>
                  Mijn QR
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => router.push('/add-friend?scan=1' as never)}
              style={[styles.editBtn, { borderColor: roles.bgChip }]}
            >
              <Ionicons
                name="scan-outline"
                size={16}
                color={roles.fgMuted}
                style={{ marginRight: 6 }}
              />
              <Text style={[styles.editBtnText, { color: roles.fgMuted }]}>
                Scan QR
              </Text>
            </Pressable>
            <Pressable
              onPress={() => router.push('/add-friend' as never)}
              style={[styles.editBtn, { borderColor: roles.bgChip }]}
            >
              <Ionicons
                name="search-outline"
                size={16}
                color={roles.fgMuted}
                style={{ marginRight: 6 }}
              />
              <Text style={[styles.editBtnText, { color: roles.fgMuted }]}>
                Vrienden zoeken
              </Text>
            </Pressable>
            <Pressable
              onPress={onEditProfile}
              style={[styles.editBtn, { borderColor: roles.bgChip }]}
            >
              <Text style={[styles.editBtnText, { color: roles.fgMuted }]}>
                Bewerk profiel
              </Text>
            </Pressable>
          </View>
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

        {friends && friends.length > 0 && (
          <>
            <SectionHead label="Vrienden" count={friends.length} />
            {friends.map((f) => <FriendRow key={f.id} friend={f} />)}
          </>
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

        {me && <PrivacySection me={me} onUpdated={refetchMe} />}

        <View style={styles.logoutWrap}>
          <Pressable
            onPress={onLogout}
            style={[styles.editBtn, { borderColor: roles.bgChip }]}
          >
            <Text style={[styles.editBtnText, { color: roles.fgMuted }]}>
              Uitloggen
            </Text>
          </Pressable>
        </View>
      </ScrollView>
      <AppHeader />
      <Modal
        visible={showQr && Boolean(me?.handle)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowQr(false)}
      >
        {me?.handle && (
          <MyQrSheet
            handle={me.handle}
            name={displayName}
            avatarUrl={me.avatarUrl}
            onClose={() => setShowQr(false)}
          />
        )}
      </Modal>
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
  // De uitnodiging gaat over een specifieke occurrence (= moment), niet
  // over het master-event. Toon dus die datum/tijd.
  const d = new Date(invite.occurrence.startsAt);
  const dateLabel = `${DOW_NL_MIXED[d.getDay()]} · ${formatTime(invite.occurrence.startsAt)}`;
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

function MyQrSheet({
  handle,
  name,
  avatarUrl: _avatarUrl,
  onClose,
}: {
  handle: string;
  name: string;
  avatarUrl: string | null;
  onClose: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const url = `https://andreas.amsterdam/u/${handle}`;
  // iOS pageSheet heeft een ingebouwde drag-handle bovenin + swipe-down
  // dismiss. Op Android valt 't terug op een fullscreen modal — daar
  // dient de losse close-knop voor.
  return (
    <View style={[styles.qrSheet, { backgroundColor: roles.bg }]}>
      {/* Drag-handle: zichtbare hint dat je 'm naar beneden kunt vegen.
          Op iOS zit hier nog een UIKit-handle bovenop maar deze maakt
          'm extra leesbaar; op Android is dit de enige indicatie. */}
      <View style={styles.qrDragHandleWrap}>
        <View
          style={[
            styles.qrDragHandle,
            { backgroundColor: roles.fgPlaceholder },
          ]}
        />
      </View>

      <View style={styles.qrBody}>
        <View
          style={[
            styles.qrCard,
            { backgroundColor: isNacht ? palette.ink : palette.paper3 },
          ]}
        >
          <QRCode
            value={url}
            size={240}
            color={palette.noir}
            backgroundColor={isNacht ? palette.ink : palette.paper3}
            // High error-correction (~30%) zodat de logo-overlay in
            // het midden geen scan-problemen geeft.
            ecl="H"
          />
          {/* Andreas-X als logo-overlay. Centreren via inset+flex —
              dat is robuuster dan margin-half. Dark mode: zwart vierkant
              met acid-X. Light mode: cream vierkant met red-X. */}
          <View pointerEvents="none" style={styles.qrLogoOverlay}>
            <View
              style={[
                styles.qrLogoBg,
                { backgroundColor: isNacht ? palette.noir : palette.paper3 },
              ]}
            >
              <Cross size={36} thickness={10} color={roles.accent} />
            </View>
          </View>
        </View>
        <Text style={[styles.qrName, { color: roles.fg }]}>{name}</Text>
        <Text style={[styles.qrHandle, { color: roles.fgMuted }]}>
          @{handle}
        </Text>
        <Text style={[styles.qrLead, { color: roles.fgMuted }]}>
          Scan to connect.
        </Text>
      </View>
    </View>
  );
}

function PrivacySection({
  me,
  onUpdated,
}: {
  me: ApiMe;
  onUpdated: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';

  // Optimistische lokale state — voor snappy switch-animatie. Server-call
  // komt erna; bij fout rollen we terug en tonen we niets bijzonders
  // (de switch springt simpelweg terug).
  const [savesPrivate, setSavesPrivate] = useState(
    me.savesVisibility === 'private'
  );
  const [discoverable, setDiscoverable] = useState(me.discoverable);

  useEffect(() => {
    setSavesPrivate(me.savesVisibility === 'private');
    setDiscoverable(me.discoverable);
  }, [me.savesVisibility, me.discoverable]);

  const trackOn = roles.accent;
  const trackOff = isNacht ? '#2a2a2d' : palette.paper;
  const thumb = isNacht ? palette.ink : palette.paper3;

  const onSavesToggle = async (next: boolean) => {
    const prev = savesPrivate;
    setSavesPrivate(next);
    try {
      await updateMe({ savesVisibility: next ? 'private' : 'friends' });
      onUpdated();
    } catch {
      setSavesPrivate(prev);
    }
  };

  const onDiscoverableToggle = async (next: boolean) => {
    const prev = discoverable;
    setDiscoverable(next);
    try {
      await updateMe({ discoverable: next });
      onUpdated();
    } catch {
      setDiscoverable(prev);
    }
  };

  return (
    <>
      <SectionHead label="Privacy" />
      <View style={styles.privacyWrap}>
        <View style={styles.privacyRow}>
          <View style={styles.privacyBody}>
            <Text style={[styles.privacyLabel, { color: roles.fg }]}>
              Vrienden zien mijn opgeslagen events
            </Text>
            <Text style={[styles.privacySub, { color: roles.fgMuted }]}>
              Uit zetten verbergt jouw saves bij vrienden in friend-pills en op
              je profiel.
            </Text>
          </View>
          <Switch
            // value=true betekent "vrienden mogen het zien" (sluit aan
            // bij de label-richting); intern is dat savesVisibility =
            // 'friends'.
            value={!savesPrivate}
            onValueChange={(v) => onSavesToggle(!v)}
            trackColor={{ true: trackOn, false: trackOff }}
            thumbColor={thumb}
            ios_backgroundColor={trackOff}
          />
        </View>
        <View style={[styles.privacyDivider, { backgroundColor: roles.bgChip }]} />
        <View style={styles.privacyRow}>
          <View style={styles.privacyBody}>
            <Text style={[styles.privacyLabel, { color: roles.fg }]}>
              Vindbaar via zoeken
            </Text>
            <Text style={[styles.privacySub, { color: roles.fgMuted }]}>
              Anderen kunnen jou vinden via @handle. Uit betekent dat alleen
              mensen die jij toevoegt vrienden met je kunnen worden.
            </Text>
          </View>
          <Switch
            value={discoverable}
            onValueChange={onDiscoverableToggle}
            trackColor={{ true: trackOn, false: trackOff }}
            thumbColor={thumb}
            ios_backgroundColor={trackOff}
          />
        </View>
      </View>
    </>
  );
}

function PendingRow({ user }: { user: ApiFriendRequest }) {
  const roles = useRoles();
  const removeFriend = useRemoveFriend();

  const onCancel = () => {
    const firstName = user.name.split(' ')[0] || `@${user.handle ?? ''}`;
    Alert.alert(
      'Verzoek terugtrekken?',
      `${firstName} krijgt geen melding hierover.`,
      [
        { text: 'Annuleer', style: 'cancel' },
        {
          text: 'Terugtrekken',
          style: 'destructive',
          onPress: () => removeFriend.mutate(user.id),
        },
      ]
    );
  };

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
      <Pressable
        onPress={onCancel}
        disabled={removeFriend.isPending}
        hitSlop={6}
        style={[
          styles.twinBtn,
          {
            borderColor: roles.bgChip,
            opacity: removeFriend.isPending ? 0.5 : 1,
          },
        ]}
      >
        <Cross size={14} thickness={2.6} color={roles.fgMuted} />
      </Pressable>
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
  loadingRoot: { alignItems: 'center', justifyContent: 'center' },

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
    fontSize: 14.5,
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
  profileActions: {
    flexDirection: 'column',
    alignSelf: 'stretch',
    gap: 8,
    marginTop: 16,
  },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 999,
    borderWidth: 1,
  },
  editBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
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
    fontSize: 14.5,
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
    fontSize: 13.5,
    lineHeight: 17.5,
    paddingHorizontal: 22,
    paddingVertical: 8,
  },

  // QR sheet (gepresenteerd als iOS pageSheet)
  qrSheet: { flex: 1 },
  qrDragHandleWrap: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 8,
  },
  qrDragHandle: {
    width: 44,
    height: 5,
    borderRadius: 2.5,
    opacity: 0.6,
  },
  qrCloseBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrTopTitle: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
    textAlign: 'center',
  },
  qrBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 10,
  },
  qrCard: {
    padding: 20,
    borderRadius: 18,
    marginBottom: 12,
    position: 'relative',
  },
  qrLogoOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrLogoBg: {
    width: 64,
    height: 64,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrName: {
    fontFamily: fontFamily.display,
    fontSize: 26,
    letterSpacing: -0.65,
    lineHeight: 26 * 1.02,
    textAlign: 'center',
  },
  qrHandle: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  qrLead: {
    fontFamily: fontFamily.body,
    fontSize: 13.5,
    lineHeight: 18.5,
    textAlign: 'center',
    marginTop: 8,
  },

  // Privacy
  privacyWrap: { paddingHorizontal: 22, paddingTop: 4 },
  privacyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
  },
  privacyBody: { flex: 1 },
  privacyLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.14,
  },
  privacySub: {
    fontFamily: fontFamily.body,
    fontSize: 12.5,
    lineHeight: 17,
    marginTop: 4,
  },
  privacyDivider: { height: StyleSheet.hairlineWidth },

  // Uitloggen — full-width pill onderaan, zelfde stijl als profile-actions
  logoutWrap: {
    paddingHorizontal: 22,
    paddingTop: 28,
    paddingBottom: 8,
  },

  // Account / DEV (legacy, devWrap nu alleen voor sectie-spacing)
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

