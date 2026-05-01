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

export type ApiEvent = {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  priceCents: number | null;
  ticketUrl: string | null;
  imageUrl: string | null;
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film';
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
  };
};

export type EventsFilter = {
  featured?: boolean;
  /** ISO datestring */
  from?: string;
  /** ISO datestring */
  to?: string;
  category?: ApiEvent['category'];
  q?: string;
  limit?: number;
};

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(text || `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export async function getEvents(filter: EventsFilter = {}): Promise<ApiEvent[]> {
  const params = new URLSearchParams();
  if (filter.featured) params.set('featured', 'true');
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.category) params.set('category', filter.category);
  if (filter.q && filter.q.trim().length > 0) params.set('q', filter.q.trim());
  if (filter.limit) params.set('limit', String(filter.limit));
  const qs = params.toString();
  const { events } = await request<{ events: ApiEvent[] }>(
    `/events${qs ? `?${qs}` : ''}`
  );
  return events;
}

export async function getEvent(id: string): Promise<ApiEvent> {
  const { event } = await request<{ event: ApiEvent }>(`/events/${id}`);
  return event;
}

export type ApiVenue = {
  id: string;
  slug: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  imageUrl: string | null;
  description: string | null;
};

export type ApiVenueProgramItem = Omit<ApiEvent, 'venue'>;

export type ApiVenueWithProgram = {
  venue: ApiVenue;
  events: ApiVenueProgramItem[];
};

export async function getVenue(slug: string): Promise<ApiVenueWithProgram> {
  return await request<ApiVenueWithProgram>(`/venues/${slug}`);
}

export type ApiMe = {
  id: string;
  phoneNumber: string;
  phoneNumberVerified: boolean;
  handle: string | null;
  name: string;
  avatarUrl: string | null;
  modePreference: 'nacht' | 'dag';
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
    const entry = parsed['better-auth.session_token'];
    if (!entry?.value) return null;
    if (entry.expires && new Date(entry.expires) < new Date()) return null;
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
  name: string;
  handle: string;
}): Promise<ApiMe> {
  const { user } = await authedRequest<{ user: ApiMe }>('/me', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return user;
}

export type SavedApiEvent = ApiEvent & { savedAt: string };

export async function getMySaves(): Promise<SavedApiEvent[]> {
  const { events } = await authedRequest<{ events: SavedApiEvent[] }>(
    '/saves'
  );
  return events;
}

export async function toggleSave(eventId: string): Promise<{ saved: boolean }> {
  return await authedRequest<{ saved: boolean }>('/saves', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
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
