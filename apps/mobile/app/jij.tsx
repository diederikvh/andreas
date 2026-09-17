import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
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
  Text,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { softTap } from '@/lib/haptics';
import { BackButton } from '@/components/BackButton';
import { Cross } from '@/components/Cross';
import {
  SettingsAction,
  SettingsChoice,
  SettingsGroup,
  SettingsSwitch,
} from '@/components/SettingsList';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiMe } from '@/lib/api';
import { getMe, updateMe, uploadAvatar } from '@/lib/api';
import { authClient, useIsRegistered, useSession } from '@/lib/authClient';
import {
  type LocalePreference,
  useLocale,
  useLocalePreference,
  useLocaleStore,
  useT,
} from '@/lib/i18n';
import { useMyMirror, type Mirror } from '@/lib/queries';
import {
  Notifications,
  registerForPushNotificationsAsync,
} from '@/lib/push';
import { useMode, useModeStore, useRoles } from '@/store/mode';
import { fontFamily, palette, type Mode } from '@/theme/tokens';

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
  // Een anonieme sessie telt hier niet als "ingelogd". Sinds
  // anoniem-eerst heeft iedereen een sessie zodra de app opent, dus
  // `Boolean(session)` zegt alleen dat er een identiteit is — niet dat
  // er een persoon aan hangt. Dit scherm gaat over die persoon.
  const registered = useIsRegistered();
  const stageUnknown = sessionPending || (registered && me === undefined);
  const authedAndOnboarded = Boolean(registered && me?.handle);

  // Stage uit sessie + me afgeleid; tijdelijke override voor de
  // "code"-stap die geen server-state heeft.
  const sessionStage: Stage = !registered
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

  // Onboarding-flow: index.tsx pusht ons naar /jij?onboarding=1 ná de
  // nacht/dag-keuze. Zodra de phone-OTP-profile-flow heeft geleid tot
  // een handle, markeren we onboarding compleet en sturen naar /avond.
  const params = useLocalSearchParams<{ onboarding?: string }>();
  const isOnboarding = params.onboarding === '1';
  useEffect(() => {
    if (!isOnboarding) return;
    if (sessionStage === 'authed') {
      useModeStore.getState().completeOnboarding();
      router.replace('/avond');
    }
  }, [isOnboarding, sessionStage]);

  // Auth-form state. `phoneInput` is wat de gebruiker typt of plakt
  // — vrij formaat (+31 6, 06, 0031, +1 555, etc). Bij submit
  // normaliseren we naar E.164 voor better-auth/MessageBird.
  const [phoneInput, setPhoneInput] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [handleTouched, setHandleTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<TextInput>(null);
  const phone = normalizePhone(phoneInput);

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
    if (!phone) {
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
    setPhoneInput('');
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

  /**
   * Inloggen afbreken. Je houdt je anonieme identiteit, dus alles wat je
   * al bewaard hebt blijft staan — er valt niks te verliezen door hier
   * weg te lopen. Kwam je via de avatar, dan ga je gewoon terug; kwam je
   * hier direct binnen (deeplink), dan naar Vandaag.
   */
  const onCancelSignIn = () => {
    setError(null);
    setCode('');
    setStageOverride(null);
    if (router.canGoBack()) router.back();
    else router.replace('/avond' as never);
  };

  const [avatarUploading, setAvatarUploading] = useState(false);
  const onPickAvatar = async () => {
    if (avatarUploading) return;
    /*
     * Geen toestemming vragen. Dat lijkt slordig maar is het tegendeel:
     * sinds iOS 14 draait de fotokiezer buiten de app, en krijgen wij
     * alleen wat jij aanwijst. Toestemming vrágen zet je op "beperkte
     * toegang" zodra je ooit "Selecteer foto's" koos, en dán toont iOS
     * een andere, krappe kiezer waarin één tik niets doet en de
     * bevestigknop achter de Dynamic Island valt. Precies de bug die
     * Diederik zag: je kon geen profielfoto meer kiezen.
     */
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      // Uitsnede blijft: je wil zelf kunnen bepalen wat er in het rondje
      // staat. Hij was er even uit omdat ik dacht dat het daaraan lag —
      // dat was het niet, de CDN serveerde je oude foto.
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      allowsMultipleSelection: false,
      selectionLimit: 1,
    });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) {
      // Kwam de kiezer terug zonder foto, zeg dat dan. Een scherm dat
      // niets doet is het ergste antwoord.
      setError(t('Geen foto ontvangen.', 'No photo received.'));
      return;
    }
    setAvatarUploading(true);
    setError(null);
    try {
      const updated = await uploadAvatar({
        uri: asset.uri,
        mimeType: asset.mimeType ?? 'image/jpeg',
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refetchMe();
    } catch (e) {
      // Een melding, niet alleen een regeltje onder je naam: dit is een
      // handeling die je bewust startte en die dan mislukt.
      Alert.alert(
        t('Foto niet opgeslagen', 'Photo not saved'),
        e instanceof Error ? e.message : String(e),
      );
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
        <SpinningCross size={28} color={roles.fgPlaceholder} />
        {/* Close-btn alleen tonen als we al weten dat er een sessie is —
            sessionPending zonder sessie is effectief 'niet ingelogd' en
            heeft geen zinvolle 'terug'-bestemming. */}
        {!isOnboarding && session && <ModalCloseBtn />}
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
            paddingTop: insets.top + 56,
            paddingBottom: insets.bottom + 96,
            paddingHorizontal: 22,
          }}
        >
          <Text style={[styles.kicker, { color: roles.accent }]}>
            {stage === 'phone'
              ? t('Stap 1/2', 'Step 1/2')
              : t('Stap 2/2', 'Step 2/2')}
          </Text>
          <Text style={[styles.title, { color: roles.fg }]}>
            {t('Maak een account', 'Create an account')}
          </Text>

          {stage === 'phone' && (
            <Text style={[styles.lead, { color: roles.fgRead }]}>
              {t(
                'Dan gaat het pas echt leven. Zie waar je vrienden heen gaan, nodig ze uit voor wat jij gevonden hebt, en neem je smaak mee als je van telefoon wisselt.',
                'That’s when it comes alive. See where your friends are going, invite them to what you found, and take your taste with you when you switch phones.'
              )}
            </Text>
          )}

          {stage === 'phone' ? (
            <View style={styles.fieldGroup}>
              <Text style={[styles.kicker, { color: roles.accent }]}>
                {t('TELEFOON', 'PHONE')}
              </Text>
              <View
                style={[
                  styles.field,
                  styles.fieldRow,
                  authFieldStyle(isNacht),
                ]}
              >
                <TextInput
                  key="phone"
                  value={phoneInput}
                  onChangeText={(next) =>
                    setPhoneInput(next.replace(/[^0-9+ ]/g, ''))
                  }
                  placeholder={t(
                    '+31 6 12 34 56 78  /  06 12 34 56 78',
                    '+31 6 12 34 56 78  /  +1 555 123 4567'
                  )}
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
            </View>
          ) : (
            <View style={styles.fieldGroup}>
              <Text style={[styles.kicker, { color: roles.accent }]}>
                {t('SMS-CODE', 'SMS CODE')}
              </Text>
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
            </View>
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
        {/* Sinds anoniem-eerst is stoppen wél een geldige uitkomst: je
            houdt gewoon je anonieme identiteit en alles blijft werken.
            Eerder was er zonder sessie nergens om heen te gaan, en toen
            was afsluiten dus geen optie. */}
        <Pressable
          onPress={onCancelSignIn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Sluiten"
          style={[
            styles.signInCloseBtn,
            {
              top: insets.top + 12,
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            },
          ]}
        >
          <Ionicons name="close" size={20} color={roles.fg} />
        </Pressable>
      </KeyboardAvoidingView>
    );
  }

  // ─── Profile-onboarding view ────────────────────────────────────────

  // Stage 'profile' splitsen in twee gevallen:
  //  - Onboarding (geen handle nog): vol scherm, push-style.
  //  - Bewerken bestaand profiel: Modal-overlay over de authed-view zodat
  //    /jij zelf gewoon een normaal scherm blijft.
  const isEditingExisting = stage === 'profile' && Boolean(me?.handle);
  const isOnboardingProfile = stage === 'profile' && !me?.handle;
  const onChangeName = (next: string) => {
    setName(next);
    if (!handleTouched) setHandle(deriveHandle(next));
  };
  const onChangeHandle = (next: string) => {
    setHandleTouched(true);
    setHandle(next.toLowerCase().replace(/[^a-z0-9_]/g, ''));
  };

  // Gedeelde JSX van het profiel-formulier — gebruikt in beide rendering-
  // paths (onboarding full-screen + bewerken-modal).
  const editProfileBody = (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: roles.bg }]}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          // In de bewerk-modal is dit een pageSheet: die begint al ónder
          // de statusbalk, dus `insets.top` (van het scherm eronder)
          // erbij optellen duwde de kop een halve statusbalk naar
          // beneden. Alleen de onboarding-variant vult wél het scherm.
          paddingTop: isEditingExisting ? 34 : insets.top + 56,
          paddingBottom: insets.bottom + 96,
          paddingHorizontal: 22,
        }}
      >
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: roles.fg, flex: 1 }]}>
            {isEditingExisting
              ? t('Profiel', 'Profile')
              : t('Hoe heet je\neigenlijk?', 'What’s your\nname?')}
          </Text>
          {isEditingExisting ? (
            <Pressable onPress={saveProfile} disabled={busy} hitSlop={10}>
              <Text
                style={[
                  styles.titleSave,
                  { color: busy ? roles.fgPlaceholder : roles.accent },
                ]}
              >
                {busy ? t('Bezig…', 'Saving…') : t('Bewaar', 'Save')}
              </Text>
            </Pressable>
          ) : null}
        </View>

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
              placeholder={t('bv. Johan Cruijff', 'e.g. Johan Cruijff')}
              placeholderTextColor={roles.fgPlaceholder}
              autoFocus={isOnboardingProfile}
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
              placeholder="johan14"
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

        {isEditingExisting ? null : (
        <Pressable
          onPress={saveProfile}
          disabled={busy}
          style={[
            styles.actionBtn,
            {
              backgroundColor: isNacht ? palette.acid : palette.red,
              marginTop: 16,
              opacity: busy ? 0.5 : 1,
            },
          ]}
        >
          <Text
            style={[
              styles.actionBtnText,
              { color: isNacht ? palette.noir : palette.paper3 },
            ]}
          >
            {busy
              ? t('Bezig…', 'Working…')
              : isEditingExisting
                ? t('Opslaan', 'Save')
                : t('Doorgaan', 'Continue')}
          </Text>
        </Pressable>
        )}
        {/* Instellingen — alleen zichtbaar als de gebruiker een
            bestaand profiel bewerkt (niet tijdens onboarding-eerste-
            keer-vullen). Marge-cancel om de paddingHorizontal van de
            ScrollView te neutraliseren: de blokken zetten hun eigen
            inspringing, zoals Instellingen dat doet. */}
        {isEditingExisting && me && (
          <View style={{ marginHorizontal: -22, marginTop: 24 }}>
            <AppearanceSection />
            <NotificationsSection me={me} onUpdated={refetchMe} />
            <ReminderScopeSection me={me} onUpdated={refetchMe} />
            <PrivacySection me={me} onUpdated={refetchMe} />
            <LanguageSection />
            <CreditsSection />
          </View>
        )}
      </ScrollView>
      {isEditingExisting ? (
        Platform.OS === 'ios' ? (
          // iOS pageSheet: visuele drag-handle bovenaan, swipe-down
          // dismist het sheet native.
          <View
            pointerEvents="none"
            style={[styles.modalDragWrap, { top: 8 }]}
          >
            <View
              style={[
                styles.modalDragHandle,
                { backgroundColor: roles.bgChip },
              ]}
            />
          </View>
        ) : (
          // Android: expliciete sluit-knop links, 36×36, zelfde stijl
          // als invite-modal voor consistentie.
          <Pressable
            onPress={onCancelProfileEdit}
            hitSlop={8}
            accessibilityLabel="Sluiten"
            style={[
              styles.modalCloseLeft,
              {
                top: insets.top + 8,
                backgroundColor: isNacht ? palette.noir2 : palette.paper2,
              },
            ]}
          >
            <Cross size={14} thickness={2.6} color={roles.fg} />
          </Pressable>
        )
      ) : !isOnboarding ? (
        <ModalCloseBtn />
      ) : null}
    </KeyboardAvoidingView>
  );

  if (isOnboardingProfile) {
    return editProfileBody;
  }

  // ─── Authed Jij ─────────────────────────────────────────────────────

  const displayName =
    me?.name && !me.name.startsWith('+') ? me.name : t('Jij', 'You');
  const displayHandle = me?.handle ? `@${me.handle}` : t('NIEUW', 'NEW');

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      {/* Top-left back-button — /jij is een normaal pushed scherm, niet
          meer een modal. iOS swipe-from-edge + Android hardware-back
          werken ook, deze knop maakt de affordance zichtbaar. */}
      <View
        style={{
          position: 'absolute',
          top: insets.top + 8,
          left: 18,
          zIndex: 30,
        }}
      >
        <BackButton size={36} />
      </View>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          // /jij is een pushed scherm (geen modal-presentation meer),
          // dus de safe-area-top is onze eigen verantwoordelijkheid.
          // BackButton zit op insets.top + 8 (36px hoog) → content
          // begint daaronder met extra adem-pauze.
          paddingTop: insets.top + 56,
          paddingBottom: insets.bottom + 96,
        }}
      >
        {/* Je eigen QR: hiermee voegt iemand je toe zonder te typen.
            Alleen als je een handle hebt — zonder handle wijst hij
            nergens heen. */}
        {me?.handle ? (
          <View style={styles.qrBlock}>
            <View
              style={[
                styles.qrTile,
                { backgroundColor: isNacht ? palette.ink : palette.paper3 },
              ]}
            >
              <QRCode
                value={`https://andreas.amsterdam/u/${me.handle}`}
                size={132}
                color={palette.noir}
                backgroundColor={isNacht ? palette.ink : palette.paper3}
                ecl="H"
              />
            </View>
          </View>
        ) : null}

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
          {error && <Text style={styles.error}>{error}</Text>}
        </View>

        {/* Wat je hier komt doen, in de volgorde waarin je het doet.
            De statistieken stonden hier uitgeklapt; dat is lezen, geen
            doen, en het duwde alles naar beneden. */}
        {me ? (
          <View style={styles.profileMenu}>
            <ProfileRow
              icon="pencil"
              label={t('Bewerk profiel', 'Edit profile')}
              onPress={onEditProfile}
            />
            <ProfileRow
              icon="qr-code-outline"
              label={t('Scan QR-code', 'Scan QR code')}
              onPress={() => router.push('/add-friend?scan=1' as never)}
            />
            <ProfileRow
              icon="person-add-outline"
              label={t('Verbind met vrienden', 'Connect with friends')}
              onPress={() => router.push('/add-friend' as never)}
            />
            <ProfileRow
              icon="stats-chart-outline"
              label={t('Mijn statistieken', 'My statistics')}
              onPress={() => router.push('/statistieken' as never)}
            />
          </View>
        ) : null}

        {/* Logout zit visueel onder een divider om 'm écht van de
            rest van de instellingen te scheiden — laatste actie op de
            pagina, hier wil je niet per ongeluk op tikken. Stijl
            matched de andere solid-bg buttons. */}
        <View
          style={[styles.logoutDivider, { backgroundColor: roles.bgChip }]}
        />
        <View style={styles.logoutWrap}>
          <Pressable
            onPress={onLogout}
            style={[
              styles.actionBtn,
              { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Ionicons
              name="log-out-outline"
              size={16}
              color={roles.fg}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.actionBtnText, { color: roles.fg }]}>
              {t('Uitloggen', 'Log out')}
            </Text>
          </Pressable>
        </View>

        {__DEV__ && (
          <View style={styles.logoutWrap}>
            <Pressable
              onPress={async () => {
                // Dev-shortcut: log uit + reset onboarding-vlag + ga
                // naar /index zodat je de hele flow opnieuw doorloopt.
                // Alleen zichtbaar in __DEV__-builds.
                try {
                  await authClient.signOut();
                } catch {
                  // signOut faalt als 'r geen sessie is — geen probleem
                }
                useModeStore.setState({
                  hasOnboarded: false,
                  hasSeenFilterHint: false,
                });
                queryClient.removeQueries();
                router.replace('/');
              }}
              style={[styles.editBtn, { borderColor: roles.bgChip }]}
            >
              <Text style={[styles.editBtnText, { color: roles.fgMuted }]}>
                {t('[DEV] Reset onboarding', '[DEV] Reset onboarding')}
              </Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
      {/* Edit-profile modal-overlay — wordt gepresenteerd als pageSheet
          op iOS (swipe-down dismisses) en als full-screen Modal op
          Android (hardware-back triggert onRequestClose → close). */}
      <Modal
        visible={isEditingExisting}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={onCancelProfileEdit}
      >
        {editProfileBody}
      </Modal>
    </View>
  );
}

/**
 * Normaliseer wat de gebruiker typt of plakt naar E.164 (+CC + digits).
 *
 *  "+31 6 12345678"  → "+31612345678"
 *  "06 12 34 56 78"  → "+31612345678"   (NL aanname bij leidende 0)
 *  "0031612345678"   → "+31612345678"   (00-prefix → +)
 *  "+1 555 123 4567" → "+15551234567"
 *
 * Returns null als niet te normaliseren.
 */
/** Eén regel in het profielmenu. Zelfde vorm als de rijen in Meer: dit
    zijn ingangen, geen instellingen. */
function ProfileRow({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={() => {
        softTap();
        onPress();
      }}
      style={[styles.profileRow, { backgroundColor: roles.bgChip }]}
    >
      <Ionicons name={icon} size={22} color={roles.accent} />
      <Text style={[styles.profileRowLabel, { color: roles.fg }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={roles.fgPlaceholder} />
    </Pressable>
  );
}

function normalizePhone(input: string): string | null {
  const trimmed = input.replace(/[\s\-()]/g, '');
  if (trimmed.length === 0) return null;
  let normalized: string;
  if (trimmed.startsWith('+')) {
    normalized = `+${trimmed.slice(1).replace(/\D/g, '')}`;
  } else if (trimmed.startsWith('00')) {
    normalized = `+${trimmed.slice(2).replace(/\D/g, '')}`;
  } else if (trimmed.startsWith('0')) {
    // NL-gewoonte: 06… of 020… → +31
    normalized = `+31${trimmed.slice(1).replace(/\D/g, '')}`;
  } else {
    // Geen + en geen 0-prefix: nemen aan dat de gebruiker een NL
    // nummer zonder leading 0 typte (zoals het oude veld accepteerde).
    normalized = `+31${trimmed.replace(/\D/g, '')}`;
  }
  // Sanity: minimaal +CC + 7 digits, maximaal 15 digits totaal (E.164).
  if (!/^\+\d{8,15}$/.test(normalized)) return null;
  return normalized;
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

/**
 * Sluit-knop voor /jij in modal-presentatie. Absoluut gepositioneerd
 * rechtsboven; iOS-modals zitten al onder de status-bar (top: 12),
 * Android-modals moeten safe-area aanhouden (top: insets.top + 12).
 */
function ModalCloseBtn({ onPress }: { onPress?: () => void }) {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const top = (Platform.OS === 'android' ? insets.top : 0) + 12;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Sluiten"
      onPress={onPress ?? (() => router.back())}
      hitSlop={8}
      style={[
        styles.modalCloseBtn,
        {
          top,
          backgroundColor: isNacht ? palette.noir2 : palette.paper2,
          borderColor: isNacht ? '#2a2a2d' : palette.paper,
        },
      ]}
    >
      <Cross size={10} thickness={2.2} color={roles.fg} />
    </Pressable>
  );
}

/** Credits-sectie. Bevat de verplichte TMDb-attribution voor het
    gebruik van de TMDb API onder hun non-commercial licentie. Tekst
    + link, geen logo (TMDb staat "tekst-only" attribution toe).
    Tap → opent TMDb.org. */
const WIJK_LABEL: Record<string, { nl: string; en: string }> = {
  centrum: { nl: 'Centrum', en: 'Centrum' },
  noord: { nl: 'Noord', en: 'Noord' },
  oost: { nl: 'Oost', en: 'Oost' },
  west: { nl: 'West', en: 'West' },
  zuid: { nl: 'Zuid', en: 'Zuid' },
  zuidoost: { nl: 'Zuidoost', en: 'Zuidoost' },
  'nieuw-west': { nl: 'Nieuw-West', en: 'Nieuw-West' },
};

const WEEKDAY_SHORT_NL = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];

const WEEKDAY_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SOURCE_LABEL: Record<string, { nl: string; en: string }> = {
  venue: { nl: 'via venue', en: 'via venue' },
  friend: { nl: 'via vriend', en: 'via friend' },
  search: { nl: 'via zoeken', en: 'via search' },
  'op-gevoel': { nl: 'op gevoel', en: 'on a hunch' },
  avond: { nl: 'avond', en: 'tonight' },
  agenda: { nl: 'agenda', en: 'agenda' },
  kaart: { nl: 'kaart', en: 'map' },
  series: { nl: 'serie', en: 'series' },
  gered: { nl: 'gered', en: 'saved' },
  new: { nl: 'net binnen', en: 'just in' },
  share: { nl: 'gedeeld', en: 'shared' },
  scan: { nl: 'gescand', en: 'scanned' },
  going: { nl: 'via plannen', en: 'via plans' },
  other: { nl: 'anders', en: 'other' },
};

function CreditsSection() {
  const t = useT();
  return (
    <SettingsGroup
      header={t('Bronnen', 'Credits')}
      footer={t(
        'Posters, stills en trailers komen van The Movie Database. Dit product gebruikt de TMDb-API maar is niet door TMDb goedgekeurd of gecertificeerd.',
        'Posters, stills and trailers are powered by The Movie Database. This product uses the TMDb API but is not endorsed or certified by TMDb.'
      )}
    >
      <SettingsAction
        label={t('Film-data', 'Film data')}
        value="The Movie Database"
        onPress={() => void Linking.openURL('https://www.themoviedb.org')}
      />
    </SettingsGroup>
  );
}

function buildIdentitySentence(m: Mirror, locale: 'nl' | 'en'): string | null {
  if (m.totals.saves < 3) return null;
  const venue = m.topVenues[0];
  const genre = m.topGenres[0]?.genre;
  const wijk = m.wijken.find((w) => w.wijk)?.wijk;
  const peakWeekday = [...m.weekday].sort((a, b) => b.count - a.count)[0];
  const allZero = m.weekday.every((d) => d.count === 0);
  const peakWeekdayLabel =
    peakWeekday && !allZero
      ? locale === 'nl'
        ? WEEKDAY_SHORT_NL[peakWeekday.weekday]
        : WEEKDAY_SHORT_EN[peakWeekday.weekday]
      : null;

  const parts: string[] = [];
  if (venue) {
    parts.push(
      locale === 'nl' ? `Vooral op ${venue.name}` : `Mostly at ${venue.name}`
    );
  }
  if (genre) {
    parts.push(locale === 'nl' ? `${genre}` : `${genre}`);
  }
  if (wijk) {
    const label = WIJK_LABEL[wijk]?.[locale] ?? wijk;
    parts.push(locale === 'nl' ? `in ${label}` : `in ${label}`);
  }
  if (peakWeekdayLabel) {
    parts.push(
      locale === 'nl' ? `vaak op ${peakWeekdayLabel}` : `often on ${peakWeekdayLabel}`
    );
  }
  if (parts.length === 0) return null;
  return parts.join(' · ') + '.';
}

/** De persoonlijke spiegel. Staat sinds 13 sep op een eigen scherm
    (`/statistieken`): op je profiel wil je iets dóen, niet lezen. */
export function MirrorSection({ authed }: { authed: boolean }) {
  const t = useT();
  const locale = useLocale();
  const roles = useRoles();
  const { data, isLoading } = useMyMirror({ enabled: authed });
  if (!authed || isLoading || !data) return null;

  const total = data.totals.saves;
  if (total === 0) {
    return (
      <View style={styles.mirrorWrap}>
        <Text style={[styles.privacySub, { color: roles.fgMuted }]}>
          {t(
            'Zodra je events redt, vind je hier je top-venues, genres en plekken.',
            'Once you save events, you’ll find your top venues, genres and places here.'
          )}
        </Text>
      </View>
    );
  }

  const identity = buildIdentitySentence(data, locale);
  const followedCount = data.totals.venuesFollowed;
  const weekdayMax = Math.max(...data.weekday.map((d) => d.count), 1);
  const monthlyMax = Math.max(...data.monthlyTimeline.map((m) => m.count), 1);
  const wijkenTotal = data.wijken.reduce((s, w) => s + w.count, 0);
  const discoveryTotal = data.discovery.reduce((s, d) => s + d.count, 0);

  return (
    <View style={styles.mirrorWrap}>
        {identity && (
          <Text style={[styles.mirrorIdentity, { color: roles.fg }]}>
            {identity}
          </Text>
        )}
        <Text style={[styles.mirrorMeta, { color: roles.fgMuted }]}>
          {t(
            `${total} ${total === 1 ? 'save' : 'saves'} · ${followedCount} ${followedCount === 1 ? 'venue gevolgd' : 'venues gevolgd'}`,
            `${total} ${total === 1 ? 'save' : 'saves'} · following ${followedCount} ${followedCount === 1 ? 'venue' : 'venues'}`
          )}
        </Text>

        {data.topVenues.length > 0 && (
          <MirrorBlock title={t('Top venues', 'Top venues')}>
            <View style={styles.mirrorChipsRow}>
              {data.topVenues.map((v) => (
                <Pressable
                  key={v.id}
                  onPress={() => router.push(`/venue/${v.slug}` as never)}
                  style={[
                    styles.mirrorChip,
                    { backgroundColor: roles.bgTag },
                  ]}
                >
                  <Text style={[styles.mirrorChipLabel, { color: roles.fg }]}>
                    {v.name}
                  </Text>
                  <Text
                    style={[styles.mirrorChipCount, { color: roles.fgMuted }]}
                  >
                    {v.count}
                  </Text>
                </Pressable>
              ))}
            </View>
          </MirrorBlock>
        )}

        {data.topGenres.length > 0 && (
          <MirrorBlock title={t('Genres', 'Genres')}>
            <View style={styles.mirrorChipsRow}>
              {data.topGenres.map((g) => (
                <Pressable
                  key={g.genre}
                  onPress={() =>
                    router.push({
                      pathname: '/(tabs)/agenda',
                      params: { q: g.genre },
                    })
                  }
                  style={[
                    styles.mirrorChip,
                    { backgroundColor: roles.bgTag },
                  ]}
                >
                  <Text
                    style={[styles.mirrorChipLabel, { color: roles.fg }]}
                  >
                    {g.genre}
                  </Text>
                  <Text
                    style={[styles.mirrorChipCount, { color: roles.fgMuted }]}
                  >
                    {g.count}
                  </Text>
                </Pressable>
              ))}
            </View>
          </MirrorBlock>
        )}

        {wijkenTotal > 0 && (
          <MirrorBlock title={t('Wijken', 'Neighbourhoods')}>
            {data.wijken
              .filter((w) => w.wijk)
              .slice(0, 5)
              .map((w) => {
                const pct = Math.round((w.count / wijkenTotal) * 100);
                const label =
                  (w.wijk && WIJK_LABEL[w.wijk]?.[locale]) ?? w.wijk ?? '?';
                return (
                  <View key={w.wijk ?? 'none'} style={styles.mirrorBarRow}>
                    <Text
                      style={[styles.mirrorBarLabel, { color: roles.fg }]}
                      numberOfLines={1}
                    >
                      {label}
                    </Text>
                    <View
                      style={[styles.mirrorBarTrack, { backgroundColor: roles.bgChip }]}
                    >
                      <View
                        style={[
                          styles.mirrorBarFill,
                          { width: `${pct}%`, backgroundColor: roles.accent },
                        ]}
                      />
                    </View>
                    <Text
                      style={[styles.mirrorBarCount, { color: roles.fgMuted }]}
                    >
                      {pct}%
                    </Text>
                  </View>
                );
              })}
          </MirrorBlock>
        )}

        <MirrorBlock title={t('Weekdagen', 'Weekdays')}>
          <View style={styles.weekdayRow}>
            {data.weekday.map((d) => {
              const h = Math.max(4, (d.count / weekdayMax) * 36);
              return (
                <View key={d.weekday} style={styles.weekdayCol}>
                  <View
                    style={[
                      styles.weekdayBar,
                      {
                        height: h,
                        backgroundColor:
                          d.count === 0 ? roles.bgChip : roles.accent,
                      },
                    ]}
                  />
                  <Text
                    style={[styles.weekdayLabel, { color: roles.fgMuted }]}
                  >
                    {locale === 'nl'
                      ? WEEKDAY_SHORT_NL[d.weekday]
                      : WEEKDAY_SHORT_EN[d.weekday]}
                  </Text>
                </View>
              );
            })}
          </View>
        </MirrorBlock>

        {data.monthlyTimeline.length > 1 && (
          <MirrorBlock title={t('Per maand', 'By month')}>
            <View style={styles.monthlyRow}>
              {data.monthlyTimeline.slice(-12).map((m) => {
                const h = Math.max(3, (m.count / monthlyMax) * 32);
                return (
                  <View key={m.ym} style={styles.monthlyCol}>
                    <View
                      style={[
                        styles.monthlyBar,
                        {
                          height: h,
                          backgroundColor:
                            m.count === 0 ? roles.bgChip : roles.accent,
                        },
                      ]}
                    />
                    <Text
                      style={[styles.monthlyLabel, { color: roles.fgMuted }]}
                    >
                      {m.ym.slice(5)}
                    </Text>
                  </View>
                );
              })}
            </View>
          </MirrorBlock>
        )}

        {discoveryTotal > 0 && (
          <MirrorBlock title={t('Hoe vond je dit', 'How you found it')}>
            {data.discovery
              .filter((d) => d.source)
              .map((d) => {
                const pct = Math.round((d.count / discoveryTotal) * 100);
                const label =
                  (d.source && SOURCE_LABEL[d.source]?.[locale]) ??
                  d.source ??
                  '?';
                return (
                  <View key={d.source ?? 'none'} style={styles.mirrorBarRow}>
                    <Text
                      style={[styles.mirrorBarLabel, { color: roles.fg }]}
                      numberOfLines={1}
                    >
                      {label}
                    </Text>
                    <View
                      style={[styles.mirrorBarTrack, { backgroundColor: roles.bgChip }]}
                    >
                      <View
                        style={[
                          styles.mirrorBarFill,
                          { width: `${pct}%`, backgroundColor: roles.accent },
                        ]}
                      />
                    </View>
                    <Text
                      style={[styles.mirrorBarCount, { color: roles.fgMuted }]}
                    >
                      {pct}%
                    </Text>
                  </View>
                );
              })}
          </MirrorBlock>
        )}

        <Text style={[styles.mirrorFootnote, { color: roles.fgPlaceholder }]}>
          {t('Dit is wat je hebt gedaan.', 'This is what you’ve done.')}
        </Text>
      </View>
    );
}

function MirrorBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const roles = useRoles();
  return (
    <View style={styles.mirrorBlock}>
      <Text style={[styles.mirrorBlockTitle, { color: roles.fg }]}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/** Dag/nacht-weergave als duidelijke tekst-toggle — verhuisd van de
    header-switch naar het profiel (eens-per-dag-keuze, geen vluchtige
    interactie). Puur het visuele thema: licht of donker. */
function AppearanceSection() {
  const t = useT();
  const mode = useMode();
  const setMode = useModeStore((s) => s.setMode);

  const options: { value: Mode; label: string }[] = [
    { value: 'nacht', label: t('Nacht', 'Night') },
    { value: 'dag', label: t('Dag', 'Day') },
  ];

  return (
    <SettingsGroup
      header={t('Weergave', 'Appearance')}
      footer={t(
        'Nacht is donker met acid-geel, dag is licht met karmijn. Puur smaak — het aanbod blijft hetzelfde.',
        'Night is dark with acid yellow, day is light with crimson. Purely taste — the content stays the same.'
      )}
    >
      <SettingsChoice
        label={t('Dag of nacht', 'Day or night')}
        value={mode}
        options={options}
        onChange={setMode}
      />
    </SettingsGroup>
  );
}

function LanguageSection() {
  const t = useT();
  const preference = useLocalePreference();
  const setPreference = useLocaleStore((s) => s.setPreference);

  const options: { value: LocalePreference; label: string }[] = [
    { value: 'auto', label: t('Automatisch', 'Automatic') },
    { value: 'nl', label: 'Nederlands' },
    { value: 'en', label: 'English' },
  ];

  return (
    <SettingsGroup
      header={t('Taal', 'Language')}
      footer={t(
        'Automatisch volgt de taal van je toestel.',
        'Automatic follows your device language.'
      )}
    >
      <SettingsChoice
        label={t('Taal van de app', 'App language')}
        value={preference}
        options={options}
        onChange={setPreference}
      />
    </SettingsGroup>
  );
}

function NotificationsSection({
  me,
  onUpdated,
}: {
  me: ApiMe | null;
  onUpdated: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<
    'granted' | 'denied' | 'undetermined' | null
  >(null);
  const [busy, setBusy] = useState(false);

  // De schakelaars per soort. Eén "meldingen aan/uit" zou betekenen dat
  // de eerste melding die je te veel vindt het einde is van álle
  // meldingen: dan zet je 'm uit in iOS, en daar komen we nooit meer
  // voorbij.
  const [push, setPush] = useState({
    dailyNew: me?.pushDailyNew ?? true,
    dayBefore: me?.pushDayBefore ?? true,
    tonight: me?.pushTonight ?? true,
  });
  useEffect(() => {
    if (!me) return;
    setPush({
      dailyNew: me.pushDailyNew,
      dayBefore: me.pushDayBefore,
      tonight: me.pushTonight,
    });
  }, [me]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const { status: s } = await Notifications.getPermissionsAsync();
      if (alive) setStatus(s as typeof status);
    };
    void refresh();
    // Zet je het in de iOS-instellingen om, dan kom je terug in de app
    // zonder dat hier iets is gebeurd — vandaar opnieuw kijken bij
    // terugkeer.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const onPermission = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (status === 'denied' || status === 'granted') {
        await Linking.openSettings();
      } else {
        await registerForPushNotificationsAsync();
        const { status: s } = await Notifications.getPermissionsAsync();
        setStatus(s as typeof status);
      }
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (
    key: 'dailyNew' | 'dayBefore' | 'tonight',
    next: boolean
  ) => {
    const prev = push;
    setPush({ ...push, [key]: next });
    const field = (
      {
        dailyNew: 'pushDailyNew',
        dayBefore: 'pushDayBefore',
        tonight: 'pushTonight',
      } as const
    )[key];
    try {
      await updateMe({ [field]: next });
      onUpdated();
    } catch {
      setPush(prev);
    }
  };

  // Zonder toestemming van het toestel doet elke schakelaar hieronder
  // niets. Dan grijs, zodat je ziet dat de knop er is en waarom hij nu
  // niet werkt — in plaats van hem te verbergen en je te laten zoeken.
  const off = status !== 'granted';

  return (
    <SettingsGroup
      header={t('Meldingen', 'Notifications')}
      footer={
        off
          ? t(
              'Andreas mag nog niets sturen. Zet het aan op het toestel en kies hieronder wat je wilt horen.',
              'Andreas is not allowed to send anything yet. Turn it on at device level and pick what you want below.'
            )
          : t(
              'Een herinnering die je zelf op een avond zet blijft altijd staan — die vroeg je zelf.',
              'A reminder you set yourself on a night always stays — you asked for that one.'
            )
      }
    >
      {/* Geen schakelaar, met opzet. iOS laat één keer vragen; daarna kan
          een app de toestemming niet meer zetten of intrekken -- alleen
          de gebruiker kan dat, in Instellingen. Een schakelaar die niet
          schakelt is een leugen, dus dit is een rij die je erheen
          brengt. Aantikbaar in álle toestanden: staat 'ie aan, dan wil
          je 'm daar juist uit kunnen zetten. */}
      <SettingsAction
        label={t('Op dit toestel', 'On this device')}
        sub={t(
          'Staat bij de iOS-instellingen van Andreas.',
          'Lives in the iOS settings for Andreas.'
        )}
        value={
          status === 'granted'
            ? t('Aan', 'On')
            : status === 'denied'
              ? t('Uit', 'Off')
              : t('Niet ingesteld', 'Not set')
        }
        action={
          status === 'undetermined' ? t('Aanzetten', 'Turn on') : undefined
        }
        onPress={() => void onPermission()}
      />
      <SettingsSwitch
        label={t('De avond ervoor', 'The night before')}
        sub={t('Om 18:00, voor wat je hebt gered.', 'At 18:00, for what you saved.')}
        value={push.dayBefore}
        disabled={off}
        onValueChange={(v) => void onToggle('dayBefore', v)}
      />
      <SettingsSwitch
        label={t('Op de dag zelf', 'On the day itself')}
        sub={t('Drie uur van tevoren.', 'Three hours ahead.')}
        value={push.tonight}
        disabled={off}
        onValueChange={(v) => void onToggle('tonight', v)}
      />
      <SettingsSwitch
        label={t('Nieuw binnengekomen', 'New arrivals')}
        sub={t('Elke ochtend om 10:00.', 'Every morning at 10:00.')}
        value={push.dailyNew}
        disabled={off}
        onValueChange={(v) => void onToggle('dailyNew', v)}
      />
    </SettingsGroup>
  );
}

/**
 * Waarvóór die herinneringen gelden.
 *
 * Een eigen blok, want het is een andere vraag dan hierboven: daar kies
 * je hoe vaak, hier waarover. Een hartje is een interessesignaal, "ik ga"
 * is een belofte -- en wie alleen voor dat tweede gebeld wil worden zet
 * het eerste uit.
 */
function ReminderScopeSection({
  me,
  onUpdated,
}: {
  me: ApiMe;
  onUpdated: () => void;
}) {
  const t = useT();
  const [scope, setScope] = useState({
    saves: me.pushForSaves,
    going: me.pushForGoing,
  });
  useEffect(() => {
    setScope({ saves: me.pushForSaves, going: me.pushForGoing });
  }, [me.pushForSaves, me.pushForGoing]);

  const onToggle = async (key: 'saves' | 'going', next: boolean) => {
    const prev = scope;
    setScope({ ...scope, [key]: next });
    try {
      await updateMe(
        key === 'saves' ? { pushForSaves: next } : { pushForGoing: next }
      );
      onUpdated();
    } catch {
      setScope(prev);
    }
  };

  return (
    <SettingsGroup
      header={t('Herinner me aan', 'Remind me about')}
      footer={
        !scope.saves && !scope.going
          ? t(
              'Met allebei uit krijg je alleen nog herinneringen die je zelf op een avond zet.',
              'With both off you only get reminders you set yourself on a night.'
            )
          : t(
              'Een hartje is interesse, "ik ga" is een afspraak. Je kunt voor allebei gebeld worden, of maar voor één.',
              'A heart is interest, "I am going" is a commitment. You can be pinged for both, or just one.'
            )
      }
    >
      <SettingsSwitch
        label={t('Wat ik heb gered', 'What I saved')}
        sub={t('Het hartje.', 'The heart.')}
        value={scope.saves}
        onValueChange={(v) => void onToggle('saves', v)}
      />
      <SettingsSwitch
        label={t('Waar ik heen ga', 'Where I am going')}
        sub={t('Waar je "ik ga" op tikte.', 'What you tapped "going" on.')}
        value={scope.going}
        onValueChange={(v) => void onToggle('going', v)}
      />
    </SettingsGroup>
  );
}

type Visibility = 'favorites' | 'friends' | 'private';

function PrivacySection({
  me,
  onUpdated,
}: {
  me: ApiMe;
  onUpdated: () => void;
}) {
  const t = useT();

  // Optimistisch: de schakelaar verspringt meteen, en rolt terug als de
  // server nee zegt. Een instelling die een halve seconde nadenkt voelt
  // stuk, ook als hij het niet is.
  const [savesVis, setSavesVis] = useState<Visibility>(me.savesVisibility);
  const [mirrorVis, setMirrorVis] = useState<Visibility>(me.mirrorVisibility);
  const [discoverable, setDiscoverable] = useState(me.discoverable);

  useEffect(() => {
    setSavesVis(me.savesVisibility);
    setMirrorVis(me.mirrorVisibility);
    setDiscoverable(me.discoverable);
  }, [me.savesVisibility, me.mirrorVisibility, me.discoverable]);

  const apply = async <T,>(
    next: T,
    prev: T,
    set: (v: T) => void,
    patch: Parameters<typeof updateMe>[0]
  ) => {
    if (next === prev) return;
    set(next);
    try {
      await updateMe(patch);
      onUpdated();
    } catch {
      set(prev);
    }
  };

  const visibilityOpts: { value: Visibility; label: string }[] = [
    { value: 'favorites', label: t('Favorieten', 'Favourites') },
    { value: 'friends', label: t('Vrienden', 'Friends') },
    { value: 'private', label: t('Niemand', 'Nobody') },
  ];

  return (
    <SettingsGroup
      header={t('Privacy', 'Privacy')}
      footer={t(
        'Favorieten zijn de vrienden die je zelf als favoriet hebt gemarkeerd. Vindbaar uit betekent dat alleen mensen die jij toevoegt vrienden met je kunnen worden.',
        'Favourites are the friends you marked as such. Findable off means only people you add can become friends with you.'
      )}
    >
      <SettingsChoice
        label={t('Wie ziet wat je redt', 'Who sees what you save')}
        value={savesVis}
        options={visibilityOpts}
        onChange={(v) =>
          void apply(v, savesVis, setSavesVis, { savesVisibility: v })
        }
      />
      <SettingsChoice
        label={t('Wie ziet je spiegel', 'Who sees your mirror')}
        value={mirrorVis}
        options={visibilityOpts}
        onChange={(v) =>
          void apply(v, mirrorVis, setMirrorVis, { mirrorVisibility: v })
        }
      />
      <SettingsSwitch
        label={t('Vindbaar via zoeken', 'Findable via search')}
        value={discoverable}
        onValueChange={(v) =>
          void apply(v, discoverable, setDiscoverable, { discoverable: v })
        }
      />
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({
  // De QR eerst: dat is wat je iemand vóórhoudt. De foto eronder zegt
  // wie je bent, en dat weet je zelf al.
  qrBlock: { alignItems: 'center', marginBottom: 4 },
  qrTile: { padding: 14, borderRadius: 18 },
  // Losse kaartjes met ruimte ertussen, net als je bewaarde kaartjes:
  // het zijn allemaal dingen die je kan doen, dus ze mogen er ook zo
  // uitzien. Eén blok met streepjes leest als een instellingenlijst.
  profileMenu: { marginHorizontal: 22, gap: 12, marginTop: 8 },
  // Ruim: een rij is 60 hoog met 18 lucht boven en onder. Apple houdt
  // 44 aan als ondergrens voor iets aantikbaars, en dit is geen lijst om
  // te lezen maar om te raken.
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 18,
    borderRadius: 16,
  },
  profileRowLabel: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 16,
    letterSpacing: -0.24,
  },
  // Zelfde sluit-knop als op /films, /clubs, /theater en /going: 36×36
  // cirkel met een Ionicons-kruis. De kleinere ModalCloseBtn met het
  // brand-kruis is voor sheets; dit is een vol scherm en hoort bij die
  // familie.
  signInCloseBtn: {
    position: 'absolute',
    right: 22,
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  root: { flex: 1 },
  loadingRoot: { alignItems: 'center', justifyContent: 'center' },

  // Sluit-knop voor modal-presentatie — 28×28 cirkel met brand-kruis,
  // rechtsboven, zelfde footprint als de avatar-stip elders.
  modalCloseBtn: {
    position: 'absolute',
    right: 18,
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  // Drag-handle voor de profiel-bewerken Modal (replace voor de
  // sluit-knop in editing-mode). Pure affordance — dismiss gebeurt
  // door iOS pageSheet swipe-down of Android hardware-back.
  modalDragWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 20,
  },
  modalDragHandle: {
    width: 44,
    height: 5,
    borderRadius: 2.5,
    opacity: 0.7,
  },
  // Android-variant van de modal-sluit-knop: 36×36 cirkel linksboven,
  // zelfde footprint als de invite-modal close-btn voor consistentie.
  modalCloseLeft: {
    position: 'absolute',
    left: 18,
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },

  // Auth-form copy
  kicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  titleSave: { fontFamily: fontFamily.bold, fontSize: 16.5 },
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
    paddingBottom: 28,
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
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
    marginBottom: 12,
  },
  editProfileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
  },
  editProfileBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.1,
  },
  // Solid-bg buttons — mirror van /add-friend, full-width, ruime
  // padding, geen border. Voelt overal in de app als één familie.
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 14,
    width: '100%',
  },
  actionBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: 0.1,
  },
  // Legacy outlined-btn — nog in gebruik op secundaire acties
  // (Annuleren in edit-profile, Uitloggen). Behoudt de subtielere
  // outlined look om hiërarchie te bewaren naast de solid-actions.
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

  // Section header — gelijk aan rails-stijl (display, dik, 18pt).

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

  twin: { flexDirection: 'row', gap: 8 },
  twinBtn: {
    width: 44,
    height: 44,
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
    width: 44,
    height: 44,
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

  // Spiegel
  mirrorWrap: { paddingHorizontal: 22, paddingTop: 4, gap: 14 },
  mirrorIdentity: {
    fontFamily: fontFamily.display,
    fontSize: 21,
    lineHeight: 26,
    letterSpacing: -0.4,
  },
  mirrorMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: -8,
  },
  mirrorBlock: { gap: 6, paddingTop: 8 },
  mirrorBlockTitle: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
    paddingBottom: 2,
  },
  mirrorRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingVertical: 2,
    gap: 8,
  },
  mirrorRowLabel: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.14,
  },
  mirrorRowCount: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  mirrorChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  mirrorChip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    gap: 6,
  },
  mirrorChipLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.1,
  },
  mirrorChipCount: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  mirrorBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 1,
  },
  mirrorBarLabel: {
    width: 80,
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.1,
  },
  mirrorBarTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  mirrorBarFill: {
    height: '100%',
    borderRadius: 3,
  },
  mirrorBarCount: {
    width: 36,
    textAlign: 'right',
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  weekdayRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    height: 56,
  },
  weekdayCol: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  weekdayBar: {
    width: '100%',
    borderRadius: 3,
  },
  weekdayLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.8,
  },
  monthlyRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    height: 52,
  },
  monthlyCol: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  monthlyBar: {
    width: '100%',
    borderRadius: 2,
  },
  monthlyLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 8.5,
    letterSpacing: 0.6,
  },
  mirrorFootnote: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    paddingTop: 4,
  },

  // Privacy
  privacyWrap: { paddingHorizontal: 22, paddingTop: 4 },
  privacyBlock: {
    paddingVertical: 12,
    gap: 8,
  },
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
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notifBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
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

  // Visuele scheiding boven de logout-knop — duidelijk eind van
  // settings, daaronder de afsluit-actie.
  logoutDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 22,
    marginTop: 24,
  },

  // Uitloggen — full-width pill onderaan, zelfde stijl als profile-actions
  logoutWrap: {
    paddingHorizontal: 22,
    paddingTop: 16,
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

