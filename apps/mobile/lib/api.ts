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
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst';
  featured: boolean;
  venue: {
    id: string;
    slug: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
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

export type ApiEventInviteRecord = {
  id: string;
  status: 'pending' | 'accepted' | 'declined';
  message: string | null;
  to: ApiPublicUser;
  /** Welke specifieke occurrence heb ik deze invitee voor uitgenodigd. */
  occurrenceId: string;
  occurrenceStartsAt: string;
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

export type VenueCategory = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst';

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
  | 'nieuw-west';

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
  savesVisibility: 'friends' | 'private';
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

export async function updateMe(input: {
  name?: string;
  handle?: string;
  savesVisibility?: 'friends' | 'private';
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

export async function toggleSave(
  occurrenceId: string
): Promise<{ saved: boolean }> {
  return await authedRequest<{ saved: boolean }>('/saves', {
    method: 'POST',
    body: JSON.stringify({ occurrenceId }),
  });
}

// ─── Friends ──────────────────────────────────────────────────────────

export type ApiPublicUser = {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};

export type ApiFriend = ApiPublicUser & { since: string };
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
};

export async function getFriendDetail(id: string): Promise<ApiFriendDetail> {
  return await authedRequest<ApiFriendDetail>(`/friends/${id}`);
}

// ─── Invites ──────────────────────────────────────────────────────────

export type ApiInvite = {
  id: string;
  message: string | null;
  createdAt: string;
  from: ApiPublicUser;
  /** De specifieke occurrence waar je voor wordt uitgenodigd. */
  occurrence: {
    id: string;
    startsAt: string;
    endsAt: string | null;
    room: string | null;
  };
  /** Het master-event (Hamlet, De Maandag, etc.) — voor titel en
      thumbnail in de invite-lijst. */
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

export async function getInvites(): Promise<ApiInvite[]> {
  const { invites } = await authedRequest<{ invites: ApiInvite[] }>('/invites');
  return invites;
}

export async function sendInvites(input: {
  /** ID van de specifieke occurrence (= moment) waarvoor je vrienden
      uitnodigt. Niet de event-ID — een vriend wil weten "ga je mee
      dinsdag 19:30?" niet "ga je mee naar Hamlet?" */
  occurrenceId: string;
  toUserIds: string[];
  message?: string;
}): Promise<{ created: number; sent: string[] }> {
  return await authedRequest<{ created: number; sent: string[] }>('/invites', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function acceptInvite(
  id: string
): Promise<{ status: 'accepted'; eventId: string; occurrenceId: string }> {
  return await authedRequest<{
    status: 'accepted';
    eventId: string;
    occurrenceId: string;
  }>(`/invites/${id}/accept`, { method: 'POST' });
}

export async function declineInvite(id: string): Promise<{ ok: true }> {
  return await authedRequest<{ ok: true }>(`/invites/${id}/decline`, {
    method: 'POST',
  });
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

export { ApiError, BASE_URL };
