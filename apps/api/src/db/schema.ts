import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ─── Enums ────────────────────────────────────────────────────────────────

export const modePref = pgEnum('mode_pref', ['nacht', 'dag']);
export const eventCategory = pgEnum('event_category', [
  'Muziek',
  'Theater',
  'Literatuur',
  'Film',
]);
export const friendshipStatus = pgEnum('friendship_status', [
  'pending',
  'accepted',
]);
export const inviteStatus = pgEnum('invite_status', [
  'pending',
  'accepted',
  'declined',
]);
export const savesVisibility = pgEnum('saves_visibility', [
  'friends',
  'private',
]);
export const venueFollowState = pgEnum('venue_follow_state', [
  'volgen',
  'blokken',
]);
export const venueType = pgEnum('venue_type', [
  'galerie',
  'museum',
  'podium',
  'club',
  'film',
  'ruimte',
  'boekhandel-cafe',
]);
export const dayNight = pgEnum('day_night', ['day', 'night', 'both']);
export const wijk = pgEnum('wijk', [
  'centrum',
  'noord',
  'oost',
  'west',
  'zuid',
  'zuidoost',
  'nieuw-west',
]);

// ─── Domain ───────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: text().primaryKey(),
    phoneNumber: text().notNull(),
    phoneNumberVerified: boolean().notNull().default(false),
    /** Andreas-handle. Wordt later in onboarding ingesteld; bij
        phone-OTP signup nog niet bekend. */
    handle: text(),
    /** Display-name. better-auth verwacht dit veld. Default leeg. */
    name: text().notNull().default(''),
    /** Optioneel email-adres als recovery; phone-OTP signup heeft geen email. */
    email: text(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    avatarUrl: text(),
    modePreference: modePref().notNull().default('nacht'),
    /** Mogen vrienden zien welke events ik heb opgeslagen (friend-pills,
        events-lijst op friend-detail)? Default `friends` (open). */
    savesVisibility: savesVisibility().notNull().default('friends'),
    /** Verschijn ik in `/users/search` voor mensen die mij nog niet
        kennen? Default `true`. Bestaande vrienden + verzoek-flow blijven
        werken ongeacht deze flag. */
    discoverable: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('users_phone_number_idx').on(t.phoneNumber),
    uniqueIndex('users_handle_idx').on(t.handle),
  ]
);

export const venues = pgTable('venues', {
  id: text().primaryKey(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  address: text().notNull(),
  lat: doublePrecision().notNull(),
  lng: doublePrecision().notNull(),
  imageUrl: text(),
  description: text(),
  /** Eén of meer categorieën — venues hebben vaak meerdere genres
      (bv. Paradiso doet Muziek + Film). Gebruikt door de
      Venues-bladerlijst voor categorie-filter. */
  categories: eventCategory()
    .array()
    .notNull()
    .default(sql`ARRAY[]::event_category[]`),
  /** Primaire venue-classifier — galerie / museum / podium / club /
      film / ruimte / boekhandel-cafe. Stuurt de chip-row op de
      Venues-tab. Optioneel zodat oude rijen blijven werken. */
  type: venueType(),
  /** Wanneer past deze venue: overdag, 's nachts, of beide. Auto-
      gefilterd op de huidige app-modus zodat dag-modus geen clubs
      voorstelt en nacht-modus geen musea. `both` is altijd zichtbaar. */
  dayNight: dayNight(),
  /** Stadsdeel — voor "in de buurt"-filter. Optioneel. */
  wijk: wijk(),
  /** Vrije tags: techno / queer / arthouse / artist-run /
      experimenteel / klassiek / etc. Niet enum want lijst groeit. */
  subtype: text()
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  /** Admin-toggle: false = verbergen uit publieke endpoints zonder
      data te verliezen (saves blijven, events blijven). Default true. */
  published: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const events = pgTable(
  'events',
  {
    id: text().primaryKey(),
    venueId: text()
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    description: text(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }),
    priceCents: integer(),
    ticketUrl: text(),
    imageUrl: text(),
    category: eventCategory().notNull(),
    /** Editorial-pick voor de Avond-tab. Curator zet deze aan. */
    featured: boolean().notNull().default(false),
    /** Admin-toggle: false = verbergen uit publieke endpoints
        (Avond/Agenda/Kaart/Gered/detail) zonder saves of invites
        kwijt te raken. Default true. */
    published: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('events_starts_at_idx').on(t.startsAt),
    index('events_venue_idx').on(t.venueId),
    index('events_featured_idx').on(t.featured),
  ]
);

export const friendships = pgTable(
  'friendships',
  {
    fromUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: friendshipStatus().notNull().default('pending'),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.fromUserId, t.toUserId] }),
    index('friendships_to_idx').on(t.toUserId),
  ]
);

export const saves = pgTable(
  'saves',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.eventId] }),
    index('saves_event_idx').on(t.eventId),
  ]
);

export const invites = pgTable(
  'invites',
  {
    id: text().primaryKey(),
    fromUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    message: text(),
    status: inviteStatus().notNull().default('pending'),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Voorkom duplicate invites tussen dezelfde from/to/event paar.
    uniqueIndex('invites_unique_idx').on(t.fromUserId, t.toUserId, t.eventId),
    index('invites_to_status_idx').on(t.toUserId, t.status),
    index('invites_event_idx').on(t.eventId),
  ]
);

export const series = pgTable('series', {
  id: text().primaryKey(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  imageUrl: text(),
  /** Optionele datum-range (bv. ADE 14 – 18 okt). Eén of beide kunnen leeg
      zijn voor doorlopende cycli zonder vast eindpunt. */
  startsAt: timestamp({ withTimezone: true }),
  endsAt: timestamp({ withTimezone: true }),
  categories: eventCategory()
    .array()
    .notNull()
    .default(sql`ARRAY[]::event_category[]`),
  /** Admin-toggle: false = verbergen uit publieke endpoints
      (pills + Venues-tab) zonder de koppelingen kwijt te raken. */
  published: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const eventsInSeries = pgTable(
  'events_in_series',
  {
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    seriesId: text()
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.seriesId] }),
    index('eis_series_idx').on(t.seriesId),
    index('eis_event_idx').on(t.eventId),
  ]
);

export const venueFollows = pgTable(
  'venue_follows',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    venueId: text()
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    /** Expliciete staat: `volgen` (boost in feed) of `blokken`
        (verbergt deze venue overal). Geen rij = `normaal` (default,
        geen voorkeur). */
    state: venueFollowState().notNull().default('volgen'),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.userId, t.venueId] })]
);

// ─── better-auth tables ───────────────────────────────────────────────────
// Mirrors the schema better-auth expects. The `account` table is required
// even for phone-OTP because better-auth uses it to link authenticators
// (phone, future Apple Sign-In, etc.) to a user.

export const session = pgTable('session', {
  id: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  ipAddress: text(),
  userAgent: text(),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const account = pgTable('account', {
  id: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  providerId: text().notNull(),
  accountId: text().notNull(),
  password: text(),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const verification = pgTable('verification', {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
