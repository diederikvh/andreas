/**
 * Thin fetch-wrapper voor de @andreas/api server. Zet `EXPO_PUBLIC_API_URL`
 * in `apps/mobile/.env` voor non-default hosts (bv. fysiek toestel:
 * `EXPO_PUBLIC_API_URL=http://192.168.x.y:8787`).
 *
 * `EXPO_PUBLIC_*` envs worden door Expo aan de client gehangen; alle
 * andere envs zitten alleen in build-tooling.
 */

const BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

export type ApiFriendBadge = {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};

export type EventKind = 'show' | 'exhibition';

export type OccurrenceStatus = 'scheduled' | 'cancelled' | 'sold_out';

export type ApiLineupEntry = {
  name: string;
  role?: 'dj' | 'support' | 'headliner' | 'act';
};

export type ApiOccurrence = {
  id: string;
  startsAt: string;
  endsAt: string | null;
  priceCents: number | null;
  priceNote: string | null;
  ticketUrl: string | null;
  /** Optionele zaal binnen venue (bv. "Kleine Zaal", "Zaal 1"). */
  room: string | null;
  /** Lineup voor dit specifieke moment. Wisselt voor wekelijkse feesten,
      vaak leeg voor films. */
  lineup: ApiLineupEntry[] | null;
  status: OccurrenceStatus;
  /** Vrienden die specifiek díe occurrence hebben gesaved. Een save
      voor de woensdag-voorstelling laat alleen daar de pill zien, niet
      bij de overige occurrences van dezelfde film. Optioneel: list-
      endpoints vullen 'm; standalone-shapes (saves, mocks) niet. */
  friendsSaved?: ApiFriendBadge[];
  friendsSavedCount?: number;
};

export type ApiEvent = {
  id: string;
  title: string;
  description: string | null;
  /** `show` (concert/film/club/voorstelling/opening) of `exhibition`
      (doorlopende tentoonstelling). UI toont voor `exhibition` een
      "loopt t/m …" label i.p.v. een tijdslot. */
  kind: EventKind;
  /** Eerstvolgende occurrence — gedenormaliseerd zodat list-views
      (Avond/Agenda/Kaart/Gered) niet hoeven te joinen. Voor afgelopen
      events of exhibitions die net afgelopen zijn kan dit `null` zijn. */
  startsAt: string;
  endsAt: string | null;
  priceCents: number | null;
  /** Vrije korte noot bij de prijs. Overschrijft venue.priceNote. */
  priceNote?: string | null;
  ticketUrl: string | null;
  /** Aantal komende occurrences (incl. de huidige `startsAt`). UI gebruikt
      dit om "+ 4 meer" te tonen achter de eerste tijd. */
  occurrenceCount: number;
  /** Voor list-endpoints (Avond/Agenda/Kaart): alle occurrences in de
      gevraagde datum-range. UI kan per occurrence flatmappen zodat een
      multi-occurrence event op meerdere dagen verschijnt — een 3-daags
      festival komt zo op alle 3 dagen in de Agenda terug. */
  occurrencesInRange?: ApiOccurrence[];
  imageUrl: string | null;
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';
  featured: boolean;
  venue: {
    id: string;
    slug: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    /** Venue-type (podium/club/galerie/museum/film/ruimte/boekhandel-cafe).
        Optioneel — niet alle endpoints leveren 'm; UI gebruikt 'm voor de
        venue-tone-pill in lijst-rijen. */
    type?: VenueType | null;
    /** Scene (mainstream/alternatief/underground/fringe). Gebruikt door
        Vandaag-rails om galleries te splitsen op professioneel vs DIY. */
    scene?: VenueScene | null;
    /** Vrije subtype-tags op de venue (bv. ['fotografie'] voor FOAM). Vandaag
        groepeert musea hierop. */
    subtype?: string[] | null;
    description?: string | null;
    imageUrl?: string | null;
    /** Default priceNote vanuit venue (bv. "lidmaatschap vereist"). */
    priceNote?: string | null;
  };
  /** Tot 3 vrienden die dit event ook hebben opgeslagen. */
  friendsSaved?: ApiFriendBadge[];
  /** Totale telling van vrienden die dit event hebben opgeslagen. */
  friendsSavedCount?: number;
  /** Door mij verstuurde invites voor dit event (alleen op detail). */
  myInvites?: ApiEventInviteRecord[];
  /** Uitnodigingen aan mij verstuurd die ik geaccepteerd heb — voor de
      "connection"-markering in de crew-lijst op event-detail. */
  incomingAcceptedInvites?: ApiIncomingAcceptedInvite[];
  /** Iedereen met een 'going'-respons op invitations voor dit event
   *  waar IK ook in zit (initiator óf groepslid). Inclusief groepsleden
   *  die geen vrienden zijn. Per spec: "Bij event-detail zichtbaar:
   *  'X gaat ook'". `viaGroupName` is gezet voor groep-invites. */
  peopleGoing?: ApiPersonGoing[];
  /** Volg ik de venue van dit event? Mobile groepeert hierop. */
  venueFollowed?: boolean;
  /** Series waar dit event onderdeel van is (bv. ADE, Lenteballet). */
  series?: ApiSeriesBadge[];
  /** Specifieke genres binnen `category` (techno/hip-hop/jazz/etc).
      Vrije array. Filter scheidt clientside per categorie. */
  genres?: string[];
};

/** Detail-respons: event met de volledige lijst occurrences. */
export type ApiEventDetail = ApiEvent & {
  occurrences: ApiOccurrence[];
};

export type ApiGenreBucket = {
  genre: string;
  category: ApiEvent['category'];
  count: number;
};

export type ApiSeriesBadge = {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
};

/** Drie-status-respons (plus pending) sinds slice B. */
export type InvitationStatus = 'pending' | 'going' | 'maybe' | 'not_going';

export type ApiEventInviteRecord = {
  id: string;
  status: InvitationStatus;
  message: string | null;
  to: ApiPublicUser;
  /** Welke specifieke occurrence heb ik deze invitee voor uitgenodigd. */
  occurrenceId: string;
  occurrenceStartsAt: string;
  /** Niet-NULL = ik heb deze persoon al een keer herinnerd. Per spec
      maar één reminder per (invitation, ontvanger). */
  reminderSentAt: string | null;
  /** Naam van de groep waarlangs deze recipient is uitgenodigd. NULL =
      1-op-1. Voor crew-context "via Vrijdagclub". */
  viaGroupName: string | null;
};

/** Inkomende invite waarop ik 'going' heb geantwoord — voor de
 *  "Gaat mee"-pill op vrienden die mij hebben uitgenodigd én wiens
 *  uitnodiging ik heb geaccepteerd. Naam blijft `IncomingAccepted`
 *  voor minimal churn; semantiek = mijn response is 'going'. */
export type ApiIncomingAcceptedInvite = {
  id: string;
  occurrenceId: string;
  from: ApiPublicUser;
};

/** Iemand die going-respons op een gedeelde invitation heeft — voor de
 *  crew-lijst op event-detail. `viaGroupName` is de groepsnaam waarlangs
 *  ik visibility heb op deze person ("Roos · via Vrijdagclub"); null = 1-op-1. */
export type ApiPersonGoing = {
  user: ApiPublicUser;
  occurrenceId: string;
  viaGroupName: string | null;
};

export type EventsFilter = {
  featured?: boolean;
  /** ISO datestring */
  from?: string;
  /** ISO datestring */
  to?: string;
  category?: ApiEvent['category'];
  q?: string;
  /** Multi-select OR-filter — events met minstens één van deze genres. */
  genres?: string[];
  limit?: number;
};

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function getEvents(filter: EventsFilter = {}): Promise<ApiEvent[]> {
  const params = new URLSearchParams();
  if (filter.featured) params.set('featured', 'true');
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.category) params.set('category', filter.category);
  if (filter.q && filter.q.trim().length > 0) params.set('q', filter.q.trim());
  if (filter.genres && filter.genres.length > 0) {
    for (const g of filter.genres) params.append('genre', g);
  }
  if (filter.limit) params.set('limit', String(filter.limit));
  const qs = params.toString();
  // authedRequest stuurt de bearer mee als die er is, anders niet —
  // /events werkt voor uitgelogde users (zonder friendsSaved data) en
  // ingelogde users (mét friendsSaved).
  const { events } = await authedRequest<{ events: ApiEvent[] }>(
    `/events${qs ? `?${qs}` : ''}`
  );
  return events;
}

/** "Voor jou" — gepersonaliseerde aanbevelingen op basis van eigen
    save-historie + gevolgde venues. Backend: GET /events/for-you. Lege
    array voor uitgelogd of zonder saves. */
export async function getForYouEvents(): Promise<ApiEvent[]> {
  const { events } = await authedRequest<{ events: ApiEvent[] }>(
    '/events/for-you'
  );
  return events;
}

export async function getEvent(id: string): Promise<ApiEventDetail> {
  const { event } = await authedRequest<{ event: ApiEventDetail }>(`/events/${id}`);
  return event;
}

export async function getEventGenres(): Promise<ApiGenreBucket[]> {
  const { genres } = await authedRequest<{ genres: ApiGenreBucket[] }>(
    '/events/genres'
  );
  return genres;
}

export type VenueCategory = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';

export type VenueType =
  | 'galerie'
  | 'museum'
  | 'podium'
  | 'club'
  | 'film'
  | 'ruimte'
  | 'boekhandel-cafe';

export type VenueDayNight = 'day' | 'night' | 'both';

export type VenueWijk =
  | 'centrum'
  | 'noord'
  | 'oost'
  | 'west'
  | 'zuid'
  | 'zuidoost'
  | 'nieuw-west'
  | 'amstelveen'
  | 'zaandam'
  | 'haarlem';

export type VenueScene =
  | 'mainstream'
  | 'alternatief'
  | 'underground'
  | 'fringe';

export type VenueCapacity = 'klein' | 'middel' | 'groot' | 'xl';

export type ApiVenue = {
  id: string;
  slug: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  imageUrl: string | null;
  description: string | null;
  categories: VenueCategory[];
  type: VenueType | null;
  dayNight: VenueDayNight | null;
  wijk: VenueWijk | null;
  scene: VenueScene | null;
  capacity: VenueCapacity | null;
  subtype: string[];
  website: string | null;
  instagram: string | null;
};

export type ApiVenueProgramItem = Omit<ApiEvent, 'venue'>;

export type VenueFollowState = 'volgen' | 'normaal' | 'blokken';

export type ApiVenueWithProgram = {
  venue: ApiVenue;
  events: ApiVenueProgramItem[];
  myFollowState: VenueFollowState;
  /** Series waarvan minstens één toekomstig event in deze venue speelt. */
  series: ApiSeriesBadge[];
};

export async function getVenue(slug: string): Promise<ApiVenueWithProgram> {
  return await authedRequest<ApiVenueWithProgram>(`/venues/${slug}`);
}

export type ApiVenueListItem = ApiVenue & {
  myFollowState: VenueFollowState;
};

export async function getVenues(input: {
  q?: string;
  category?: VenueCategory;
  type?: VenueType;
  dayNight?: VenueDayNight;
  wijk?: VenueWijk;
  scene?: VenueScene;
} = {}): Promise<ApiVenueListItem[]> {
  const params = new URLSearchParams();
  if (input.q && input.q.trim().length > 0) params.set('q', input.q.trim());
  if (input.category) params.set('category', input.category);
  if (input.type) params.set('type', input.type);
  if (input.dayNight) params.set('dayNight', input.dayNight);
  if (input.wijk) params.set('wijk', input.wijk);
  if (input.scene) params.set('scene', input.scene);
  const qs = params.toString();
  const { venues } = await authedRequest<{ venues: ApiVenueListItem[] }>(
    `/venues${qs ? `?${qs}` : ''}`
  );
  return venues;
}

export type ApiVenueSubtypeBucket = {
  subtype: string;
  type: VenueType | null;
  count: number;
};

export async function getVenueSubtypes(
  types?: VenueType[]
): Promise<ApiVenueSubtypeBucket[]> {
  const params = new URLSearchParams();
  if (types) for (const t of types) params.append('type', t);
  const qs = params.toString();
  const { subtypes } = await authedRequest<{ subtypes: ApiVenueSubtypeBucket[] }>(
    `/venues/subtypes${qs ? `?${qs}` : ''}`
  );
  return subtypes;
}

// ─── Series ───────────────────────────────────────────────────────────

export type ApiSeries = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  startsAt: string | null;
  endsAt: string | null;
  categories: VenueCategory[];
};

export type ApiSeriesListItem = ApiSeries & {
  eventCount: number;
};

export type ApiSeriesWithEvents = {
  series: ApiSeries;
  events: ApiEvent[];
};

export async function getSeriesList(input: {
  q?: string;
  category?: VenueCategory;
} = {}): Promise<ApiSeriesListItem[]> {
  const params = new URLSearchParams();
  if (input.q && input.q.trim().length > 0) params.set('q', input.q.trim());
  if (input.category) params.set('category', input.category);
  const qs = params.toString();
  const { series } = await authedRequest<{ series: ApiSeriesListItem[] }>(
    `/series${qs ? `?${qs}` : ''}`
  );
  return series;
}

export async function getSeries(slug: string): Promise<ApiSeriesWithEvents> {
  return await authedRequest<ApiSeriesWithEvents>(`/series/${slug}`);
}

export async function setVenueFollow(input: {
  venueId: string;
  state: VenueFollowState;
}): Promise<{ state: VenueFollowState }> {
  return await authedRequest<{ state: VenueFollowState }>('/venue-follows', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function registerPushToken(input: {
  token: string;
  platform: 'ios' | 'android';
  deviceId?: string | null;
}): Promise<{ ok: true }> {
  return await authedRequest<{ ok: true }>('/push/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function unregisterPushToken(
  token: string
): Promise<{ ok: true }> {
  return await authedRequest<{ ok: true }>('/push/unregister', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export type ApiMe = {
  id: string;
  phoneNumber: string;
  phoneNumberVerified: boolean;
  handle: string | null;
  name: string;
  avatarUrl: string | null;
  modePreference: 'nacht' | 'dag';
  savesVisibility: 'favorites' | 'friends' | 'private';
  /** Apart van savesVisibility — controleert of de smaak-spiegel (top
      venues/genres/wijken) zichtbaar is voor vrienden op u/[handle]. */
  mirrorVisibility: 'favorites' | 'friends' | 'private';
  discoverable: boolean;
  createdAt: string;
};

import * as SecureStore from 'expo-secure-store';

/**
 * Haal het sessie-token uit de SecureStore die @better-auth/expo
 * vult. De plugin schrijft een JSON-object onder `<prefix>_cookie`
 * met per cookie een `{ value, expires }` paar. We pakken de
 * `better-auth.session_token` waarde en sturen die als Bearer mee
 * op onze eigen API-routes — better-auth's $fetch is voorbehouden
 * aan /api/auth/* paden.
 */
type CookieEntry = { value: string; expires?: string };

async function getSessionBearer(): Promise<string | null> {
  const raw = await SecureStore.getItemAsync('andreas_cookie');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, CookieEntry>;
    // Better-auth voegt automatisch een `__Secure-` prefix toe aan de
    // cookie-naam wanneer de baseURL HTTPS is (per browser-spec). In
    // dev (http://localhost) is het de plain naam. We proberen beide.
    const entry =
      parsed['__Secure-better-auth.session_token'] ??
      parsed['better-auth.session_token'];
    if (!entry?.value) return null;
    // Bewust GEEN client-side `expires`-check meer: de cookie-expires
    // wordt niet bijgewerkt door onze fetch-calls (die gaan langs
    // better-auth's $fetch heen), dus een verlopen-lijkend cookie kan
    // best nog een geldig server-side sessie-token zijn. Server is
    // de bron van waarheid; bij een echte 401 mogen we 'm pas weghalen.
    return entry.value;
  } catch {
    return null;
  }
}

async function authedRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await getSessionBearer();
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = `Server fout (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // body isn't JSON — keep default msg
    }
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

export async function getMe(): Promise<ApiMe | null> {
  try {
    const { user } = await authedRequest<{ user: ApiMe }>('/me');
    return user;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

/**
 * Vraag de server om een nieuwe share-invite token voor de huidige
 * user. Body is leeg in v1 (pure friend-invite); toekomstige slice
 * koppelt eventId/venueId.
 */
export async function createShareInvite(): Promise<{
  token: string;
  url: string;
  expiresAt: string;
}> {
  return await authedRequest('/share-invites', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Claim een share-invite token: maakt friendship met de inviter en
 * retourneert de inviter-profiel-info zodat de UI een toast kan tonen.
 * Idempotent — meerdere claims door dezelfde user zijn veilig.
 */
export async function claimShareInvite(token: string): Promise<{
  inviter: { id: string; name: string | null; handle: string | null; avatarUrl: string | null };
  friendshipChange: 'created' | 'upgraded' | 'noop';
}> {
  return await authedRequest(`/share-invites/${encodeURIComponent(token)}/claim`, {
    method: 'POST',
  });
}

export type Visibility = 'favorites' | 'friends' | 'private';

export async function updateMe(input: {
  name?: string;
  handle?: string;
  savesVisibility?: Visibility;
  mirrorVisibility?: Visibility;
  discoverable?: boolean;
}): Promise<ApiMe> {
  const { user } = await authedRequest<{ user: ApiMe }>('/me', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return user;
}

/**
 * Saved-row van /saves. Server geeft één rij per gesaveterde occurrence;
 * een film waarvan ik 3 voorstellingen heb gesaved levert 3 entries.
 * `id` is de event-id, `occurrenceId` is de specifieke voorstelling.
 */
export type SavedApiEvent = ApiEvent & {
  occurrenceId: string;
  savedAt: string;
};

export async function getMySaves(): Promise<SavedApiEvent[]> {
  const { events } = await authedRequest<{ events: SavedApiEvent[] }>(
    '/saves'
  );
  return events;
}

/** Bron-attributie voor een save — welk scherm of route leverde 'm op.
    Backend heeft een matching enum (`save_source`); waarden moeten 1-op-1
    overeenkomen. Voedt de discovery-trail op de persoonlijke spiegel. */
export type SaveSource =
  | 'venue'
  | 'friend'
  | 'search'
  | 'op-gevoel'
  | 'avond'
  | 'agenda'
  | 'kaart'
  | 'series'
  | 'gered'
  | 'other';

export async function toggleSave(
  occurrenceId: string,
  source?: SaveSource | null
): Promise<{ saved: boolean }> {
  return await authedRequest<{ saved: boolean }>('/saves', {
    method: 'POST',
    body: JSON.stringify({ occurrenceId, source: source ?? undefined }),
  });
}

export async function toggleDismiss(
  occurrenceId: string
): Promise<{ dismissed: boolean }> {
  return await authedRequest<{ dismissed: boolean }>('/dismisses', {
    method: 'POST',
    body: JSON.stringify({ occurrenceId }),
  });
}

export async function getMyDismisses(): Promise<string[]> {
  const { occurrenceIds } = await authedRequest<{ occurrenceIds: string[] }>(
    '/dismisses'
  );
  return occurrenceIds;
}

/** Persoonlijke smaak-spiegel — top venues/genres/wijken/timeline en
    discovery-mix. Geaggregeerd over de eigen saves van de ingelogde
    user. Backend: GET /mirror/me. */
export type MirrorVenue = {
  id: string;
  slug: string;
  name: string;
  type: string | null;
  wijk: string | null;
  count: number;
  isFollowed: boolean;
};

export type Mirror = {
  totals: { saves: number; venuesFollowed: number };
  topVenues: MirrorVenue[];
  topGenres: { genre: string; count: number }[];
  wijken: { wijk: string | null; count: number }[];
  venueTypes: { type: string | null; count: number }[];
  categories: { category: string | null; count: number }[];
  discovery: { source: string | null; count: number }[];
  monthlyTimeline: { ym: string; count: number }[];
  weekday: { weekday: number; count: number }[];
};

export async function getMyMirror(): Promise<Mirror> {
  return await authedRequest<Mirror>('/mirror/me');
}

/** Beperkte vriend-zichtbare spiegel-subset op u/[handle]. Geen counts,
    geen timeline — alleen top 3 venues + top 3 genres als visitekaartje.
    403 als de vriend `mirrorVisibility='private'` heeft of niet bevriend. */
export type PublicMirror = {
  topVenues: { id: string; slug: string; name: string }[];
  topGenres: { genre: string }[];
};

export async function getMirrorByHandle(handle: string): Promise<PublicMirror> {
  return await authedRequest<PublicMirror>(
    `/mirror/u/${encodeURIComponent(handle)}`
  );
}

// ─── Friends ──────────────────────────────────────────────────────────

export type ApiPublicUser = {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};

export type ApiFriend = ApiPublicUser & {
  since: string;
  /** Heeft de huidige user deze vriend als favoriet gemarkeerd? */
  favorite?: boolean;
};
export type ApiFriendRequest = ApiPublicUser & { requestedAt: string };
export type ApiSearchUser = ApiPublicUser & {
  relation: 'accepted' | 'incoming' | 'outgoing' | null;
};

export async function getFriends(): Promise<ApiFriend[]> {
  const { friends } = await authedRequest<{ friends: ApiFriend[] }>('/friends');
  return friends;
}

export async function getFriendRequests(): Promise<ApiFriendRequest[]> {
  const { requests } = await authedRequest<{ requests: ApiFriendRequest[] }>(
    '/friends/requests'
  );
  return requests;
}

export async function getOutgoingFriendRequests(): Promise<ApiFriendRequest[]> {
  const { outgoing } = await authedRequest<{ outgoing: ApiFriendRequest[] }>(
    '/friends/outgoing'
  );
  return outgoing;
}

export async function sendFriendRequest(
  handle: string
): Promise<{ status: 'pending' | 'accepted' }> {
  return await authedRequest<{ status: 'pending' | 'accepted' }>(
    '/friends/request',
    { method: 'POST', body: JSON.stringify({ handle }) }
  );
}

export async function acceptFriendRequest(
  fromUserId: string
): Promise<{ status: 'accepted' }> {
  return await authedRequest<{ status: 'accepted' }>('/friends/accept', {
    method: 'POST',
    body: JSON.stringify({ fromUserId }),
  });
}

export async function declineFriendRequest(
  fromUserId: string
): Promise<{ ok: true }> {
  return await authedRequest<{ ok: true }>('/friends/decline', {
    method: 'POST',
    body: JSON.stringify({ fromUserId }),
  });
}

export async function removeFriend(userId: string): Promise<{ ok: true }> {
  return await authedRequest<{ ok: true }>(`/friends/${userId}`, {
    method: 'DELETE',
  });
}

export async function searchUsers(q: string): Promise<ApiSearchUser[]> {
  const { users } = await authedRequest<{ users: ApiSearchUser[] }>(
    `/users/search?q=${encodeURIComponent(q)}`
  );
  return users;
}

export type ApiFriendDetail = {
  user: ApiPublicUser;
  events: ApiEvent[];
  savesPrivate?: boolean;
  /** True als deze vriend z'n spiegel deelt met vrienden
      (`mirrorVisibility='friends'`). Voorkomt onnodige fetch + lege
      Spiegel-tab UI. */
  mirrorShared?: boolean;
  /** Heeft de huidige user deze vriend als favoriet gemarkeerd? */
  favorite?: boolean;
};

export async function getFriendDetail(id: string): Promise<ApiFriendDetail> {
  return await authedRequest<ApiFriendDetail>(`/friends/${id}`);
}

export async function setFriendFavorite(
  id: string,
  favorite: boolean
): Promise<{ favorite: boolean }> {
  return await authedRequest<{ favorite: boolean }>(
    `/friends/${id}/favorite`,
    {
      method: 'PUT',
      body: JSON.stringify({ favorite }),
    }
  );
}

// ─── Invitations (3-status, groep-aware) ─────────────────────────────
//
// Vervangt het oude `invites`-pad (binair accepted/declined). Eén
// `ApiInvitation` representeert één verzending — 1-op-1 of groep.
// `responses` bevat de per-user-respons-rijen die de UI nodig heeft om
// "X gaat, Y misschien, Z pending" te tonen.

/** Per-user respons op een uitnodiging. */
export type ApiInvitationResponse = {
  user: ApiPublicUser;
  status: InvitationStatus;
  replyMessage: string | null;
  reminderSentAt: string | null;
  respondedAt: string | null;
};

export type ApiInvitation = {
  id: string;
  message: string | null;
  createdAt: string;
  /** Is dit een uitnodiging die ik zelf heb verstuurd? Andersom: ik
      ben de ontvanger. Gebruikt door social-tab om in/uit te splitsen. */
  isOutgoing: boolean;
  /** Niet-NULL = initiator heeft 'm ingetrokken; de UI verbergt 'm. */
  revokedAt: string | null;
  /** Initiator van de uitnodiging. */
  from: ApiPublicUser;
  /** Mijn eigen response-status — `null` als ik (somehow) geen response-
      rij heb (zou niet moeten). */
  myStatus: InvitationStatus | null;
  myReplyMessage: string | null;
  /** Groep waar deze invite voor naar gegaan is. `null` = 1-op-1. */
  group: { id: string; name: string } | null;
  /** Alle responses op deze invitation. Bij 1-op-1: initiator + recipient.
      Bij groep: alle leden + initiator. Volgorde niet gegarandeerd. */
  responses: ApiInvitationResponse[];
  /** De specifieke occurrence waar voor wordt uitgenodigd. */
  occurrence: {
    id: string;
    startsAt: string;
    endsAt: string | null;
    room: string | null;
  };
  /** Het master-event — voor titel + thumbnail in de invite-lijst. */
  event: {
    id: string;
    title: string;
    kind: EventKind;
    category: ApiEvent['category'];
    imageUrl: string | null;
    venueId: string;
    venueSlug: string;
    venueName: string;
  };
};

/** Backwards-compatible alias — hetzelfde object onder de oude naam,
 *  zodat call-sites die `ApiInvite` referenceren mee kunnen draaien tot
 *  ze in slice B-cleanup expliciet hernoemd worden. */
export type ApiInvite = ApiInvitation;

export async function getInvitations(opts: { past?: boolean } = {}): Promise<
  ApiInvitation[]
> {
  const qs = opts.past ? '?past=1' : '';
  const { invitations } = await authedRequest<{ invitations: ApiInvitation[] }>(
    `/invitations${qs}`
  );
  return invitations;
}

export async function sendInvitations(input: {
  /** ID van de specifieke occurrence (= moment) waarvoor je vrienden +
      groepen uitnodigt. */
  occurrenceId: string;
  /** Groepen om in één keer uit te nodigen. Server snapshot't actieve
      leden bij verzending; later toegetreden leden krijgen niets. */
  groupIds?: string[];
  /** Individuele vrienden — moeten accepted-friends zijn, anders worden
      ze stil overgeslagen door de server. */
  userIds?: string[];
  message?: string;
}): Promise<{ created: number; ids: string[] }> {
  return await authedRequest<{ created: number; ids: string[] }>(
    '/invitations',
    {
      method: 'POST',
      body: JSON.stringify(input),
    }
  );
}

/** Reageer op een uitnodiging. Mag tot het event voorbij is. Bij `going`
 *  maakt de server automatisch een save aan (idempotent). */
export async function respondInvitation(
  id: string,
  body: { status: 'going' | 'maybe' | 'not_going'; replyMessage?: string }
): Promise<{ ok: true; status: 'going' | 'maybe' | 'not_going' }> {
  return await authedRequest<{
    ok: true;
    status: 'going' | 'maybe' | 'not_going';
  }>(`/invitations/${id}/respond`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/** Stuur eenmalige herinnering naar een specifiek pending response. Server
 *  weigert met 409 als al verzonden. */
export async function remindInvitation(
  invitationId: string,
  userId: string
): Promise<{ ok: true }> {
  return await authedRequest<{ ok: true }>(
    `/invitations/${invitationId}/remind/${userId}`,
    { method: 'POST' }
  );
}

/** Initiator trekt een verstuurde uitnodiging in. Soft-delete server-side;
 *  uit alle inboxen weg bij volgende fetch. */
export async function revokeInvitation(id: string): Promise<{ ok: true }> {
  return await authedRequest<{ ok: true }>(`/invitations/${id}`, {
    method: 'DELETE',
  });
}

// ─── Groups ─────────────────────────────────────────────────────────────

export type ApiGroupMember = ApiPublicUser & {
  joinedAt: string;
  mutedAt: string | null;
};

/** Lichte vorm in lijst-respons — actieve leden zonder timestamps. */
export type ApiGroupMemberLite = ApiPublicUser;

export type ApiGroupSummary = {
  id: string;
  name: string;
  creatorId: string;
  isCreator: boolean;
  muted: boolean;
  createdAt: string;
  members: ApiGroupMemberLite[];
};

export type ApiGroupDetail = {
  id: string;
  name: string;
  creatorId: string;
  isCreator: boolean;
  muted: boolean;
  members: ApiGroupMember[];
};

export async function getGroups(): Promise<ApiGroupSummary[]> {
  const { groups } = await authedRequest<{ groups: ApiGroupSummary[] }>(
    '/groups'
  );
  return groups;
}

export async function getGroup(id: string): Promise<ApiGroupDetail> {
  return await authedRequest<ApiGroupDetail>(`/groups/${id}`);
}

export async function createGroup(input: {
  name: string;
  memberIds: string[];
}): Promise<{ id: string; name: string; memberCount: number }> {
  return await authedRequest<{ id: string; name: string; memberCount: number }>(
    '/groups',
    {
      method: 'POST',
      body: JSON.stringify(input),
    }
  );
}

export async function renameGroup(id: string, name: string): Promise<{ ok: true }> {
  return await authedRequest<{ ok: true }>(`/groups/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
    headers: { 'content-type': 'application/json' },
  });
}

export async function addGroupMembers(
  id: string,
  userIds: string[]
): Promise<{ added: number }> {
  return await authedRequest<{ added: number }>(`/groups/${id}/members`, {
    method: 'POST',
    body: JSON.stringify({ userIds }),
    headers: { 'content-type': 'application/json' },
  });
}

export async function removeGroupMember(
  groupId: string,
  userId: string
): Promise<{ ok: true }> {
  return await authedRequest<{ ok: true }>(
    `/groups/${groupId}/members/${userId}`,
    { method: 'DELETE' }
  );
}

export async function muteGroup(id: string): Promise<{ ok: true; muted: boolean }> {
  return await authedRequest<{ ok: true; muted: boolean }>(
    `/groups/${id}/mute`,
    { method: 'POST' }
  );
}

export async function unmuteGroup(id: string): Promise<{ ok: true; muted: boolean }> {
  return await authedRequest<{ ok: true; muted: boolean }>(
    `/groups/${id}/mute`,
    { method: 'DELETE' }
  );
}

export async function uploadAvatar(input: {
  uri: string;
  mimeType?: string;
}): Promise<ApiMe> {
  const token = await getSessionBearer();
  if (!token) throw new ApiError('Niet ingelogd.', 401);

  const form = new FormData();
  const ext =
    input.mimeType?.includes('png')
      ? 'png'
      : input.mimeType?.includes('webp')
        ? 'webp'
        : 'jpg';
  form.append('avatar', {
    uri: input.uri,
    name: `avatar.${ext}`,
    type: input.mimeType ?? 'image/jpeg',
  } as unknown as Blob);

  const res = await fetch(`${BASE_URL}/me/avatar`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // Geen Content-Type expliciet — RN stelt automatisch
      // multipart/form-data + boundary in.
    },
    body: form,
  });
  if (!res.ok) {
    let msg = `Upload mislukt (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // niet-JSON antwoord
    }
    throw new ApiError(msg, res.status);
  }
  const { user } = (await res.json()) as { user: ApiMe };
  return user;
}

/**
 * Sociale activity-feed: events die ≥1 vriend(in) heeft gered. Eén
 * rij per event (gededupeerd), gesorteerd op meest-recente save-tijd.
 */
export type ApiFeedEvent = {
  eventId: string;
  title: string;
  description: string | null;
  kind: EventKind;
  imageUrl: string | null;
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';
  featured: boolean;
  genres: string[];
  venue: {
    id: string;
    slug: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    type?: VenueType | null;
    imageUrl?: string | null;
    priceNote?: string | null;
  };
  occurrence: {
    id: string;
    startsAt: string;
    endsAt: string | null;
    priceCents: number | null;
    priceNote: string | null;
    ticketUrl: string | null;
  };
  friendsSaved: ApiFriendBadge[];
  friendsSavedCount: number;
  /** ISO-string — wanneer de meest-recente vriend dit event reed.
      Drijft de "X dagen geleden"-label op de feed-rij aan. */
  lastSavedAt: string;
};

export async function getSocialFeed(): Promise<ApiFeedEvent[]> {
  const { events } = await authedRequest<{ events: ApiFeedEvent[] }>(
    '/social/feed'
  );
  return events;
}

export { ApiError, BASE_URL };
