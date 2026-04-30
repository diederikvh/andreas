import { router } from 'expo-router';
import { View } from 'react-native';

import { Welkom } from '@/components/start/Welkom';
import { useRoles } from '@/store/mode';

/**
 * Modal version of Welkom. Triggered just-in-time from actions that
 * need an account (save, add-friend, invite). Closes itself on submit.
 */
export default function WelkomModal() {
  const roles = useRoles();

  return (
    <View style={{ flex: 1, backgroundColor: roles.bg }}>
      <Welkom onSubmit={() => router.back()} />
    </View>
  );
}
