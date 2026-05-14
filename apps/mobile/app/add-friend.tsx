import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';

import { BackButton } from '@/components/BackButton';
import { Cross } from '@/components/Cross';
import { useEffect, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ApiSearchUser } from '@/lib/api';
import { createShareInvite } from '@/lib/api';
import { useT } from '@/lib/i18n';
import {
  useAcceptFriendRequest,
  useMe,
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
  const tx = useT();

  // ?handle= komt binnen via universal-link of vanuit de QR-scanner.
  // Vul het zoekveld voor zodat de juiste user direct verschijnt.
  const params = useLocalSearchParams<{ handle?: string; scan?: string }>();
  const initialHandle = (params.handle ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');

  const [q, setQ] = useState(initialHandle);
  // Eenvoudige debounce zodat we niet bij elke toets fetchen.
  const [debouncedQ, setDebouncedQ] = useState(initialHandle);
  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedQ(q.trim().toLowerCase()),
      200
    );
    return () => clearTimeout(t);
  }, [q]);

  // Als er na mount nog een nieuwe handle binnenkomt (bv. tweede scan
  // zonder de pagina te verlaten), pak die ook op.
  useEffect(() => {
    if (initialHandle && initialHandle !== q) setQ(initialHandle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialHandle]);

  const [scannerOpen, setScannerOpen] = useState(params.scan === '1');

  // Search-input wil normaal direct focus pakken (handle-search). Maar
  // als we via ?scan=1 of via de QR-knop binnenkomen openen we eerst
  // de scanner — dan moet 't keyboard juist weg.
  useEffect(() => {
    if (scannerOpen) Keyboard.dismiss();
  }, [scannerOpen]);
  // Onthoud of de gebruiker hier puur voor de scanner kwam (vanuit
  // de Jij-tab). Zo ja, en de scanner sluit zonder dat er gescand is,
  // dan terug naar de vorige route i.p.v. blijven hangen op de
  // zoek-lijst.
  const [scanOnlyEntry, setScanOnlyEntry] = useState(
    params.scan === '1' && !initialHandle
  );

  const search = useUserSearch(debouncedQ);
  const sendRequest = useSendFriendRequest();
  const acceptRequest = useAcceptFriendRequest();
  const { data: me } = useMe();
  const [showQr, setShowQr] = useState(false);

  // Vraagt server om een share-invite token en opent native share-sheet.
  // Ontvanger downloadt app + log in → friendship-claim hook regelt de rest.
  const onInviteFriend = async () => {
    try {
      const invite = await createShareInvite();
      const display =
        me?.name && !me.name.startsWith('+')
          ? me.name
          : me?.handle
            ? `@${me.handle}`
            : 'een vriend';
      const message = tx(
        `Hey, ${display} hier — ik gebruik Andreas, anti-algoritme uitgaansapp voor Amsterdam. Download 'm en we zijn meteen vrienden:\n${invite.url}`,
        `Hey, ${display} here — I use Andreas, the anti-algorithm guide to Amsterdam. Download it and we’ll be friends right away:\n${invite.url}`
      );
      await Share.share(
        Platform.OS === 'ios'
          ? { url: invite.url, message }
          : { message }
      );
      Haptics.selectionAsync();
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const displayName =
    me?.name && !me.name.startsWith('+') ? me.name : me?.handle ?? '';

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
        <Text style={[styles.topTitle, { color: roles.fg }]}>
          {tx('Verbind met vrienden', 'Connect with friends')}
        </Text>
        {/* Rechter slot leeg houden om titel netjes te centreren — de
            QR-acties zijn verhuisd naar pills onder het zoekveld. */}
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
          <TextInput
            value={q}
            // Sta naam-tokens toe (spaties, letters), maar geen
            // tweemaals-leading-spaties of speciale tekens die de
            // server-side ilike vergiftigen. Server lowerCase't zelf.
            onChangeText={(t) =>
              setQ(t.replace(/^\s+/, '').replace(/[^a-zA-Z0-9_ ]/g, ''))
            }
            placeholder={tx(
              'zoek op handle of naam',
              'search by handle or name'
            )}
            placeholderTextColor={roles.fgPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            // Niet autofocussen wanneer de gebruiker direct doorgaat
            // naar de scanner — anders pop-upt 't keyboard tussen
            // scanner en page door.
            autoFocus={!scanOnlyEntry}
            style={[styles.searchInput, { color: roles.fg }]}
          />
        </View>

        {/* Action-buttons in volgorde: invite → scan → my QR.
            Externe deel-actie eerst (vaakst gebruikt voor mensen
            buiten de app), daarna scan en eigen QR voor 1-op-1
            connecten in dezelfde ruimte. */}
        <View style={styles.actionsRow}>
          <Pressable
            onPress={onInviteFriend}
            style={[
              styles.actionPill2,
              { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Ionicons
              name="share-outline"
              size={16}
              color={roles.fg}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.actionPill2Text, { color: roles.fg }]}>
              {tx('Nodig vriend uit', 'Invite a friend')}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setScannerOpen(true)}
            style={[
              styles.actionPill2,
              { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Ionicons
              name="scan-outline"
              size={16}
              color={roles.fg}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.actionPill2Text, { color: roles.fg }]}>
              {tx('Scan QR', 'Scan QR')}
            </Text>
          </Pressable>
          {me?.handle && (
            <Pressable
              onPress={() => setShowQr(true)}
              style={[
                styles.actionPill2,
                { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
              ]}
            >
              <Ionicons
                name="qr-code-outline"
                size={14}
                color={roles.fg}
                style={{ marginRight: 6 }}
              />
              <Text style={[styles.actionPill2Text, { color: roles.fg }]}>
                {tx('Mijn QR', 'My QR')}
              </Text>
            </Pressable>
          )}
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        >
          {debouncedQ.length < 2 ? (
            <EmptyHint
              icon="people-outline"
              title={tx(
                'Typ minstens 2 tekens om te zoeken.',
                'Type at least 2 characters to search.'
              )}
            />
          ) : search.isLoading ? (
            <EmptyHint
              icon="ellipsis-horizontal"
              title={tx('Zoeken…', 'Searching…')}
            />
          ) : (search.data ?? []).length === 0 ? (
            <EmptyHint
              icon="person-outline"
              title={tx(
                `Geen resultaat voor "${debouncedQ}".`,
                `No result for "${debouncedQ}".`
              )}
            />
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
      {scannerOpen && (
        <ScanQRSheet
          onClose={() => {
            setScannerOpen(false);
            // Kwam de gebruiker hier alleen voor de scanner (vanaf Jij)
            // en is er niets gescand? Dan terug naar de vorige route.
            if (scanOnlyEntry) {
              router.back();
            }
          }}
          onHandle={(h) => {
            setScannerOpen(false);
            setQ(h);
            // Wel iets gescand → blijf op de zoek-lijst zodat de
            // gebruiker direct het resultaat ziet.
            setScanOnlyEntry(false);
          }}
        />
      )}
      <Modal
        visible={showQr && Boolean(me?.handle)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowQr(false)}
      >
        {me?.handle && (
          <MyQrSheet handle={me.handle} name={displayName} />
        )}
      </Modal>
    </KeyboardAvoidingView>
  );
}

/**
 * Centered empty-state hint — gecentreerd icoon erboven, normale
 * font-stack (niet mono), titel daaronder. Mirror van het
 * EmptyResults-patroon op Vandaag/Agenda.
 */
function EmptyHint({
  icon,
  title,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
}) {
  const roles = useRoles();
  return (
    <View style={styles.emptyHint}>
      <Ionicons name={icon} size={32} color={roles.fgMuted} />
      <Text style={[styles.emptyHintText, { color: roles.fgMuted }]}>
        {title}
      </Text>
    </View>
  );
}

/**
 * Inline QR-modal. Spiegelt MyQrSheet van /jij (zelfde Andreas-X
 * logo-overlay + ecl=H) zodat scannen consistent voelt waar dan ook.
 */
function MyQrSheet({ handle, name }: { handle: string; name: string }) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const url = `https://andreas.amsterdam/u/${handle}`;
  return (
    <View style={[styles.qrSheet, { backgroundColor: roles.bg }]}>
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
            ecl="H"
          />
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
  const t = useT();
  if (relation === 'accepted') {
    return (
      <View style={[styles.actionPill, styles.actionPillMuted, { borderColor: roles.bgChip }]}>
        <Text style={[styles.actionText, { color: roles.fgMuted }]}>
          {t('Vriend', 'Friend')}
        </Text>
      </View>
    );
  }
  if (relation === 'outgoing') {
    return (
      <View style={[styles.actionPill, styles.actionPillMuted, { borderColor: roles.bgChip }]}>
        <Text style={[styles.actionText, { color: roles.fgMuted }]}>
          {t('Aangevraagd', 'Pending')}
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
          {t('Accepteer', 'Accept')}
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
        {t('+ Toevoegen', '+ Add')}
      </Text>
    </Pressable>
  );
}

/**
 * Camera-overlay om een Andreas-QR te scannen. We accepteren elke
 * `https://andreas.amsterdam/u/<handle>` of `andreas://u/<handle>`
 * URL en pluk daar de handle uit. Bij succes geven we de handle door
 * aan de parent en sluiten we de scanner.
 */
function ScanQRSheet({
  onClose,
  onHandle,
}: {
  onClose: () => void;
  onHandle: (handle: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const t = useT();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const onResult = ({ data }: { data: string }) => {
    if (scanned) return;
    const handle = parseHandleFromQr(data);
    if (!handle) return;
    setScanned(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onHandle(handle);
  };

  return (
    <View style={styles.scannerWrap}>
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={scanned ? undefined : onResult}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.scannerFallback]}>
          <Text style={styles.scannerFallbackText}>
            {permission?.canAskAgain === false
              ? t(
                  'Geen camera-toegang. Sta toegang toe via Instellingen → Andreas → Camera.',
                  'No camera access. Enable it via Settings → Andreas → Camera.'
                )
              : t('Camera-toegang aanvragen…', 'Requesting camera access…')}
          </Text>
        </View>
      )}
      <View
        style={[styles.scannerTopBar, { paddingTop: insets.top + 8 }]}
      >
        <Pressable
          onPress={onClose}
          hitSlop={8}
          style={[styles.scannerCloseBtn]}
        >
          <Cross size={14} thickness={2.6} color="#f2f2ef" />
        </Pressable>
        <Text style={styles.scannerTitle}>
          {t('Scan een Andreas-QR', 'Scan an Andreas QR')}
        </Text>
        <View style={{ width: 40, height: 40 }} />
      </View>
      <View pointerEvents="none" style={styles.scannerReticle} />
    </View>
  );
}

function parseHandleFromQr(raw: string): string | null {
  // Accepteer https://andreas.amsterdam/u/<handle> of andreas://u/<handle>.
  // Andere QR-content negeren we, anders schrik je je dood bij een
  // willekeurige Wifi-QR.
  const m = raw.match(/(?:andreas:\/\/u\/|andreas\.amsterdam\/u\/)([a-z0-9_]{1,40})/i);
  if (!m) return null;
  return m[1].toLowerCase();
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
  scanBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
    textAlign: 'center',
  },
  body: { flex: 1, paddingHorizontal: 22, gap: 14 },

  // Action-buttons gestapeld, elk full-width — duidelijke CTA's
  // i.p.v. inline pills. Gap zodat ze ademen.
  actionsRow: {
    flexDirection: 'column',
    gap: 10,
  },
  // Solid button — gevulde achtergrond, geen border, full-width, ruim
  // gepadded. Centreert icoon + tekst horizontaal.
  actionPill2: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 14,
    width: '100%',
  },
  actionPill2Text: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: 0.1,
  },

  // QR-modal — mirror van /jij styles
  qrSheet: { flex: 1, paddingHorizontal: 22 },
  qrDragHandleWrap: { alignItems: 'center', paddingVertical: 12 },
  qrDragHandle: { width: 44, height: 4, borderRadius: 999 },
  qrBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  qrCard: {
    width: 280,
    height: 280,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrLogoOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrLogoBg: {
    width: 56,
    height: 56,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrName: {
    fontFamily: fontFamily.bold,
    fontSize: 22,
    letterSpacing: -0.3,
  },
  qrHandle: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginTop: -8,
  },
  qrLead: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    marginTop: 8,
  },

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

  // Empty-state hint — gecentreerd, icoon erboven, normale font.
  // Mirror van het EmptyResults-patroon op Vandaag/Agenda.
  emptyHint: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyHintText: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
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

  // Scanner-overlay (full-screen camera + close + reticle)
  scannerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    zIndex: 50,
  },
  scannerFallback: {
    backgroundColor: '#0a0a0b',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  scannerFallbackText: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    color: '#9a9a94',
    textAlign: 'center',
  },
  scannerTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 12,
    gap: 8,
  },
  scannerCloseBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scannerTitle: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
    textAlign: 'center',
    color: '#f2f2ef',
  },
  scannerReticle: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 240,
    height: 240,
    marginLeft: -120,
    marginTop: -120,
    borderRadius: 24,
    borderColor: 'rgba(255,255,255,0.85)',
    borderWidth: 2,
  },
});
