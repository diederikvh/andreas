import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccountWall } from '@/components/AccountWall';
import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { SpinningCross } from '@/components/SpinningCross';
import { InviteRow } from '@/app/social';
import { useIsRegistered } from '@/lib/authClient';
import { useT } from '@/lib/i18n';
import { useInvitations } from '@/lib/queries';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/**
 * Uitnodigingen, los van je vriendenlijst.
 *
 * Stond eerst als derde kopje op /social, tussen aanvragen en vrienden in.
 * Dat is één scherm met vier soorten rijen waar je maar één ding komt
 * doen: antwoorden. Nu een eigen pagina, met de teller in het Meer-menu
 * ernaast.
 *
 * Volgorde: wat nog een antwoord van jou vraagt bovenaan, daarna op
 * datum. Zo zie je meteen waar je iets moet.
 */
export default function UitnodigingenScreen() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const authed = useIsRegistered();
  const { data: invitations, isLoading } = useInvitations({ enabled: authed });

  const invites = invitations?.slice().sort((a, b) => {
    const aAction = !a.isOutgoing && a.myStatus === 'pending' ? 0 : 1;
    const bAction = !b.isOutgoing && b.myStatus === 'pending' ? 0 : 1;
    if (aAction !== bAction) return aAction - bAction;
    return (
      new Date(a.occurrence.startsAt).getTime() -
      new Date(b.occurrence.startsAt).getTime()
    );
  });

  const closeBtn = (
    <Pressable onPress={() => router.back()} hitSlop={8} style={styles.closeBtn}>
      <Ionicons name="close" size={20} color={roles.fg} />
    </Pressable>
  );

  const header = (
    <AppHeader
      title={t('Uitnodigingen', 'Invitations')}
      hideAvatar
      rightSlot={closeBtn}
    />
  );

  if (!authed) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        <View style={{ flex: 1, paddingTop: insets.top + HEADER_HEIGHT }}>
          <AccountWall
            icon="mail-outline"
            title={t('Uitnodigingen', 'Invitations')}
            body={t(
              'Met een account kunnen vrienden je meevragen naar een avond.',
              'With an account, friends can invite you along to a night.',
            )}
          />
        </View>
        {header}
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT + 8,
          paddingBottom: insets.bottom + 96,
        }}
      >
        {isLoading && !invites ? (
          <View style={styles.center}>
            <SpinningCross size={24} color={roles.fgMuted} />
          </View>
        ) : null}

        {invites && invites.length === 0 ? (
          <Text style={[styles.empty, { color: roles.fgMuted }]}>
            {t(
              'Geen uitnodigingen. Vraag zelf iemand mee vanaf een event.',
              'No invitations. Invite someone yourself from an event.',
            )}
          </Text>
        ) : null}

        {(invites ?? []).map((invite) => (
          <InviteRow key={invite.id} invite={invite} />
        ))}
      </ScrollView>

      {header}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { paddingTop: 60, alignItems: 'center' },
  empty: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 32,
    paddingTop: 60,
    textAlign: 'center',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
