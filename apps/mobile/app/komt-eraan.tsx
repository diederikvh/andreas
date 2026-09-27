import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccountWall } from '@/components/AccountWall';
import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { FollowedShowRow } from '@/components/FollowedShowRow';
import { SpinningCross } from '@/components/SpinningCross';
import { useIsRegistered } from '@/lib/authClient';
import { softTap } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { useFollowedShows } from '@/lib/queries';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/**
 * Komt eraan: de avonden van artiesten die je volgt, eerstvolgende eerst.
 *
 * Een eigen pagina (was een tabblad op Artiesten), zodat de rail op
 * Vandaag ergens heen kan: "Alles →". Artiesten is daarmee weer puur de
 * lijst van wie je volgt.
 */
export default function KomtEraanScreen() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const authed = useIsRegistered();
  const { data: shows, isLoading } = useFollowedShows({ enabled: authed });

  const header = (
    <AppHeader
      title={t('Komt eraan', 'Coming up')}
      hideAvatar
      rightSlot={
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.closeBtn}>
          <Ionicons name="close" size={20} color={roles.fg} />
        </Pressable>
      }
    />
  );

  if (!authed) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        <View style={{ flex: 1, paddingTop: insets.top + HEADER_HEIGHT }}>
          <AccountWall
            icon="musical-notes-outline"
            title={t('Artiesten volgen', 'Following artists')}
            body={t(
              'Met een account volg je artiesten, en zie je hier wanneer ze komen spelen.',
              'With an account you follow artists, and see here when they come to play.',
            )}
          />
        </View>
        {header}
      </View>
    );
  }

  const list = shows ?? [];
  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT + 8,
          paddingBottom: insets.bottom + 96,
        }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <SpinningCross size={24} color={roles.fgMuted} />
          </View>
        ) : list.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="musical-notes-outline" size={40} color={roles.fgMuted} />
            <Text style={[styles.emptyTitle, { color: roles.fg }]}>
              {t('Nog niets aangekondigd', 'Nothing announced yet')}
            </Text>
            <Text style={[styles.emptyBody, { color: roles.fgMuted }]}>
              {t(
                'Zodra een artiest die je volgt een avond heeft, staat die hier en krijg je bericht.',
                'As soon as an artist you follow has a night, it shows up here and you get a message.',
              )}
            </Text>
            <Pressable
              onPress={() => {
                softTap();
                router.push('/artiesten' as never);
              }}
              hitSlop={8}
            >
              <Text style={[styles.link, { color: roles.fg }]}>{t('Wie volg ik? →', 'Who do I follow? →')}</Text>
            </Pressable>
          </View>
        ) : (
          list.map((show) => <FollowedShowRow key={show.id} show={show} />)
        )}
      </ScrollView>
      {header}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  closeBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  center: { paddingTop: 60, alignItems: 'center' },
  empty: { alignItems: 'center', gap: 10, paddingTop: 80, paddingHorizontal: 34 },
  emptyTitle: { fontFamily: fontFamily.bold, fontSize: 17 },
  emptyBody: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  link: { fontFamily: fontFamily.bold, fontSize: 14, marginTop: 6 },
});
