import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Universal-link entrypoint voor venue-shares. Iemand opent
 * `https://andreas.amsterdam/v/<slug>` of `andreas://v/<slug>` — die
 * landt hier en gaat direct door naar de bestaande venue-detail-route.
 */
export default function VenueShareEntry() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  if (!slug) return <Redirect href="/kaart" />;
  return <Redirect href={`/venue/${slug}` as never} />;
}
