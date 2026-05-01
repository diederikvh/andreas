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

export async function getEvents(opts?: { limit?: number }): Promise<ApiEvent[]> {
  const qs = opts?.limit ? `?limit=${opts.limit}` : '';
  const { events } = await request<{ events: ApiEvent[] }>(`/events${qs}`);
  return events;
}

export async function getEvent(id: string): Promise<ApiEvent> {
  const { event } = await request<{ event: ApiEvent }>(`/events/${id}`);
  return event;
}

export { ApiError, BASE_URL };
