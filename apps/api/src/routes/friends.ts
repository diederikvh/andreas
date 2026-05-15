import { and, asc, desc, eq, ilike, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';
import { sendPushToUser } from '../push.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const friendsRoute = new Hono();

/**
 * Public profile-fields voor friend-views. Phone/email blijven achter.
 */
const publicUserCols = {
  id: schema.users.id,
  name: schema.users.name,
  handle: schema.users.handle,
  avatarUrl: schema.users.avatarUrl,
};

friendsRoute.get('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  // Beide richtingen: ik ben de from-kant of de to-kant van een
  // accepted friendship. We projecteren de "andere" user.
  const outgoing = await db
    .select({
      id: publicUserCols.id,
      name: publicUserCols.name,
      handle: publicUserCols.handle,
      avatarUrl: publicUserCols.avatarUrl,
      since: schema.friendships.createdAt,
    })
    .from(schema.friendships)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.friendships.toUserId)
    )
    .where(
      and(
        eq(schema.friendships.fromUserId, me),
        eq(schema.friendships.status, 'accepted')
      )
    );

  const incoming = await db
    .select({
      id: publicUserCols.id,
      name: publicUserCols.name,
      handle: publicUserCols.handle,
      avatarUrl: publicUserCols.avatarUrl,
      since: schema.friendships.createdAt,
    })
    .from(schema.friendships)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.friendships.fromUserId)
    )
    .where(
      and(
        eq(schema.friendships.toUserId, me),
        eq(schema.friendships.status, 'accepted')
      )
    );

  // Combineer — geen duplicates omdat we maar één row per friendship
  // gebruiken (de from-kant is de aanvrager).
  const combined = [...outgoing, ...incoming];

  // Mijn favorieten ophalen, joinen op friend-ids voor de `favorite`-flag
  // en alvast als sorteer-key. Favorieten eerst (alfabetisch), dan de
  // rest (ook alfabetisch).
  const friendIds = combined.map((f) => f.id);
  const favs =
    friendIds.length === 0
      ? []
      : await db
          .select({ friendId: schema.friendFavorites.friendId })
          .from(schema.friendFavorites)
          .where(
            and(
              eq(schema.friendFavorites.userId, me),
              inArray(schema.friendFavorites.friendId, friendIds)
            )
          );
  const favSet = new Set(favs.map((f) => f.friendId));

  const friends = combined
    .map((f) => ({ ...f, favorite: favSet.has(f.id) }))
    .sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return c.json({ friends });
});

friendsRoute.get('/outgoing', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const outgoing = await db
    .select({
      id: publicUserCols.id,
      name: publicUserCols.name,
      handle: publicUserCols.handle,
      avatarUrl: publicUserCols.avatarUrl,
      requestedAt: schema.friendships.createdAt,
    })
    .from(schema.friendships)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.friendships.toUserId)
    )
    .where(
      and(
        eq(schema.friendships.fromUserId, me),
        eq(schema.friendships.status, 'pending')
      )
    )
    .orderBy(desc(schema.friendships.createdAt));

  return c.json({ outgoing });
});

friendsRoute.get('/requests', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const requests = await db
    .select({
      id: publicUserCols.id,
      name: publicUserCols.name,
      handle: publicUserCols.handle,
      avatarUrl: publicUserCols.avatarUrl,
      requestedAt: schema.friendships.createdAt,
    })
    .from(schema.friendships)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.friendships.fromUserId)
    )
    .where(
      and(
        eq(schema.friendships.toUserId, me),
        eq(schema.friendships.status, 'pending')
      )
    )
    .orderBy(desc(schema.friendships.createdAt));

  return c.json({ requests });
});

friendsRoute.post('/request', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as { handle?: string };
  const handle = (body.handle ?? '').trim().toLowerCase();
  if (!handle) return c.json({ error: 'handle is verplicht' }, 400);

  const [target] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.handle, handle))
    .limit(1);
  if (!target) return c.json({ error: 'Deze handle bestaat niet.' }, 404);
  if (target.id === me) {
    return c.json({ error: 'Jezelf toevoegen kan niet.' }, 400);
  }

  // Bestaat de andere kant al pending? Dan accepten en klaar.
  const [reverse] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.fromUserId, target.id),
        eq(schema.friendships.toUserId, me)
      )
    )
    .limit(1);
  if (reverse) {
    if (reverse.status !== 'accepted') {
      await db
        .update(schema.friendships)
        .set({ status: 'accepted' })
        .where(
          and(
            eq(schema.friendships.fromUserId, target.id),
            eq(schema.friendships.toUserId, me)
          )
        );
      // Auto-accept-pad: target had mij al toegevoegd, ik antwoord
      // met een /request en daarmee accepteren we hun pending. Push
      // de target ("je verzoek is geaccepteerd").
      await sendPushFromMe(me, target.id, 'accepted');
    }
    return c.json({ status: 'accepted' });
  }

  // Bestaat onze richting al? Dan idempotent terug.
  const [existing] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.fromUserId, me),
        eq(schema.friendships.toUserId, target.id)
      )
    )
    .limit(1);
  if (existing) {
    return c.json({ status: existing.status });
  }

  await db.insert(schema.friendships).values({
    fromUserId: me,
    toUserId: target.id,
    status: 'pending',
  });
  await sendPushFromMe(me, target.id, 'request');
  return c.json({ status: 'pending' });
});

friendsRoute.post('/accept', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as { fromUserId?: string };
  const fromUserId = body.fromUserId;
  if (!fromUserId) {
    return c.json({ error: 'fromUserId is verplicht' }, 400);
  }

  const [row] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.fromUserId, fromUserId),
        eq(schema.friendships.toUserId, me),
        eq(schema.friendships.status, 'pending')
      )
    )
    .limit(1);
  if (!row) {
    return c.json({ error: 'Geen openstaand verzoek.' }, 404);
  }

  await db
    .update(schema.friendships)
    .set({ status: 'accepted' })
    .where(
      and(
        eq(schema.friendships.fromUserId, fromUserId),
        eq(schema.friendships.toUserId, me)
      )
    );
  // Push de oorspronkelijke aanvrager dat ik 'm geaccepteerd heb.
  await sendPushFromMe(me, fromUserId, 'accepted');
  return c.json({ status: 'accepted' });
});

friendsRoute.post('/decline', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as { fromUserId?: string };
  const fromUserId = body.fromUserId;
  if (!fromUserId) {
    return c.json({ error: 'fromUserId is verplicht' }, 400);
  }

  await db
    .delete(schema.friendships)
    .where(
      and(
        eq(schema.friendships.fromUserId, fromUserId),
        eq(schema.friendships.toUserId, me),
        eq(schema.friendships.status, 'pending')
      )
    );
  return c.json({ ok: true });
});

friendsRoute.get('/:id', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const friendId = c.req.param('id');
  if (friendId === me) {
    return c.json({ error: 'Niet je eigen profiel via deze route.' }, 400);
  }

  // TODO (privacy): later checken op users.privacy / per-friendship
  // visibility-flag voordat we hun saves teruggeven.
  const [friendship] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.status, 'accepted'),
        or(
          and(
            eq(schema.friendships.fromUserId, me),
            eq(schema.friendships.toUserId, friendId)
          ),
          and(
            eq(schema.friendships.fromUserId, friendId),
            eq(schema.friendships.toUserId, me)
          )
        )
      )
    )
    .limit(1);
  if (!friendship) {
    return c.json({ error: 'Niet bevriend.' }, 403);
  }

  const [user] = await db
    .select({
      ...publicUserCols,
      savesVisibility: schema.users.savesVisibility,
      mirrorVisibility: schema.users.mirrorVisibility,
    })
    .from(schema.users)
    .where(eq(schema.users.id, friendId))
    .limit(1);
  if (!user) return c.json({ error: 'user not found' }, 404);

  // Privacy-gate: als de friend z'n saves prive heeft staan, retourneren
  // we een leeg events-lijstje. We tonen wel het profiel zelf — zo weet
  // ik nog dat we vrienden zijn, alleen geen activiteiten.
  // Heeft de vriend mij als favoriet gemarkeerd? Bepaalt of 'favorites'-
  // visibility-rules me toegang geven.
  const [favOfMe] = await db
    .select({ userId: schema.friendFavorites.userId })
    .from(schema.friendFavorites)
    .where(
      and(
        eq(schema.friendFavorites.userId, friendId),
        eq(schema.friendFavorites.friendId, me)
      )
    )
    .limit(1);
  const friendHasMeAsFav = Boolean(favOfMe);

  // savesPrivate = ik mag de events-lijst NIET zien.
  const isPrivate =
    user.savesVisibility === 'private' ||
    (user.savesVisibility === 'favorites' && !friendHasMeAsFav);
  // mirrorShared = ik mag de spiegel-subset zien.
  const mirrorShared =
    user.mirrorVisibility === 'friends' ||
    (user.mirrorVisibility === 'favorites' && friendHasMeAsFav);

  // Heb ik deze vriend als favoriet gemarkeerd? (Voor de UI-button.)
  const [fav] = await db
    .select({ userId: schema.friendFavorites.userId })
    .from(schema.friendFavorites)
    .where(
      and(
        eq(schema.friendFavorites.userId, me),
        eq(schema.friendFavorites.friendId, friendId)
      )
    )
    .limit(1);
  const favorite = Boolean(fav);
  let events: Array<Record<string, unknown>> = [];
  if (!isPrivate) {
    // Saves zijn nu per occurrence — één rij per gesaveterde voorstelling
    // ipv per event. Een friend die 3 voorstellingen van dezelfde film
    // heeft gesaved geeft 3 rijen.
    const rows = await db
      .select({
        id: schema.events.id,
        title: schema.events.title,
        description: schema.events.description,
        kind: schema.events.kind,
        imageUrl: schema.events.imageUrl,
        category: schema.events.category,
        featured: schema.events.featured,
        // occurrence-veld
        occurrenceId: schema.occurrences.id,
        startsAt: schema.occurrences.startsAt,
        endsAt: schema.occurrences.endsAt,
        priceCents: schema.occurrences.priceCents,
        priceNote: schema.occurrences.priceNote,
        ticketUrl: schema.occurrences.ticketUrl,
        room: schema.occurrences.room,
        lineup: schema.occurrences.lineup,
        status: schema.occurrences.status,
        savedAt: schema.saves.createdAt,
        venue: {
          id: schema.venues.id,
          slug: schema.venues.slug,
          name: schema.venues.name,
          address: schema.venues.address,
          lat: schema.venues.lat,
          lng: schema.venues.lng,
          imageUrl: schema.venues.imageUrl,
          priceNote: schema.venues.priceNote,
        },
      })
      .from(schema.saves)
      .innerJoin(
        schema.occurrences,
        eq(schema.occurrences.id, schema.saves.occurrenceId)
      )
      .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
      .where(
        and(
          eq(schema.saves.userId, friendId),
          eq(schema.events.published, true),
          eq(schema.venues.published, true)
        )
      );

    const now = Date.now();
    events = rows.sort((a, b) => {
      const aT = a.startsAt.getTime();
      const bT = b.startsAt.getTime();
      const aFuture = aT >= now;
      const bFuture = bT >= now;
      if (aFuture && !bFuture) return -1;
      if (!aFuture && bFuture) return 1;
      if (aFuture) return aT - bT;
      return bT - aT;
    });
  }

  // savesVisibility en mirrorVisibility hoeven niet naar de client; we
  // exposeren alleen de afgeleide booleans `savesPrivate` + `mirrorShared`.
  const {
    savesVisibility: _omitSaves,
    mirrorVisibility: _omitMirror,
    ...publicUser
  } = user;
  return c.json({
    user: publicUser,
    events,
    savesPrivate: isPrivate,
    mirrorShared,
    favorite,
  });
});

/**
 * Toggle / set favoriet-status voor een vriend. Idempotent: PUT met
 * `{ favorite: true }` upsert, `false` verwijdert. Vereist accepted
 * friendship — anders 403.
 */
friendsRoute.put('/:id/favorite', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const friendId = c.req.param('id');
  if (friendId === me) {
    return c.json({ error: 'Niet je eigen profiel via deze route.' }, 400);
  }

  const body = (await c.req.json()) as { favorite?: boolean };
  if (typeof body.favorite !== 'boolean') {
    return c.json({ error: 'favorite moet boolean zijn.' }, 400);
  }

  // Friendship-gate: alleen accepted friends mogen gemarkeerd worden.
  const [friendship] = await db
    .select({ ok: schema.friendships.status })
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.status, 'accepted'),
        or(
          and(
            eq(schema.friendships.fromUserId, me),
            eq(schema.friendships.toUserId, friendId)
          ),
          and(
            eq(schema.friendships.fromUserId, friendId),
            eq(schema.friendships.toUserId, me)
          )
        )
      )
    )
    .limit(1);
  if (!friendship) return c.json({ error: 'Niet bevriend.' }, 403);

  if (body.favorite) {
    await db
      .insert(schema.friendFavorites)
      .values({ userId: me, friendId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.friendFavorites)
      .where(
        and(
          eq(schema.friendFavorites.userId, me),
          eq(schema.friendFavorites.friendId, friendId)
        )
      );
  }
  return c.json({ favorite: body.favorite });
});

friendsRoute.delete('/:userId', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const userId = c.req.param('userId');
  // Verwijder elke friendship tussen mij en deze user, in beide richtingen.
  await db
    .delete(schema.friendships)
    .where(
      or(
        and(
          eq(schema.friendships.fromUserId, me),
          eq(schema.friendships.toUserId, userId)
        ),
        and(
          eq(schema.friendships.fromUserId, userId),
          eq(schema.friendships.toUserId, me)
        )
      )
    );
  return c.json({ ok: true });
});

// Aparte voor user-search; op handle prefix-match. Geeft ook de
// huidige relatie-status terug zodat de UI per resultaat de juiste
// actie kan tonen.
export const usersRoute = new Hono();

usersRoute.get('/search', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  if (q.length < 2) return c.json({ users: [] });

  // Privacy-gate: alleen users met `discoverable = true` verschijnen
  // in zoekresultaten. Bestaande vrienden blijven via /friends bereik-
  // baar; mensen die jou een verzoek hebben gestuurd staan in
  // /friends/requests.
  //
  // Match-strategie: handle-prefix (snelste, meest specifiek) OF
  // name-substring (vriendelijker — "Pieter van" → vindt). Beide
  // gecapt op 20 hits zodat we geen ronde-trip-perf-issues krijgen.
  const rows = await db
    .select({
      id: publicUserCols.id,
      name: publicUserCols.name,
      handle: publicUserCols.handle,
      avatarUrl: publicUserCols.avatarUrl,
    })
    .from(schema.users)
    .where(
      and(
        ne(schema.users.id, me),
        isNotNull(schema.users.handle),
        eq(schema.users.discoverable, true),
        or(
          ilike(schema.users.handle, `${q}%`),
          ilike(schema.users.name, `%${q}%`)
        )
      )
    )
    .limit(20);

  // Voor elke gevonden user: relatie-status met mij.
  const ids = rows.map((r) => r.id);
  const relations = ids.length
    ? await db
        .select()
        .from(schema.friendships)
        .where(
          or(
            and(
              eq(schema.friendships.fromUserId, me),
              inArray(schema.friendships.toUserId, ids)
            ),
            and(
              eq(schema.friendships.toUserId, me),
              inArray(schema.friendships.fromUserId, ids)
            )
          )
        )
    : [];

  const relMap = new Map<string, 'accepted' | 'incoming' | 'outgoing'>();
  for (const rel of relations) {
    if (rel.status === 'accepted') {
      const other = rel.fromUserId === me ? rel.toUserId : rel.fromUserId;
      relMap.set(other, 'accepted');
    } else if (rel.fromUserId === me) {
      relMap.set(rel.toUserId, 'outgoing');
    } else {
      relMap.set(rel.fromUserId, 'incoming');
    }
  }

  return c.json({
    users: rows.map((r) => ({
      ...r,
      relation: relMap.get(r.id) ?? null,
    })),
  });
});

/**
 * Helper voor friend-push'es. Zoekt mijn naam/handle op (voor de
 * notificatie-body) en stuurt de juiste copy naar de target. Wordt
 * apart gehouden zodat we 'm niet inline bij elke route herhalen.
 * Failures loggen we maar niet rethrowen — push-deliverability mag
 * de hoofdactie nooit blokkeren.
 */
async function sendPushFromMe(
  meId: string,
  toUserId: string,
  kind: 'request' | 'accepted'
): Promise<void> {
  try {
    const [me] = await db
      .select({ name: schema.users.name, handle: schema.users.handle })
      .from(schema.users)
      .where(eq(schema.users.id, meId))
      .limit(1);
    const display = me?.name?.trim() || (me?.handle ? `@${me.handle}` : 'Iemand');
    if (kind === 'request') {
      await sendPushToUser(toUserId, {
        title: 'Nieuwe vriend-aanvraag',
        body: `${display} wil je toevoegen`,
        data: { url: '/(tabs)/social' },
      });
    } else {
      await sendPushToUser(toUserId, {
        title: 'Nieuwe vriend',
        body: `${display} en jij zijn nu vrienden`,
        data: me?.handle
          ? { url: `/u/${me.handle}` }
          : { url: '/(tabs)/social' },
      });
    }
  } catch (err) {
    console.error('[friends] push failed', err);
  }
}
