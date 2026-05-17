// Shared types between @andreas/api and @andreas/mobile.
// Source of truth lives here — DB rows in apps/api derive from these
// and API responses are typed via these.

export type Mode = 'nacht' | 'dag';

export type EventCategory = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';

export type FriendshipStatus = 'pending' | 'accepted';

export type User = {
  id: string;
  phoneNumber: string;
  phoneNumberVerified: boolean;
  handle: string | null;
  name: string;
  avatarUrl: string | null;
  modePreference: Mode;
  createdAt: string;
};

export type PublicUser = Pick<User, 'id' | 'handle' | 'name' | 'avatarUrl'>;

export type Venue = {
  id: string;
  slug: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  imageUrl: string | null;
  description: string | null;
};

export type EventKind = 'show' | 'exhibition';

export type OccurrenceStatus = 'scheduled' | 'cancelled' | 'sold_out';

export type LineupEntry = {
  name: string;
  role?: 'dj' | 'support' | 'headliner' | 'act';
};

export type Occurrence = {
  id: string;
  eventId: string;
  startsAt: string;
  endsAt: string | null;
  priceCents: number | null;
  priceNote: string | null;
  ticketUrl: string | null;
  room: string | null;
  lineup: LineupEntry[] | null;
  status: OccurrenceStatus;
};

export type Event = {
  id: string;
  venueId: string;
  title: string;
  description: string | null;
  kind: EventKind;
  imageUrl: string | null;
  category: EventCategory;
};

export type Series = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  startsAt: string | null;
  endsAt: string | null;
  categories: EventCategory[];
};

export type SeriesSummary = Pick<Series, 'id' | 'slug' | 'name' | 'imageUrl'>;

export type Friendship = {
  fromUserId: string;
  toUserId: string;
  status: FriendshipStatus;
  createdAt: string;
};
