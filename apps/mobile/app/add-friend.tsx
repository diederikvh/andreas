import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';

import { BackButton } from '@/components/BackButton';
import { Cross } from '@/components/Cross';
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
        <Pressable
          onPress={() => setScannerOpen(true)}
          style={[
            styles.scanBtn,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        >
          <Ionicons name="qr-code-outline" size={20} color={roles.fg} />
        </Pressable>
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
      <View style={[styles.actionPill, styles.actionPillMuted, { borderColor: roles.bgChip }]}>
        <Text style={[styles.actionText, { color: roles.fgMuted }]}>Vriend</Text>
      </View>
    );
  }
  if (relation === 'outgoing') {
    return (
      <View style={[styles.actionPill, styles.actionPillMuted, { borderColor: roles.bgChip }]}>
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
              ? 'Geen camera-toegang. Sta toegang toe via Instellingen → Andreas → Camera.'
              : 'Camera-toegang aanvragen…'}
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
        <Text style={styles.scannerTitle}>Scan een Andreas-QR</Text>
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
