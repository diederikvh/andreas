import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Ionicons } from '@expo/vector-icons';

import { Cross } from '@/components/Cross';
import { SpinningCross } from '@/components/SpinningCross';
import { useT } from '@/lib/i18n';
import { safeBack } from '@/lib/navigation';
import { pendingShareFromPhoto, usePendingShare } from '@/lib/pendingShare';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/**
 * De poster-scanner. Fase 8 van "Share naar Andreas".
 *
 * Een poster in de stad kan je niet delen — je staat ervoor. Dit scherm is
 * daarom niets meer dan een camera met een sluiterknop: de foto gaat langs
 * exact dezelfde weg als een gedeelde afbeelding (kopie in `import/`,
 * `setPending`, `/import`). **Er zit hier geen tweede herkennings-code**,
 * en dat moet zo blijven: alles wat de scanner beter maakt — zalen die
 * hij leert, fuzzy zoeken, zelf een event aanmaken — komt gratis mee
 * zolang dit scherm alleen een bestand aanlevert.
 *
 * `replace` en niet `push` naar `/import`: sluit je het importvel, dan wil
 * je terug naar waar je vandaan kwam en niet opnieuw in de zoeker staan.
 *
 * Geen zesde tab, geen knop op de hero. Hij hangt in Meer, want je scant
 * een poster een paar keer per maand en niet elke avond.
 */
export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const t = useT();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const setPending = usePendingShare((s) => s.setPending);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const shoot = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Volle resolutie: de kleine regels op een poster (datum, support)
      // zijn precies wat de OCR nodig heeft.
      const photo = await camera.current?.takePictureAsync({ quality: 1 });
      if (!photo) throw new Error('geen foto');
      const pending = await pendingShareFromPhoto(photo);
      if (!pending) throw new Error('kopie mislukt');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPending(pending);
      router.replace('/import');
    } catch {
      // Camera die niets teruggaf of een volle schijf. Geen scherm vol
      // uitleg: nog een keer drukken is het hele herstel.
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      {permission?.granted ? (
        <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.fallback]}>
          <Text style={styles.fallbackText}>
            {permission?.canAskAgain === false
              ? t(
                  'Geen camera-toegang. Sta toegang toe via Instellingen → Andreas → Camera.',
                  'No camera access. Enable it via Settings → Andreas → Camera.',
                )
              : t('Camera-toegang aanvragen…', 'Requesting camera access…')}
          </Text>
        </View>
      )}

      {/* Zelfde koptekst-lockup als elk ander scherm — wordmark links,
          sluiten rechts — maar in vaste lichte kleuren: hierachter zit
          geen modus-vlak maar een willekeurige foto, en in dagmodus zou
          donkere inkt op een donkere poster verdwijnen. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.lockup} pointerEvents="none">
          <Text style={styles.wordmark}>Andreas</Text>
          <View style={styles.lockupCross}>
            <Cross size={16} thickness={4} color={roles.accent} />
          </View>
          <Text style={styles.wordmark}>{t('Scanner', 'Scanner')}</Text>
        </View>
        <Pressable onPress={() => safeBack()} hitSlop={8} style={styles.close}>
          <Ionicons name="close" size={20} color="#f2f2ef" />
        </Pressable>
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={styles.hint}>
          {t(
            'Hou de hele poster in beeld, inclusief de datum.',
            'Keep the whole poster in frame, including the date.',
          )}
        </Text>
        {permission?.granted ? (
          <Pressable
            onPress={shoot}
            disabled={busy}
            hitSlop={10}
            style={styles.shutter}
          >
            {busy ? (
              <SpinningCross size={22} color="#0a0a0b" />
            ) : (
              <View style={styles.shutterDot} />
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  fallback: {
    backgroundColor: '#0a0a0b',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  fallbackText: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    color: '#9a9a94',
    textAlign: 'center',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 12,
    gap: 8,
  },
  // Maten één-op-één uit AppHeader, anders staat het kruis hier net
  // een haar anders dan op elk ander scherm.
  lockup: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  lockupCross: { transform: [{ translateY: -1 }] },
  wordmark: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.18,
    textTransform: 'uppercase',
    lineHeight: 18,
    color: '#f2f2ef',
  },
  close: {
    width: 36,
    height: 36,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    gap: 16,
  },
  hint: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    color: 'rgba(242,242,239,0.75)',
    textAlign: 'center',
    paddingHorizontal: 32,
    // Op een lichte poster verdwijnt witte tekst; een donkere pil eronder
    // houdt 'm leesbaar zonder een balk over het beeld te leggen.
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterDot: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#f2f2ef',
  },
});
