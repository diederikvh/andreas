import { Redirect, useLocalSearchParams } from 'expo-router';

import { useSession } from '@/lib/authClient';

/**
 * Universal-link entrypoint voor handle-shares (de QR-code op de
 * Jij-pagina encodeert `https://andreas.amsterdam/u/<handle>`).
 *
 * Ingelogd → direct naar /add-friend met de handle voorgevuld.
 * Niet ingelogd → naar /jij; na onboarding kan de gebruiker handmatig
 * naar /add-friend (de handle terugvinden via re-scan).
 */
export default function HandleShareEntry() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);

  if (!handle) return <Redirect href="/jij" />;
  if (!authed) return <Redirect href="/jij" />;
  return <Redirect href={`/add-friend?handle=${handle}` as never} />;
}
