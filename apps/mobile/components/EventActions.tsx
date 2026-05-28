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
import { Platform, Pressable, Share, StyleSheet, View } from 'react-native';

import { useSession } from '@/lib/authClient';
import { useMySaves, useToggleSave } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { palette } from '@/theme/tokens';

export function EventActions({
  eventId,
  eventTitle,
  occurrenceId,
  ticketUrl,
}: {
  eventId: string;
  eventTitle: string;
  occurrenceId: string;
  ticketUrl: string | null;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const { data: saves } = useMySaves({ enabled: authed });
  const toggleSave = useToggleSave();
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
    const url = `https://andreas.amsterdam/e/${encodeURIComponent(eventId)}`;
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

  return (
    <View style={styles.row}>
      <Pressable onPress={onSave} hitSlop={10} style={styles.btn}>
        <Ionicons
          name={isSaved ? 'heart' : 'heart-outline'}
          size={26}
          color={isSaved ? (isNacht ? palette.acid : palette.red) : roles.fg}
        />
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
});
