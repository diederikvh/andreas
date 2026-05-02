import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Universal-link entrypoint. Iemand opent een share-link
 * `https://andreas.amsterdam/e/<id>` of `andreas://e/<id>` — die landt
 * hier en wordt direct doorgeleid naar de event-detail-route. Geen
 * eigen UI nodig; we gebruiken de bestaande detail-pagina.
 */
export default function ShareEntry() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!id) return <Redirect href="/avond" />;
  return <Redirect href={`/event/${id}` as never} />;
}
