/**
 * Inline action-row voor event-cards: save (hartje), share, ticket.
 * Drie iconen op een rij, gebruikt op /clubs en /live (single-
 * occurrence cards). Theater wordt overgeslagen omdat 't event meerdere
 * occurrences kan hebben en de ticket-knop dan ambiguous is.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { useSession } from '@/lib/authClient';
import { useLocale } from '@/lib/i18n';
import { useMySaves, useToggleSave } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

export function EventActions({
  eventId,
  eventTitle,
  occurrenceId,
  ticketUrl,
  invitedCount = 0,
}: {
  eventId: string;
  eventTitle: string;
  occurrenceId: string;
  ticketUrl: string | null;
  /** Aantal vrienden dat ik al uitgenodigd heb voor deze occurrence.
      Toont een klein badge op de invite-icoon zodat je in de lijst
      direct ziet of je al iemand uitgenodigd hebt. */
  invitedCount?: number;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const { data: saves } = useMySaves({ enabled: authed });
  const toggleSave = useToggleSave();
  const locale = useLocale();
  const isSaved = Boolean(
    saves?.some((s) => s.occurrenceId === occurrenceId)
  );

  const onSave = () => {
    if (!authed) {
      router.push('/jij' as never);
      return;
    }
    if (!isSaved) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else Haptics.selectionAsync();
    toggleSave.mutate({ occurrenceId, source: 'kaart' });
  };

  const onShare = async () => {
    const langQs = locale === 'en' ? '?lang=en' : '';
    const url = `https://andreas.amsterdam/e/${encodeURIComponent(eventId)}${langQs}`;
    const messageBody = `${eventTitle} via Andreas — ${url}`;
    try {
      await Share.share(
        Platform.OS === 'ios'
          ? { url, message: messageBody }
          : { message: messageBody }
      );
      Haptics.selectionAsync();
    } catch {
      // Cancel of share-error — geen actie nodig.
    }
  };

  const onTicket = () => {
    if (!ticketUrl) return;
    Haptics.selectionAsync();
    WebBrowser.openBrowserAsync(ticketUrl).catch(() => {
      Linking.openURL(ticketUrl).catch(() => {});
    });
  };

  const onInvite = () => {
    if (!authed) {
      router.push('/jij' as never);
      return;
    }
    Haptics.selectionAsync();
    router.push(
      `/event/${eventId}/invite?o=${occurrenceId}` as never
    );
  };

  return (
    <View style={styles.row}>
      <Pressable onPress={onSave} hitSlop={10} style={styles.btn}>
        <Ionicons
          name={isSaved ? 'heart' : 'heart-outline'}
          size={26}
          color={isSaved ? (isNacht ? palette.acid : palette.red) : roles.fg}
        />
      </Pressable>
      <Pressable onPress={onInvite} hitSlop={10} style={styles.btnInline}>
        <Ionicons name="person-add-outline" size={24} color={roles.fg} />
        {invitedCount > 0 ? (
          <Text style={[styles.countText, { color: roles.fg }]}>
            {invitedCount}
          </Text>
        ) : null}
      </Pressable>
      <Pressable onPress={onShare} hitSlop={10} style={styles.btn}>
        <Ionicons name="paper-plane-outline" size={24} color={roles.fg} />
      </Pressable>
      <Pressable
        onPress={onTicket}
        disabled={!ticketUrl}
        hitSlop={10}
        style={[styles.btn, { opacity: ticketUrl ? 1 : 0.35 }]}
      >
        <Ionicons name="ticket-outline" size={24} color={roles.fg} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Instagram-stijl: ruwe iconen op een rij, links uitgelijnd, geen
  // pill-achtergrond, kleine spacing tussen icons.
  row: {
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  btn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Voor een actie met inline-count: icoon + cijfer naast elkaar,
  // Instagram-stijl. Geen badge-bolletje.
  btnInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  countText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.2,
  },
});
