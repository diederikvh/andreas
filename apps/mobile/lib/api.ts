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
  /** Pointer naar `artists.id` als de naam gematched is aan een
      canonical artist-record (via MusicBrainz-enrichment). UI maakt
      lineup-rij klikbaar naar /artist/{slug} alleen als deze set is. */
  artistId?: string;
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
  /** Venue van dit specifieke moment. Voor films kan dit afwijken van
      `event.venue`: één 'Anora'-event heeft occurrences in verschillende
      bioscopen. Voor concerts/theater is dit gelijk aan `event.venue`.
      Nullable als fallback — UI valt dan terug op event-niveau venue.
      `lat`/`lng`/`type` worden gebruikt voor de Kaart-pin per
      occurrence (multi-venue films krijgen een pin per bioscoop). */
  venue: {
    id: string;
    slug: string;
    name: string;
    lat: number;
    lng: number;
    type: string | null;
  } | null;
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
  /** Verticale poster (TMDb of venue-poster), gemirrored naar Bunny.
      Display-prioriteit in lijst-thumbs: `posterUrl ?? imageUrl`. */
  posterUrl?: string | null;
  /** Landscape sfeerbeeld voor de detail-hero (TMDb backdrop of
      venue-still). Display-prioriteit: `stillUrl ?? imageUrl`. */
  stillUrl?: string | null;
  /** Full YouTube/Vimeo URL voor films met een official trailer.
      Alleen tonen als niet null. */
  trailerUrl?: string | null;
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';
  featured: boolean;
  /** Alleen gevuld door `/events/new`: in welke baan dit event valt. */
  lane?: Lane;
  /** Alleen `/events/new`: hoeveel datums er sinds `since` bij kwamen. */
  newOccurrenceCount?: number;
  /** Alleen `/events/new`: bestond het event zelf nog niet (true), of
      kreeg een bestaand event er datums bij (false)? */
  isNewEvent?: boolean;
  /** Alleen `/events/new`: de occurrence waar een ja/nee op landt. */
  rateOccurrenceId?: string;
  /** Venue van de eerstvolgende occurrence. Voor films met multi-venue
      (Anora speelt bij Eye én Kriterion) wijkt dit af van `venue` — die
      blijft "wie scrapete dit het eerst" en is voor list-rendering vaak
      misleidend. UI rendert in lijstrijen typisch
      `nextOccurrenceVenue?.name ?? venue.name`. */
  nextOccurrenceVenue?: {
    id: string;
    slug: string;
    name: string;
    lat: number;
    lng: number;
    type: string | null;
  } | null;
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
    /** Wijk (noord/zuid/zaandam/etc.). Optioneel — meegezonden door de
        events-list endpoints zodat de venue-header op /clubs /live
        /theater 'm naast venue-type kan tonen. */
    wijk?: VenueWijk | null;
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
  /** Aantal non-revoked invites die ik zelf verstuurd heb voor de
      eerstvolgende occurrence. Mobile gebruikt 't voor de badge naast
      de invite-icoon op clubs/live/theater cards. */
  myInvitesCount?: number;
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
  /** ISO van toen 't event in onze DB landde (door scraper of admin).
      Alleen meegestuurd door endpoints die op nieuws-volgorde tonen
      (bv. `/events/new`). Voor reguliere list-endpoints null. */
  createdAt?: string;
  /** Uitlegbare aanbevelings-reden ("Omdat je vaker techno redt"). Alleen
      gevuld door `/events/for-you`. */
  reason?: string | null;
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
  venueType?: VenueType;
  q?: string;
  /** Multi-select OR-filter — events met minstens één van deze genres. */
  genres?: string[];
  limit?: number;
  /** Strip de zware velden (description, address, scene/subtype/priceNote
      /imageUrl op venue, friendsSaved per occurrence, series-array) uit
      de response. Voor rail/lijst-rendering: ~60% payload-reductie. */
  lean?: boolean;
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
  if (filter.venueType) params.set('venueType', filter.venueType);
  if (filter.q && filter.q.trim().length > 0) params.set('q', filter.q.trim());
  if (filter.genres && filter.genres.length > 0) {
    for (const g of filter.genres) params.append('genre', g);
  }
  if (filter.limit) params.set('limit', String(filter.limit));
  if (filter.lean) params.set('lean', '1');
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
    save-historie + gevolgde venues + vrienden-saves. Backend: GET
    /events/for-you. Rail-mode (default): score-desc gesorteerd, 21d
    horizon (of 7d met `weekOnly`), cap 30. Lege array voor uitgelogd
    of zonder profiel-input (geen saves én geen follows). */
export async function getForYouEvents(
  opts: { weekOnly?: boolean; tonight?: boolean } = {},
): Promise<ApiEvent[]> {
  const params = new URLSearchParams();
  if (opts.tonight) {
    params.set('window', 'tonight');
    params.set('limit', '6');
  } else if (opts.weekOnly) {
    params.set('week', '1');
  }
  const qs = params.toString();
  const { events } = await authedRequest<{ events: ApiEvent[] }>(
    `/events/for-you${qs ? `?${qs}` : ''}`,
  );
  return events;
}

/** "Voor jou" feed-mode — chronologisch gesorteerd, cursor-pagination
    voor infinite scroll op `/voor-jou`. Backend: GET
    /events/for-you?mode=feed&cursor=...&limit=20&category=Film. */
export async function getForYouFeed(
  opts: {
    cursor?: string | null;
    limit?: number;
    /** Eén of meer categorieën — joined met komma's voor het endpoint
        (`?category=Muziek,Film`). Lege array = geen filter. */
    categories?: ApiEvent['category'][];
  } = {},
): Promise<{ events: ApiEvent[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ mode: 'feed' });
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.categories && opts.categories.length > 0) {
    params.set('category', opts.categories.join(','));
  }
  return authedRequest<{ events: ApiEvent[]; nextCursor: string | null }>(
    `/events/for-you?${params.toString()}`,
  );
}

/**
 * "Net binnen sinds X": events met createdAt > since. Gebruikt voor de
 * shortcut-badge + primaire lijst op /new.
 */
/**
 * De vier banen waarin je een avond kiest (plus een restbak voor kunst,
 * lezingen en literatuur). Server leidt 'm af per occurrence — zie
 * LANE_SQL in `routes/events.ts`.
 */
export const LANES = ['film', 'theater', 'live', 'club', 'kunst'] as const;
export type Lane = (typeof LANES)[number];

export type NewArrivals = {
  events: ApiEvent[];
  /** Aantal events dat aan het filter voldoet vóór de cap — voedt
      "15 van 47" en de meer-knop. */
  total: number;
  /** Per baan het aantal events, altijd ongefilterd geteld zodat de
      chips laten zien wat je wegklikt. */
  laneCounts: Record<Lane, number>;
};

export async function getNewEventsSince(
  since: Date,
  opts: { lanes?: Lane[]; limit?: number } = {}
): Promise<NewArrivals> {
  const params = new URLSearchParams({ since: since.toISOString() });
  if (opts.lanes && opts.lanes.length > 0)
    params.set('lane', opts.lanes.join(','));
  if (opts.limit) params.set('limit', String(opts.limit));
  return authedRequest<NewArrivals>(`/events/new?${params.toString()}`);
}

/** Slanke venue-shape voor de search-resultaten lijst. */
export type ApiSearchVenue = {
  id: string;
  slug: string;
  name: string;
  address: string;
  type: VenueType | null;
  wijk: VenueWijk | null;
  imageUrl: string | null;
  lat: number;
  lng: number;
};

export type SearchResponse = {
  venues: ApiSearchVenue[];
  events: ApiEvent[];
  eventsHasMore: boolean;
};

/**
 * IMDB-stijl globale zoek. `q` is required; eventsOffset paginate't
 * alleen de events-sectie (venues komen op de eerste pagina mee).
 */
export async function search(
  q: string,
  eventsOffset = 0
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q });
  if (eventsOffset > 0) params.set('eventsOffset', String(eventsOffset));
  return authedRequest<SearchResponse>(`/search?${params.toString()}`);
}

// ─── Conversationele zoek ("Andreas-gids") ──────────────────────────────────
// Stateless: client houdt profile + history vast (React/Zustand state) en
// stuurt die elke beurt mee; server geeft het bijgewerkte profiel terug.
// Backend: POST /zoek (apps/api/src/routes/zoek.ts). Types lokaal, net als
// ApiEvent — packages/shared is niet in mobile gewired.

export type PriceTier = 0 | 1 | 2 | 3;
export type ZoekWhen =
  | 'tonight'
  | 'this_weekend'
  | 'this_week'
  | 'this_month'
  | 'this_year'
  | 'next_weekend'
  | 'next_week'
  | 'next_month'
  | 'specific';

export type PreferenceProfile = {
  want: string[];
  avoid: string[];
  excludeVenueIds: string[];
  excludeEventIds: string[];
  maxDistanceKm: number | null;
  priceMax: PriceTier | null;
  when: ZoekWhen;
  whenDate?: string;
  origin?: { lat: number; lng: number };
};

export const EMPTY_PROFILE: PreferenceProfile = {
  want: [],
  avoid: [],
  excludeVenueIds: [],
  excludeEventIds: [],
  maxDistanceKm: null,
  priceMax: null,
  when: 'tonight',
};

export type ZoekChatTurn = { role: 'user' | 'assistant'; content: string };

export type ZoekRequest = {
  message: string;
  profile: PreferenceProfile;
  history: ZoekChatTurn[];
};

export type ZoekResponse = {
  reply: string;
  /** Volledige DB-events in `ApiEvent`-shape — bron van waarheid voor de
      UI. Render kaarten hieruit, nooit uit `reply`. */
  events: ApiEvent[];
  reasonByEventId: Record<string, string>;
  updatedProfile: PreferenceProfile;
  needsMoreInfo?: string;
};

/** Eén gespreksbeurt. Retry't bij netwerkfouten of 5xx (de API-machine kan
    op Fly in slaap staan en koud opstarten → eerste poging faalt soms). Niet
    bij 4xx (auth/validatie/limiet) — die lossen niet op met opnieuw proberen. */
export async function postZoek(req: ZoekRequest): Promise<ZoekResponse> {
  const body = JSON.stringify(req);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await authedRequest<ZoekResponse>('/zoek', { method: 'POST', body });
    } catch (e) {
      lastErr = e;
      const status = e instanceof ApiError ? e.status : 0;
      const retryable = !(e instanceof ApiError) || status >= 500;
      if (!retryable || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Laatste N events sowieso — fallback-query voor /new wanneer er sinds
 * de vorige sessie 0 nieuwe items zijn. Default 10.
 */
export async function getRecentEvents(limit = 10): Promise<ApiEvent[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const { events } = await authedRequest<{ events: ApiEvent[] }>(
    `/events/new?${params.toString()}`
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

// ─── Artists ───────────────────────────────────────────────────────────

export type ApiArtist = {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  spotifyUrl: string | null;
  appleMusicUrl: string | null;
  bandcampUrl: string | null;
  youtubeUrl: string | null;
  officialUrl: string | null;
  genres: string[];
};

export type ApiArtistEvent = {
  id: string;
  title: string;
  imageUrl: string | null;
  posterUrl: string | null;
  stillUrl: string | null;
  category: ApiEvent['category'];
  nextOccurrence: {
    id: string;
    startsAt: string;
    endsAt: string | null;
  };
  venue: {
    id: string;
    slug: string;
    name: string;
    type: VenueType | null;
  };
};

export type ApiArtistDetail = {
  artist: ApiArtist;
  events: ApiArtistEvent[];
};

export async function getArtist(slug: string): Promise<ApiArtistDetail> {
  return await authedRequest<ApiArtistDetail>(
    `/artists/${encodeURIComponent(slug)}`
  );
}

// ─── Agenda — lean lijst-endpoint ──────────────────────────────────────
// Dedicated endpoints voor de Agenda-tab. Splitsen van het zware /events
// in twee lichte requests: één voor de day-strip (alleen tellingen), en
// één per dag voor de rij-data. Bespaart 90%+ van het JSON-volume t.o.v.
// de oude "fetch alle toekomstige events".

export type AgendaFilters = {
  categories?: ApiEvent['category'][];
  venueTypes?: VenueType[];
  /** Time-blocks: ochtend (6-12), middag (12-18), avond (18-23),
      nacht (23-06). Server-side gefilterd zodat de day-strip kloppende
      tellingen toont. */
  blocks?: string[];
  q?: string;
  onlyFollowed?: boolean;
  onlyFriends?: boolean;
};

export type AgendaDayCount = {
  /** YYYY-MM-DD in NL-local met 06:00-cutoff (een 02:00-club-show valt
      onder de avond ervoor). */
  date: string;
  count: number;
};

export type AgendaRow = {
  /** Identieke string als `occurrenceId` — handig voor key-extractor. */
  id: string;
  occurrenceId: string;
  eventId: string;
  startsAt: string;
  endsAt: string | null;
  title: string;
  category: ApiEvent['category'];
  kind: 'show' | 'exhibition';
  imageUrl: string | null;
  /** Verticale poster (TMDb of venue-poster), voor lijst-thumb.
      Fallback-chain: posterUrl → imageUrl → venueImageUrl. */
  posterUrl: string | null;
  /** Eerste genre als de event er een heeft (techno/jazz/drama/...). */
  genre: string | null;
  /** Eerste series-naam (bv. "ADE 2026") als het event in series zit. */
  seriesName: string | null;
  venueId: string;
  venueName: string;
  venueType: VenueType | null;
  /** Venue-image als fallback voor de thumb wanneer event.imageUrl
      ontbreekt — voorkomt lege thumb in agenda-rijen. */
  venueImageUrl: string | null;
  friendsSaved: { name: string; avatarUrl: string | null }[];
  friendsSavedCount: number;
  venueFollowed: boolean;
};

function buildAgendaQuery(filters: AgendaFilters): URLSearchParams {
  const p = new URLSearchParams();
  for (const c of filters.categories ?? []) p.append('category', c);
  for (const vt of filters.venueTypes ?? []) p.append('venueType', vt);
  for (const b of filters.blocks ?? []) p.append('block', b);
  if (filters.q && filters.q.trim().length > 0) p.set('q', filters.q.trim());
  if (filters.onlyFollowed) p.set('onlyFollowed', 'true');
  if (filters.onlyFriends) p.set('onlyFriends', 'true');
  return p;
}

export async function getAgendaDays(input: {
  from: string;
  to: string;
  filters?: AgendaFilters;
}): Promise<AgendaDayCount[]> {
  const params = buildAgendaQuery(input.filters ?? {});
  params.set('from', input.from);
  params.set('to', input.to);
  const { days } = await authedRequest<{ days: AgendaDayCount[] }>(
    `/events/agenda/days?${params.toString()}`
  );
  return days;
}

export async function getAgendaDay(input: {
  date: string;
  /** Laatste dag van de reeks (YYYY-MM-DD). Weglaten = alleen `date`. */
  toDate?: string;
  /** Optionele cutoff: events met effectieve eindtijd vóór deze tijd
      worden weggefilterd. Bedoeld voor "vandaag" zodat een 14:00-show
      om 16:30 niet meer in de lijst staat. */
  from?: string;
  filters?: AgendaFilters;
}): Promise<AgendaRow[]> {
  const params = buildAgendaQuery(input.filters ?? {});
  params.set('date', input.date);
  if (input.toDate) params.set('to', input.toDate);
  if (input.from) params.set('from', input.from);
  const { rows } = await authedRequest<{ rows: AgendaRow[] }>(
    `/events/agenda?${params.toString()}`
  );
  return rows;
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

/** Aanbevolen-onboarding scene → server-mapping. */
export type AanbevolenScene =
  | 'dansen'
  | 'concerten'
  | 'klassiek_jazz'
  | 'theater'
  | 'film'
  | 'kunst'
  | 'lezingen';
export type AanbevolenFlavor = 'mainstream' | 'alternatief' | 'niche';

/** Minimale venue-shape voor de bootstrap-preview — alleen wat de
    picker-tiles nodig hebben. */
export type BootstrapVenue = {
  id: string;
  slug: string;
  name: string;
  type: VenueType | null;
  scene: 'mainstream' | 'alternatief' | 'underground' | 'fringe' | null;
  subtype: string[] | null;
  imageUrl: string | null;
  wijk: string | null;
  categories: VenueCategory[];
};

/** Preview voor de Aanbevolen-onboarding. Geen DB-writes; alleen
    suggesties op basis van scenes + flavor. Selected = perfecte match,
    maybe = naburige flavor of ongetagd. */
export async function getBootstrapSuggestions(input: {
  scenes: AanbevolenScene[];
  flavor: AanbevolenFlavor;
}): Promise<{ selected: BootstrapVenue[]; maybe: BootstrapVenue[] }> {
  const params = new URLSearchParams({
    scenes: input.scenes.join(','),
    flavor: input.flavor,
  });
  return await authedRequest<{
    selected: BootstrapVenue[];
    maybe: BootstrapVenue[];
  }>(`/venue-follows/bootstrap-suggestions?${params.toString()}`);
}

/** Bulk follow — alle ids worden upserted naar state='volgen'. Niet-
    bestaande venues worden stilzwijgend overgeslagen. */
export async function bulkFollowVenues(
  venueIds: string[],
): Promise<{ followed: number }> {
  return await authedRequest<{ followed: number }>('/venue-follows/bulk', {
    method: 'POST',
    body: JSON.stringify({ venueIds }),
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
  /** Toegang tot de conversationele zoek ("Andreas-gids"). Opt-in per
      gebruiker via admin; bepaalt of de "Vraag de gids"-banner verschijnt. */
  guideEnabled: boolean;
  /** Wanneer je /new voor het laatst bekeek, serverkant. Alleen gevuld
      voor echte accounts; laat het inhaal-venster een nieuwe telefoon
      overleven. ISO-string of null. */
  lastSeenNewAt?: string | null;
  createdAt: string;
};

/** Markeer /new als gezien op de server. Stil falen: dit is een
    comfort-feature, geen reden om de gebruiker iets te melden. */
export async function markNewSeenOnServer(): Promise<void> {
  try {
    await authedRequest('/me/seen-new', { method: 'POST' });
  } catch {
    // stil
  }
}

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
  | 'new'
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
  occurrenceId: string,
  source?: SaveSource | null
): Promise<{ dismissed: boolean }> {
  return await authedRequest<{ dismissed: boolean }>('/dismisses', {
    method: 'POST',
    body: JSON.stringify({ occurrenceId, source: source ?? undefined }),
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

export async function deleteGroup(id: string): Promise<{ ok: true }> {
  return await authedRequest<{ ok: true }>(`/groups/${id}`, {
    method: 'DELETE',
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
  /** Alleen gevuld door `/events/new`: in welke baan dit event valt. */
  lane?: Lane;
  /** Alleen `/events/new`: hoeveel datums er sinds `since` bij kwamen. */
  newOccurrenceCount?: number;
  /** Alleen `/events/new`: bestond het event zelf nog niet (true), of
      kreeg een bestaand event er datums bij (false)? */
  isNewEvent?: boolean;
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
