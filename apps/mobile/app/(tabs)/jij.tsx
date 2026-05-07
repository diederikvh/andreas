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
  AppState,
  KeyboardAvoidingView,
  Linking,
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
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiMe } from '@/lib/api';
import { getMe, updateMe, uploadAvatar } from '@/lib/api';
import { authClient, useSession } from '@/lib/authClient';
import {
  type LocalePreference,
  useLocalePreference,
  useLocaleStore,
  useT,
} from '@/lib/i18n';
import {
  Notifications,
  registerForPushNotificationsAsync,
} from '@/lib/push';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

type Stage = 'phone' | 'code' | 'profile' | 'authed';

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export default function Jij() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const t = useT();
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
      setError(t('Vul een geldig nummer in.', 'Enter a valid phone number.'));
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.phoneNumber.sendOtp({
      phoneNumber: phone,
    });
    setBusy(false);
    if (err) {
      setError(err.message ?? t('Versturen mislukt.', 'Sending failed.'));
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStageOverride('code');
    setTimeout(() => codeRef.current?.focus(), 120);
  };

  const verifyCode = async () => {
    if (code.length !== 6) {
      setError(t('Code is 6 cijfers.', 'Code is 6 digits.'));
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
      setError(err.message ?? t('Code klopt niet.', 'Code is incorrect.'));
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
      setError(t('Naam is verplicht.', 'Name is required.'));
      return;
    }
    if (!HANDLE_RE.test(handle)) {
      setError(
        t(
          'Handle: 3–20 kleine letters, cijfers of underscore.',
          'Handle: 3–20 lowercase letters, digits or underscore.'
        )
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateMe({ name: trimmedName, handle });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refetchMe();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t('Opslaan mislukt.', 'Saving failed.')
      );
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
      setError(
        t(
          'Geen toegang tot foto-bibliotheek.',
          'No access to photo library.'
        )
      );
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
      setError(
        e instanceof Error
          ? e.message
          : t('Upload mislukt.', 'Upload failed.')
      );
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
            {stage === 'phone'
              ? t('Inloggen · stap 1/2', 'Sign in · step 1/2')
              : t('Inloggen · stap 2/2', 'Sign in · step 2/2')}
          </Text>
          <Text style={[styles.title, { color: roles.fg }]}>
            {stage === 'phone'
              ? t('Wat is je\nnummer?', 'What’s your\nnumber?')
              : t('Vul de code\nuit de SMS.', 'Enter the code\nfrom the SMS.')}
          </Text>

          {stage === 'phone' && (
            <Text style={[styles.lead, { color: roles.fgRead }]}>
              {t(
                'Met een account heb je je eigen Andreas. Je bewaart je planning, voegt vrienden toe om samen op pad te gaan en volgt de venues die je niet wilt missen.\n\nGeen wachtwoord. Eén SMS-code op je nummer is genoeg.',
                'With an account you get your own Andreas. Save your plans, add friends to head out together, and follow the venues you don’t want to miss.\n\nNo password. One SMS code on your number is enough.'
              )}
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
                {t(
                  'Je krijgt een SMS met een 6-cijferige code.',
                  'You’ll receive an SMS with a 6-digit code.'
                )}
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
                  {t('Verkeerd nummer? Terug.', 'Wrong number? Back.')}
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
                ? t('Bezig…', 'Working…')
                : stage === 'phone'
                  ? t('Stuur code', 'Send code')
                  : t('Inloggen', 'Sign in')}
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
            {isEditing
              ? t('Profiel bewerken', 'Edit profile')
              : t('Even kennismaken', 'Quick intro')}
          </Text>
          <Text style={[styles.title, { color: roles.fg }]}>
            {isEditing
              ? t('Pas je naam\nof handle aan.', 'Update your name\nor handle.')
              : t('Hoe heet je\neigenlijk?', 'What’s your\nname?')}
          </Text>

          <View style={styles.fieldGroup}>
            <Text style={[styles.label, { color: roles.fgMuted }]}>
              {t('NAAM', 'NAME')}
            </Text>
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
                placeholder={t('bv. Harry Styles', 'e.g. Harry Styles')}
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
              {t(
                '3–20 kleine letters, cijfers of underscore. Vrienden vinden je hierop.',
                '3–20 lowercase letters, digits or underscore. This is how friends find you.'
              )}
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
                ? t('Bezig…', 'Working…')
                : isEditing
                  ? t('Opslaan', 'Save')
                  : t('Doorgaan', 'Continue')}
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
                {t('Annuleren', 'Cancel')}
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
    me?.name && !me.name.startsWith('+') ? me.name : t('Jij', 'You');
  const displayHandle = me?.handle ? `@${me.handle}` : t('NIEUW', 'NEW');

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
                  {t('Mijn QR', 'My QR')}
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
                {t('Scan QR', 'Scan QR')}
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
                {t('Vrienden zoeken', 'Find friends')}
              </Text>
            </Pressable>
            <Pressable
              onPress={onEditProfile}
              style={[styles.editBtn, { borderColor: roles.bgChip }]}
            >
              <Text style={[styles.editBtnText, { color: roles.fgMuted }]}>
                {t('Bewerk profiel', 'Edit profile')}
              </Text>
            </Pressable>
          </View>
          {error && <Text style={styles.error}>{error}</Text>}
        </View>

        {me && <NotificationsSection />}
        {me && <PrivacySection me={me} onUpdated={refetchMe} />}
        <LanguageSection />

        <View style={styles.logoutWrap}>
          <Pressable
            onPress={onLogout}
            style={[styles.editBtn, { borderColor: roles.bgChip }]}
          >
            <Text style={[styles.editBtnText, { color: roles.fgMuted }]}>
              {t('Uitloggen', 'Log out')}
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
  const t = useT();
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
          {t('Scan om te connecten.', 'Scan to connect.')}
        </Text>
      </View>
    </View>
  );
}

function LanguageSection() {
  const roles = useRoles();
  const t = useT();
  const preference = useLocalePreference();
  const setPreference = useLocaleStore((s) => s.setPreference);

  const options: { value: LocalePreference; label: string }[] = [
    { value: 'auto', label: t('Automatisch', 'Automatic') },
    { value: 'nl', label: 'Nederlands' },
    { value: 'en', label: 'English' },
  ];

  return (
    <>
      <SectionHead label={t('Taal', 'Language')} />
      <View style={styles.privacyWrap}>
        <View style={styles.privacyRow}>
          <View style={styles.privacyBody}>
            <Text style={[styles.privacyLabel, { color: roles.fg }]}>
              {t('Taal van de app', 'App language')}
            </Text>
            <Text style={[styles.privacySub, { color: roles.fgMuted }]}>
              {t(
                'Automatisch volgt de taal van je toestel — Nederlands of Engels.',
                'Automatic follows your device language — Dutch or English.'
              )}
            </Text>
          </View>
        </View>
        <View style={styles.languageRow}>
          {options.map((opt) => {
            const active = preference === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setPreference(opt.value)}
                style={[
                  styles.languageBtn,
                  {
                    borderColor: active ? roles.accent : roles.bgChip,
                    backgroundColor: active ? roles.accent : 'transparent',
                  },
                ]}
              >
                <Text
                  style={[
                    styles.languageBtnText,
                    { color: active ? roles.onAccent : roles.fgMuted },
                  ]}
                >
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </>
  );
}

function NotificationsSection() {
  const roles = useRoles();
  const t = useT();
  const [status, setStatus] = useState<
    'granted' | 'denied' | 'undetermined' | 'loading'
  >('loading');
  const [busy, setBusy] = useState(false);

  // Refresh bij mount + bij elke return-naar-foreground (de gebruiker
  // kan in iOS-Settings de toggle hebben omgezet; we willen de juiste
  // status tonen zodra ze terug zijn).
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const { status: s } = await Notifications.getPermissionsAsync();
      if (!mounted) return;
      setStatus(
        s === 'granted'
          ? 'granted'
          : s === 'denied'
            ? 'denied'
            : 'undetermined'
      );
    };
    refresh();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh();
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const onPress = async () => {
    if (busy) return;
    if (status === 'undetermined') {
      // Eerste keer: vraag direct permissie + registreer token.
      setBusy(true);
      const token = await registerForPushNotificationsAsync();
      setBusy(false);
      const { status: s } = await Notifications.getPermissionsAsync();
      setStatus(
        s === 'granted'
          ? 'granted'
          : s === 'denied'
            ? 'denied'
            : 'undetermined'
      );
      if (!token && s !== 'granted') {
        // Gebruiker heeft 'm net geweigerd — wijs naar Settings als
        // ze van gedachten veranderen.
        Linking.openSettings();
      }
      return;
    }
    // granted of denied: alleen via OS-Settings te wijzigen.
    Linking.openSettings();
  };

  const label =
    status === 'granted'
      ? t('Aan', 'On')
      : status === 'denied'
        ? t('Uit', 'Off')
        : status === 'undetermined'
          ? t('Niet ingesteld', 'Not set')
          : '…';
  const cta =
    status === 'granted'
      ? t('Wijzig in instellingen', 'Change in settings')
      : status === 'denied'
        ? t('Open instellingen', 'Open settings')
        : status === 'undetermined'
          ? t('Aanzetten', 'Turn on')
          : '…';

  return (
    <>
      <SectionHead label={t('Notificaties', 'Notifications')} />
      <View style={styles.privacyWrap}>
        <View style={styles.privacyRow}>
          <View style={styles.privacyBody}>
            <Text style={[styles.privacyLabel, { color: roles.fg }]}>
              {t(
                'Vriend-aanvragen, uitnodigingen en accepts',
                'Friend requests, invites and accepts'
              )}
            </Text>
            <Text style={[styles.privacySub, { color: roles.fgMuted }]}>
              {t(
                `Status: ${label}. Alleen pings bij persoonlijke acties — geen algoritmische pushes.`,
                `Status: ${label}. Only pings for personal actions — no algorithmic pushes.`
              )}
            </Text>
          </View>
          <Pressable
            onPress={onPress}
            disabled={status === 'loading' || busy}
            style={[
              styles.notifBtn,
              {
                borderColor: roles.bgChip,
                opacity: status === 'loading' || busy ? 0.4 : 1,
              },
            ]}
          >
            <Text style={[styles.notifBtnText, { color: roles.fgMuted }]}>
              {cta}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
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
  const t = useT();

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
      <SectionHead label={t('Privacy', 'Privacy')} />
      <View style={styles.privacyWrap}>
        <View style={styles.privacyRow}>
          <View style={styles.privacyBody}>
            <Text style={[styles.privacyLabel, { color: roles.fg }]}>
              {t(
                'Vrienden zien mijn opgeslagen events',
                'Friends see my saved events'
              )}
            </Text>
            <Text style={[styles.privacySub, { color: roles.fgMuted }]}>
              {t(
                'Uit zetten verbergt jouw saves bij vrienden in friend-pills en op je profiel.',
                'Turning off hides your saves from friends in friend-pills and on your profile.'
              )}
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
              {t('Vindbaar via zoeken', 'Findable via search')}
            </Text>
            <Text style={[styles.privacySub, { color: roles.fgMuted }]}>
              {t(
                'Anderen kunnen jou vinden via @handle. Uit betekent dat alleen mensen die jij toevoegt vrienden met je kunnen worden.',
                'Others can find you via @handle. Off means only people you add can become friends with you.'
              )}
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
  notifBtn: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notifBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    letterSpacing: -0.12,
  },
  languageRow: {
    flexDirection: 'row',
    gap: 6,
    paddingTop: 4,
    paddingBottom: 8,
  },
  languageBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  languageBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 12.5,
    letterSpacing: -0.12,
  },

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

