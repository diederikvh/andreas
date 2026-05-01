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

export { ApiError, BASE_URL };
