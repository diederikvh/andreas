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

// ─── Domain ───────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: text().primaryKey(),
    phone: text().notNull(),
    handle: text().notNull(),
    name: text().notNull(),
    avatarUrl: text(),
    modePreference: modePref().notNull().default('nacht'),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('users_phone_idx').on(t.phone),
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
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('events_starts_at_idx').on(t.startsAt),
    index('events_venue_idx').on(t.venueId),
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

export const venueFollows = pgTable(
  'venue_follows',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    venueId: text()
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
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
});
