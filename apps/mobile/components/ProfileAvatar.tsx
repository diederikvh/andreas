import { Image } from 'expo-image';
import { Text, View } from 'react-native';

import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Round avatar — image when available, fallback initial. Gedeeld
 * tussen /jij en /social zodat de visuele taal consistent is.
 */
export function ProfileAvatar({
  avatarUrl,
  name,
  size,
}: {
  avatarUrl: string | null;
  name: string;
  size: number;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  if (avatarUrl) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        style={{ width: size, height: size, borderRadius: 999 }}
        contentFit="cover"
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: isNacht ? palette.noir2 : palette.paper2,
      }}
    >
      <Text
        style={{
          fontFamily: fontFamily.display,
          fontSize: size * 0.45,
          color: roles.fgMuted,
        }}
      >
        {initialFor(name)}
      </Text>
    </View>
  );
}

function initialFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith('+')) return '?';
  return trimmed[0].toUpperCase();
}
