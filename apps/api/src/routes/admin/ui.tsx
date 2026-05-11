import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, gte, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../../db/index.js';
import {
  checkPassword,
  clearSessionCookie,
  isAuthedByCookie,
  requireAdminCookie,
  setSessionCookie,
} from './auth.js';
import {
  Layout,
  PublishedPill,
  fmtDate,
  fromDateTimeLocal,
  toDateTimeLocal,
} from './layout.js';

function shortId(): string {
  return randomBytes(5).toString('hex');
}

const CATEGORIES = ['Muziek', 'Theater', 'Literatuur', 'Film', 'Kunst'] as const;
type Category = (typeof CATEGORIES)[number];

const VENUE_TYPES = [
  'galerie',
  'museum',
  'podium',
  'club',
  'film',
  'ruimte',
  'boekhandel-cafe',
] as const;
type VenueType = (typeof VENUE_TYPES)[number];

const DAY_NIGHT = ['day', 'night', 'both'] as const;
type DayNight = (typeof DAY_NIGHT)[number];

const WIJKEN = [
  'centrum',
  'noord',
  'oost',
  'west',
  'zuid',
  'zuidoost',
  'nieuw-west',
] as const;
type Wijk = (typeof WIJKEN)[number];

const SCENES = ['mainstream', 'alternatief', 'underground', 'fringe'] as const;
type Scene = (typeof SCENES)[number];

const CAPACITIES = ['klein', 'middel', 'groot', 'xl'] as const;
type Capacity = (typeof CAPACITIES)[number];

function parseEnumField<T extends string>(
  list: readonly T[],
  value: string | undefined
): T | null {
  if (!value) return null;
  return (list as readonly string[]).includes(value) ? (value as T) : null;
}

function parseTagsField(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeInstagram(value: string): string {
  return value
    .trim()
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/\/.*$/, '')
    .trim();
}

/**
 * Image-URL veld met file-picker + auto-upload. File-select stuurt het
 * bestand naar /admin/api/uploads (cookie-auth) en zet de CDN-URL in
 * het verborgen url-veld + preview. Vergeet niet daarna op `Opslaan`
 * te klikken om het record te updaten.
 */
function ImageUrlField({
  name,
  kind,
  currentUrl,
}: {
  name: string;
  kind: 'venues' | 'events' | 'series';
  currentUrl: string;
}) {
  const id = `img-${name}-${Math.random().toString(36).slice(2, 8)}`;
  const script = `
(function () {
  const file = document.getElementById('${id}-file');
  const url = document.getElementById('${id}-url');
  const preview = document.getElementById('${id}-preview');
  const status = document.getElementById('${id}-status');
  file.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    status.textContent = 'Uploaden…';
    status.style.color = '';
    const fd = new FormData();
    fd.append('file', f);
    fd.append('kind', '${kind}');
    try {
      const r = await fetch('/admin/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || ('HTTP ' + r.status));
      }
      const data = await r.json();
      url.value = data.url;
      if (preview) {
        preview.src = data.url;
        preview.style.display = 'block';
      }
      status.textContent = '✓ Geüpload — klik op Opslaan om vast te zetten';
      status.style.color = '#9fe88a';
    } catch (err) {
      status.textContent = '✗ Upload mislukt: ' + err.message;
      status.style.color = '#f3b6b6';
    }
  });
})();
`;
  return (
    <div style="margin-bottom:1rem;">
      <label style="margin-bottom:0.25rem;display:block;">Afbeelding</label>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
        <img
          id={`${id}-preview`}
          src={currentUrl || ''}
          alt=""
          style={`width:96px;height:64px;object-fit:cover;border-radius:6px;background:var(--pico-card-background-color);${currentUrl ? '' : 'display:none;'}`}
        />
        <div style="flex:1;">
          <input
            type="file"
            id={`${id}-file`}
            accept="image/*"
            style="display:block;font-size:13px;"
          />
          <div
            id={`${id}-status`}
            style="font-size:11px;opacity:0.75;margin-top:4px;min-height:14px;"
          ></div>
        </div>
      </div>
      <input
        type="url"
        id={`${id}-url`}
        name={name}
        value={currentUrl}
        placeholder="https://… (of upload hierboven)"
        style="font-size:12px;"
      />
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </div>
  );
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parseCategoriesField(value: string | undefined): Category[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Category => (CATEGORIES as readonly string[]).includes(s));
}

export const adminUi = new Hono();

// ─── Login / logout ─────────────────────────────────────────────────────

adminUi.get('/login', (c) => {
  if (isAuthedByCookie(c)) return c.redirect('/admin');
  const error = c.req.query('error');
  return c.html(
    <Layout title="Inloggen">
      <article style="max-width:380px;margin:3rem auto;">
        <h2>Andreas admin</h2>
        <p>Voer je wachtwoord in.</p>
        {error && (
          <p style="color:#f3b6b6;font-size:13px;">Wachtwoord onjuist.</p>
        )}
        <form method="post" action="/admin/login">
          <input
            type="password"
            name="password"
            autoFocus
            required
            placeholder="wachtwoord"
            autoComplete="current-password"
          />
          <button type="submit">Inloggen</button>
        </form>
      </article>
    </Layout>
  );
});

adminUi.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const password = String(form.password ?? '');
  if (!checkPassword(password)) {
    return c.redirect('/admin/login?error=1');
  }
  setSessionCookie(c);
  return c.redirect('/admin');
});

adminUi.post('/logout', (c) => {
  clearSessionCookie(c);
  return c.redirect('/admin/login');
});

// ─── Auth gate voor alles wat hierna komt ───────────────────────────────

adminUi.use('*', requireAdminCookie);

// ─── Dashboard ──────────────────────────────────────────────────────────

adminUi.get('/', async (c) => {
  const now = new Date();
  const [eventsTotal] = await db
    .select({ n: count() })
    .from(schema.events);
  const [eventsLive] = await db
    .select({ n: count() })
    .from(schema.events)
    .where(eq(schema.events.published, true));
  // "Komend" telt distinct events met minstens één toekomstige (of nog
  // lopende, voor exhibitions) occurrence. Eén event met 100 voorstellingen
  // telt als 1.
  const upcomingDistinct = await db
    .selectDistinct({ id: schema.events.id })
    .from(schema.events)
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.eventId, schema.events.id)
    )
    .where(
      and(
        eq(schema.events.published, true),
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt}) >= ${now}`,
        sql`${schema.occurrences.status} <> 'cancelled'`
      )
    );
  const eventsUpcoming = { n: upcomingDistinct.length };
  const [venuesTotal] = await db
    .select({ n: count() })
    .from(schema.venues);
  const [seriesTotal] = await db
    .select({ n: count() })
    .from(schema.series);
  const [savesTotal] = await db
    .select({ n: count() })
    .from(schema.saves);
  const [usersTotal] = await db
    .select({ n: count() })
    .from(schema.users);

  return c.html(
    <Layout title="Overzicht" active="home">
      <h2>Overzicht</h2>
      <div class="grid-3">
        <div class="stat">
          <small>Events</small>
          <strong>{eventsUpcoming.n}</strong>
          <span style="font-size:12px;opacity:0.7;">
            komend · {eventsLive.n} live · {eventsTotal.n} totaal
          </span>
        </div>
        <div class="stat">
          <small>Venues</small>
          <strong>{venuesTotal.n}</strong>
        </div>
        <div class="stat">
          <small>Series</small>
          <strong>{seriesTotal.n}</strong>
        </div>
        <div class="stat">
          <small>Users</small>
          <strong>{usersTotal.n}</strong>
        </div>
        <div class="stat">
          <small>Saves</small>
          <strong>{savesTotal.n}</strong>
        </div>
      </div>
    </Layout>
  );
});

// ─── Events ─────────────────────────────────────────────────────────────

adminUi.get('/events', async (c) => {
  const filter = c.req.query('filter') ?? 'upcoming'; // upcoming | all | unpublished

  // We laden alle events die aan het filter voldoen, plus per event de
  // eerstvolgende occurrence. Voor 'upcoming' filteren we events die
  // geen toekomstige occurrence hebben weg.
  const conditions = [];
  if (filter === 'unpublished') {
    conditions.push(eq(schema.events.published, false));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const eventRows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      kind: schema.events.kind,
      category: schema.events.category,
      featured: schema.events.featured,
      published: schema.events.published,
      venueName: schema.venues.name,
      venueSlug: schema.venues.slug,
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(where);

  const allOcc = eventRows.length === 0
    ? []
    : await db
        .select()
        .from(schema.occurrences)
        .where(inArray(schema.occurrences.eventId, eventRows.map((r) => r.id)))
        .orderBy(asc(schema.occurrences.startsAt));

  const occByEvent = new Map<
    string,
    { next: (typeof allOcc)[number] | null; count: number }
  >();
  for (const o of allOcc) {
    let entry = occByEvent.get(o.eventId);
    if (!entry) {
      entry = { next: null, count: 0 };
      occByEvent.set(o.eventId, entry);
    }
    entry.count += 1;
    const stillFuture =
      (o.endsAt ?? o.startsAt).getTime() >= Date.now() &&
      o.status !== 'cancelled';
    if (entry.next === null && stillFuture) entry.next = o;
  }

  const rows = eventRows
    .map((r) => {
      const entry = occByEvent.get(r.id);
      return {
        ...r,
        startsAt: entry?.next?.startsAt ?? null,
        occurrenceCount: entry?.count ?? 0,
      };
    })
    .filter((r) => filter !== 'upcoming' || r.startsAt !== null)
    .sort((a, b) => {
      const aT = a.startsAt?.getTime() ?? Infinity;
      const bT = b.startsAt?.getTime() ?? Infinity;
      return aT - bT;
    });

  return c.html(
    <Layout title="Events" active="events">
      <div class="toolbar">
        <h2>Events</h2>
        <a href="/admin/events/new" role="button">+ Nieuw event</a>
      </div>
      <nav>
        <ul>
          <li>
            <a href="/admin/events?filter=upcoming" aria-current={filter === 'upcoming' ? 'page' : undefined}>
              Komend
            </a>
          </li>
          <li>
            <a href="/admin/events?filter=all" aria-current={filter === 'all' ? 'page' : undefined}>
              Alles
            </a>
          </li>
          <li>
            <a href="/admin/events?filter=unpublished" aria-current={filter === 'unpublished' ? 'page' : undefined}>
              Uitgezet
            </a>
          </li>
        </ul>
      </nav>
      <table>
        <thead>
          <tr>
            <th>Wanneer</th>
            <th>Titel</th>
            <th>Venue</th>
            <th>Categorie</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr class={r.published ? '' : 'row-unpub'}>
              <td style="white-space:nowrap;">
                {r.startsAt ? fmtDate(r.startsAt) : '—'}
                {r.occurrenceCount > 1 && (
                  <small style="opacity:0.6;"> +{r.occurrenceCount - 1}</small>
                )}
              </td>
              <td>
                <a href={`/admin/events/${encodeURIComponent(r.id)}`}>{r.title}</a>
                {r.kind === 'exhibition' && ' (tentoonstelling)'}
                {r.featured && ' ★'}
              </td>
              <td>{r.venueName}</td>
              <td>{r.category}</td>
              <td><PublishedPill published={r.published} /></td>
              <td class="actions">
                <form method="post" action={`/admin/events/${encodeURIComponent(r.id)}/toggle`}>
                  <button type="submit" class="secondary outline">
                    {r.published ? 'Uitzetten' : 'Aanzetten'}
                  </button>
                </form>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} style="text-align:center;opacity:0.6;padding:2rem;">
                Geen events.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Layout>
  );
});

adminUi.get('/events/new', async (c) => {
  const venues = await db
    .select({ id: schema.venues.id, name: schema.venues.name })
    .from(schema.venues)
    .orderBy(asc(schema.venues.name));
  return c.html(
    <Layout title="Nieuw event" active="events">
      <h2>Nieuw event</h2>
      <EventForm venues={venues} />
    </Layout>
  );
});

adminUi.post('/events/new', async (c) => {
  const form = await c.req.parseBody();
  const id = String(form.id ?? '').trim() || `evt-${shortId()}`;
  const title = String(form.title ?? '').trim();
  const venueId = String(form.venueId ?? '');
  const occurrences = parseOccurrenceForms(form);
  if (!title || !venueId) {
    return c.html(<Layout title="Fout"><p>Titel en venue verplicht.</p></Layout>, 400);
  }
  if (occurrences.length === 0) {
    return c.html(
      <Layout title="Fout"><p>Minstens één moment (occurrence) verplicht.</p></Layout>,
      400
    );
  }
  const kind = String(form.kind ?? '') === 'exhibition' ? 'exhibition' : 'show';
  await db.transaction(async (tx) => {
    await tx.insert(schema.events).values({
      id,
      title,
      venueId,
      kind,
      description: (form.description as string) || null,
      imageUrl: (form.imageUrl as string) || null,
      category: (CATEGORIES as readonly string[]).includes(String(form.category))
        ? (String(form.category) as Category)
        : 'Muziek',
      featured: form.featured === 'on',
      genres: parseTagsField(String(form.genres ?? '')),
      published: form.published !== 'off',
    });
    await tx.insert(schema.occurrences).values(
      occurrences.map((o) => ({
        id: o.id || `occ-${shortId()}`,
        eventId: id,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        priceCents: o.priceCents,
        priceNote: o.priceNote,
        ticketUrl: o.ticketUrl,
        room: o.room,
        status: o.status,
      }))
    );
  });
  return c.redirect(`/admin/events/${encodeURIComponent(id)}`);
});

/**
 * Parse de dynamische occurrence-rijen uit het admin-form. Elke rij heeft
 * inputs als `occurrences[i].startsAt` etc. — we lopen door tot we geen
 * geldige startsAt meer vinden.
 */
type ParsedOccurrence = {
  id: string;
  startsAt: Date;
  endsAt: Date | null;
  priceCents: number | null;
  priceNote: string | null;
  ticketUrl: string | null;
  room: string | null;
  status: 'scheduled' | 'cancelled' | 'sold_out';
};
function parseOccurrenceForms(
  form: Record<string, string | File>
): ParsedOccurrence[] {
  const out: ParsedOccurrence[] = [];
  for (let i = 0; i < 200; i++) {
    const startsAtRaw = form[`occurrences[${i}].startsAt`];
    if (typeof startsAtRaw !== 'string' || !startsAtRaw) continue;
    const startsAt = fromDateTimeLocal(startsAtRaw);
    if (!startsAt) continue;
    const endsAt = fromDateTimeLocal(
      String(form[`occurrences[${i}].endsAt`] ?? '')
    );
    const idVal = String(form[`occurrences[${i}].id`] ?? '').trim();
    const priceCentsRaw = form[`occurrences[${i}].priceCents`];
    const statusRaw = String(form[`occurrences[${i}].status`] ?? 'scheduled');
    const status =
      statusRaw === 'cancelled' || statusRaw === 'sold_out' || statusRaw === 'scheduled'
        ? statusRaw
        : 'scheduled';
    out.push({
      id: idVal,
      startsAt,
      endsAt,
      priceCents:
        priceCentsRaw && String(priceCentsRaw).trim() !== ''
          ? Number(priceCentsRaw)
          : null,
      priceNote: String(form[`occurrences[${i}].priceNote`] ?? '').trim() || null,
      ticketUrl: String(form[`occurrences[${i}].ticketUrl`] ?? '').trim() || null,
      room: String(form[`occurrences[${i}].room`] ?? '').trim() || null,
      status,
    });
  }
  return out;
}

adminUi.get('/events/:id', async (c) => {
  const id = c.req.param('id');
  const [event] = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.id, id))
    .limit(1);
  if (!event) return c.notFound();
  const venues = await db
    .select({ id: schema.venues.id, name: schema.venues.name })
    .from(schema.venues)
    .orderBy(asc(schema.venues.name));
  const occurrences = await db
    .select()
    .from(schema.occurrences)
    .where(eq(schema.occurrences.eventId, id))
    .orderBy(asc(schema.occurrences.startsAt));
  const linkedSeries = await db
    .select({
      id: schema.series.id,
      slug: schema.series.slug,
      name: schema.series.name,
    })
    .from(schema.eventsInSeries)
    .innerJoin(schema.series, eq(schema.series.id, schema.eventsInSeries.seriesId))
    .where(eq(schema.eventsInSeries.eventId, id))
    .orderBy(asc(schema.series.name));

  return c.html(
    <Layout title={event.title} active="events">
      <div class="toolbar">
        <h2>{event.title}</h2>
        <PublishedPill published={event.published} />
      </div>
      <EventForm event={event} occurrences={occurrences} venues={venues} />
      {linkedSeries.length > 0 && (
        <article style="margin-top:1.5rem;">
          <header>Onderdeel van</header>
          <ul>
            {linkedSeries.map((s) => (
              <li>
                <a href={`/admin/series/${s.id}`}>{s.name}</a>
              </li>
            ))}
          </ul>
          <small style="opacity:0.7;">Beheer series-koppelingen op de serie-pagina.</small>
        </article>
      )}
      <details style="margin-top:2rem;">
        <summary>Verwijderen</summary>
        <form
          method="post"
          action={`/admin/events/${encodeURIComponent(event.id)}/delete`}
          onsubmit="return confirm('Echt verwijderen? Saves en invites gaan ook weg.');"
        >
          <button type="submit" class="contrast outline">Permanent verwijderen</button>
        </form>
      </details>
    </Layout>
  );
});

adminUi.post('/events/:id', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.parseBody();
  const occurrences = parseOccurrenceForms(form);
  if (occurrences.length === 0) {
    return c.html(
      <Layout title="Fout"><p>Minstens één moment (occurrence) verplicht.</p></Layout>,
      400
    );
  }
  const kind = String(form.kind ?? '') === 'exhibition' ? 'exhibition' : 'show';

  await db.transaction(async (tx) => {
    await tx
      .update(schema.events)
      .set({
        title: String(form.title ?? '').trim(),
        venueId: String(form.venueId ?? ''),
        kind,
        description: (form.description as string) || null,
        imageUrl: (form.imageUrl as string) || null,
        category: (CATEGORIES as readonly string[]).includes(String(form.category))
          ? (String(form.category) as Category)
          : 'Muziek',
        featured: form.featured === 'on',
        genres: parseTagsField(String(form.genres ?? '')),
        published: form.published !== 'off',
      })
      .where(eq(schema.events.id, id));

    // Sync occurrences. Strategie: alle bestaande occurrences voor dit
    // event verwijderen die niet meer in de form zitten, dan upsert per
    // form-rij. We bewaren bestaande IDs zodat invites die ernaar
    // verwijzen blijven werken (FK is cascade — verwijderen zou invites
    // ook stilletjes droppen).
    const formIds = new Set(occurrences.map((o) => o.id).filter(Boolean));
    if (formIds.size > 0) {
      await tx
        .delete(schema.occurrences)
        .where(
          and(
            eq(schema.occurrences.eventId, id),
            sql`${schema.occurrences.id} NOT IN (${sql.join(
              [...formIds].map((x) => sql`${x}`),
              sql`, `
            )})`
          )
        );
    } else {
      await tx
        .delete(schema.occurrences)
        .where(eq(schema.occurrences.eventId, id));
    }

    for (const occ of occurrences) {
      const occId = occ.id || `occ-${shortId()}`;
      const values = {
        eventId: id,
        startsAt: occ.startsAt,
        endsAt: occ.endsAt,
        priceCents: occ.priceCents,
        priceNote: occ.priceNote,
        ticketUrl: occ.ticketUrl,
        room: occ.room,
        status: occ.status,
      };
      if (occ.id) {
        await tx
          .update(schema.occurrences)
          .set(values)
          .where(eq(schema.occurrences.id, occ.id));
      } else {
        await tx.insert(schema.occurrences).values({ id: occId, ...values });
      }
    }
  });
  return c.redirect(`/admin/events/${encodeURIComponent(id)}`);
});

adminUi.post('/events/:id/toggle', async (c) => {
  const id = c.req.param('id');
  const [event] = await db
    .select({ published: schema.events.published })
    .from(schema.events)
    .where(eq(schema.events.id, id))
    .limit(1);
  if (!event) return c.notFound();
  await db
    .update(schema.events)
    .set({ published: !event.published })
    .where(eq(schema.events.id, id));
  return c.redirect(c.req.header('referer') ?? '/admin/events');
});

adminUi.post('/events/:id/delete', async (c) => {
  const id = c.req.param('id');
  await db.delete(schema.events).where(eq(schema.events.id, id));
  return c.redirect('/admin/events');
});

function EventForm({
  event,
  occurrences,
  venues,
}: {
  event?: typeof schema.events.$inferSelect;
  occurrences?: (typeof schema.occurrences.$inferSelect)[];
  venues: { id: string; name: string }[];
}) {
  const action = event ? `/admin/events/${encodeURIComponent(event.id)}` : '/admin/events/new';
  // Bij nieuw event: één lege occurrence-rij. Bij bestaand event: alle
  // bestaande occurrences renderen.
  const initialOcc = occurrences && occurrences.length > 0 ? occurrences : [null];

  return (
    <form method="post" action={action}>
      <label>
        Titel
        <input type="text" name="title" required value={event?.title ?? ''} />
      </label>
      <div class="grid-2">
        <label>
          Venue
          <select name="venueId" required>
            {venues.map((v) => (
              <option value={v.id} selected={event?.venueId === v.id}>{v.name}</option>
            ))}
          </select>
        </label>
        <label>
          Categorie
          <select name="category">
            {CATEGORIES.map((cat) => (
              <option value={cat} selected={event?.category === cat}>{cat}</option>
            ))}
          </select>
        </label>
      </div>
      <fieldset>
        <legend>Type</legend>
        <label>
          <input
            type="radio"
            name="kind"
            value="show"
            checked={(event?.kind ?? 'show') === 'show'}
          />
          Show — concert, club, voorstelling, film, opening (één of meer momenten)
        </label>
        <label>
          <input
            type="radio"
            name="kind"
            value="exhibition"
            checked={event?.kind === 'exhibition'}
          />
          Tentoonstelling — doorlopend (één lange occurrence van begin tot eind)
        </label>
      </fieldset>
      <label>
        Beschrijving
        <textarea name="description" rows={4}>{event?.description ?? ''}</textarea>
      </label>
      <ImageUrlField
        name="imageUrl"
        kind="events"
        currentUrl={event?.imageUrl ?? ''}
      />
      <label>
        Genres (comma-separated, vrij — bv. techno, hip-hop, ambient)
        <input
          type="text"
          name="genres"
          value={(event?.genres ?? []).join(', ')}
        />
      </label>
      {!event && (
        <label>
          ID (optioneel — leeg laten voor auto)
          <input type="text" name="id" placeholder="evt-…" />
        </label>
      )}
      <fieldset>
        <label>
          <input type="checkbox" name="featured" checked={event?.featured} />
          Featured op Avond
        </label>
        <label>
          <input type="checkbox" name="published" checked={event?.published ?? true} />
          Live (verschijnt in de app)
        </label>
      </fieldset>

      <article>
        <header style="display:flex;justify-content:space-between;align-items:center;">
          <strong>Momenten ({initialOcc.length})</strong>
          <small style="opacity:0.7;">Voor films/wekelijkse feesten: meerdere rijen. Voor tentoonstellingen: één rij met start- en einddatum.</small>
        </header>
        <div id="occurrences">
          {initialOcc.map((occ, i) => (
            <OccurrenceRow occ={occ} index={i} />
          ))}
        </div>
        <button
          type="button"
          class="secondary outline"
          onclick="addOccurrenceRow()"
        >
          + Moment toevoegen
        </button>
      </article>

      <button type="submit">{event ? 'Opslaan' : 'Event aanmaken'}</button>

      <script
        dangerouslySetInnerHTML={{
          __html: `
            window.__occCount = ${initialOcc.length};
            function addOccurrenceRow() {
              const i = window.__occCount++;
              const tpl = document.getElementById('occ-template').innerHTML;
              const html = tpl.replace(/__INDEX__/g, String(i));
              document.getElementById('occurrences').insertAdjacentHTML('beforeend', html);
            }
            function removeOccurrenceRow(btn) {
              const row = btn.closest('[data-occ-row]');
              if (row) row.remove();
            }
          `,
        }}
      />
      <template id="occ-template" dangerouslySetInnerHTML={{ __html: occurrenceRowTemplate() }} />
    </form>
  );
}

function OccurrenceRow({
  occ,
  index,
}: {
  occ: typeof schema.occurrences.$inferSelect | null;
  index: number;
}) {
  const prefix = `occurrences[${index}].`;
  return (
    <div
      data-occ-row
      style="border:1px solid var(--pico-muted-border-color, #ddd);padding:1rem;margin-top:0.75rem;border-radius:4px;"
    >
      <input type="hidden" name={`${prefix}id`} value={occ?.id ?? ''} />
      <div class="grid-2">
        <label>
          Start
          <input
            type="datetime-local"
            name={`${prefix}startsAt`}
            required
            value={toDateTimeLocal(occ?.startsAt ?? null)}
          />
        </label>
        <label>
          Eind (optioneel — verplicht voor tentoonstelling)
          <input
            type="datetime-local"
            name={`${prefix}endsAt`}
            value={toDateTimeLocal(occ?.endsAt ?? null)}
          />
        </label>
      </div>
      <div class="grid-2">
        <label>
          Prijs (cents) — leeg = "—", 0 = "Gratis"
          <input
            type="number"
            name={`${prefix}priceCents`}
            min="0"
            step="50"
            value={occ?.priceCents ?? ''}
          />
        </label>
        <label>
          Zaal (optioneel)
          <input
            type="text"
            name={`${prefix}room`}
            value={occ?.room ?? ''}
            placeholder="bv. Kleine Zaal"
          />
        </label>
      </div>
      <label>
        Prijs-noot
        <input
          type="text"
          name={`${prefix}priceNote`}
          value={occ?.priceNote ?? ''}
          placeholder="leeg = erf van event/venue"
        />
      </label>
      <label>
        Ticket URL
        <input type="url" name={`${prefix}ticketUrl`} value={occ?.ticketUrl ?? ''} />
      </label>
      <label>
        Status
        <select name={`${prefix}status`}>
          <option value="scheduled" selected={(occ?.status ?? 'scheduled') === 'scheduled'}>Scheduled</option>
          <option value="sold_out" selected={occ?.status === 'sold_out'}>Sold out</option>
          <option value="cancelled" selected={occ?.status === 'cancelled'}>Cancelled</option>
        </select>
      </label>
      <button
        type="button"
        class="contrast outline"
        onclick="removeOccurrenceRow(this)"
        style="margin-top:0.25rem;"
      >
        Verwijder dit moment
      </button>
    </div>
  );
}

/**
 * Template-string voor dynamisch toegevoegde occurrence-rijen via JS.
 * `__INDEX__` wordt bij toevoegen vervangen door een uniek nummer.
 */
function occurrenceRowTemplate(): string {
  return `
    <div data-occ-row style="border:1px solid #ddd;padding:1rem;margin-top:0.75rem;border-radius:4px;">
      <input type="hidden" name="occurrences[__INDEX__].id" value="" />
      <div class="grid-2">
        <label>Start
          <input type="datetime-local" name="occurrences[__INDEX__].startsAt" required />
        </label>
        <label>Eind (optioneel)
          <input type="datetime-local" name="occurrences[__INDEX__].endsAt" />
        </label>
      </div>
      <div class="grid-2">
        <label>Prijs (cents)
          <input type="number" name="occurrences[__INDEX__].priceCents" min="0" step="50" />
        </label>
        <label>Zaal
          <input type="text" name="occurrences[__INDEX__].room" placeholder="bv. Kleine Zaal" />
        </label>
      </div>
      <label>Prijs-noot
        <input type="text" name="occurrences[__INDEX__].priceNote" />
      </label>
      <label>Ticket URL
        <input type="url" name="occurrences[__INDEX__].ticketUrl" />
      </label>
      <label>Status
        <select name="occurrences[__INDEX__].status">
          <option value="scheduled" selected>Scheduled</option>
          <option value="sold_out">Sold out</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </label>
      <button type="button" class="contrast outline" onclick="removeOccurrenceRow(this)" style="margin-top:0.25rem;">Verwijder dit moment</button>
    </div>
  `;
}

// ─── Venues ─────────────────────────────────────────────────────────────

adminUi.get('/venues', async (c) => {
  const rows = await db
    .select()
    .from(schema.venues)
    .orderBy(asc(schema.venues.name));

  // Aantal events per venue + aantal upcoming occurrences per venue.
  // Twee aparte queries, samengevoegd in Maps in JS — sneller en simpeler
  // dan één join met conditional count.
  const eventCounts = await db
    .select({
      venueId: schema.events.venueId,
      total: count(schema.events.id),
    })
    .from(schema.events)
    .groupBy(schema.events.venueId);
  const upcomingCounts = await db
    .select({
      venueId: schema.events.venueId,
      total: count(schema.occurrences.id),
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
    .where(gte(schema.occurrences.startsAt, sql`now()`))
    .groupBy(schema.events.venueId);
  const eventMap = new Map(eventCounts.map((r) => [r.venueId, Number(r.total)]));
  const upcomingMap = new Map(upcomingCounts.map((r) => [r.venueId, Number(r.total)]));

  const typeCounts = new Map<string, number>();
  let untypedCount = 0;
  for (const v of rows) {
    if (v.type) typeCounts.set(v.type, (typeCounts.get(v.type) ?? 0) + 1);
    else untypedCount++;
  }

  // Inline JS voor:
  //   • zoek-filter (naam), image-filter (alle / zonder / met),
  //     events-filter (met / zonder / upcoming / geen upcoming),
  //     en sortering (naam / events / upcoming).
  //   • drag-and-drop image-upload per rij — drop een file op een
  //     rij-thumbnail en de file gaat direct naar /admin/api/uploads,
  //     daarna PATCH naar /admin/api/venues/:id met de nieuwe URL.
  const script = `
(function () {
  const search = document.getElementById('venue-search');
  const filter = document.getElementById('venue-imgfilter');
  const eventsFilter = document.getElementById('venue-eventsfilter');
  const typeFilter = document.getElementById('venue-typefilter');
  const sort = document.getElementById('venue-sort');
  const tbody = document.querySelector('table tbody');
  const rows = Array.from(document.querySelectorAll('[data-venue-row]'));

  function applyFilter() {
    const q = (search.value || '').trim().toLowerCase();
    const f = filter.value;
    const ef = eventsFilter.value;
    const tf = typeFilter.value;
    let visible = 0;
    for (const r of rows) {
      const name = r.dataset.name || '';
      const hasImg = r.dataset.hasimage === '1';
      const events = Number(r.dataset.events || '0');
      const upcoming = Number(r.dataset.upcoming || '0');
      const type = r.dataset.type || '';
      let show = true;
      if (q && !name.toLowerCase().includes(q)) show = false;
      if (f === 'noimg' && hasImg) show = false;
      if (f === 'hasimg' && !hasImg) show = false;
      if (ef === 'has-events' && events === 0) show = false;
      if (ef === 'no-events' && events > 0) show = false;
      if (ef === 'has-upcoming' && upcoming === 0) show = false;
      if (ef === 'no-upcoming' && upcoming > 0) show = false;
      if (tf === '__none' && type !== '') show = false;
      else if (tf && tf !== 'all' && tf !== '__none' && type !== tf) show = false;
      r.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    document.getElementById('venue-count').textContent = visible + ' / ' + rows.length;
  }
  function applySort() {
    const s = sort.value;
    const sorted = rows.slice().sort((a, b) => {
      if (s === 'events-desc') {
        return Number(b.dataset.events) - Number(a.dataset.events)
          || a.dataset.name.localeCompare(b.dataset.name);
      }
      if (s === 'upcoming-desc') {
        return Number(b.dataset.upcoming) - Number(a.dataset.upcoming)
          || a.dataset.name.localeCompare(b.dataset.name);
      }
      return a.dataset.name.localeCompare(b.dataset.name);
    });
    for (const r of sorted) tbody.appendChild(r);
  }
  // Persist + restore filters/sort via localStorage zodat ze blijven
  // staan als je naar een venue-detail klikt en terugkomt.
  const STORAGE_KEY = 'andreas-admin-venues-filters';
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        search: search.value,
        img: filter.value,
        events: eventsFilter.value,
        type: typeFilter.value,
        sort: sort.value,
      }));
    } catch {}
  }
  function restoreState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const v = JSON.parse(raw);
      if (typeof v.search === 'string') search.value = v.search;
      if (typeof v.img === 'string') filter.value = v.img;
      if (typeof v.events === 'string') eventsFilter.value = v.events;
      if (typeof v.type === 'string') typeFilter.value = v.type;
      if (typeof v.sort === 'string') sort.value = v.sort;
    } catch {}
  }
  restoreState();
  applySort();
  applyFilter();

  search.addEventListener('input', () => { saveState(); applyFilter(); });
  filter.addEventListener('change', () => { saveState(); applyFilter(); });
  eventsFilter.addEventListener('change', () => { saveState(); applyFilter(); });
  typeFilter.addEventListener('change', () => { saveState(); applyFilter(); });
  sort.addEventListener('change', () => { saveState(); applySort(); });

  // Drag-drop per rij. We luisteren op de hele <tr> zodat het hele
  // gebied als drop-target werkt — niet alleen de thumb-cell.
  for (const row of rows) {
    const id = row.dataset.venueId;
    const thumb = row.querySelector('[data-thumb]');
    const status = row.querySelector('[data-status]');

    row.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      row.classList.add('row-drag');
    });
    row.addEventListener('dragleave', () => row.classList.remove('row-drag'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('row-drag');
      const file = e.dataTransfer.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      status.textContent = 'Uploaden…';
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('kind', 'venues');
        const upRes = await fetch('/admin/api/uploads', {
          method: 'POST',
          body: fd,
          credentials: 'same-origin',
        });
        if (!upRes.ok) throw new Error('upload failed (' + upRes.status + ')');
        const { url } = await upRes.json();
        const patchRes = await fetch('/admin/api/venues/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ imageUrl: url }),
        });
        if (!patchRes.ok) throw new Error('patch failed (' + patchRes.status + ')');
        if (thumb) {
          thumb.src = url;
          thumb.classList.remove('empty');
        }
        row.dataset.hasimage = '1';
        status.textContent = '✓';
        status.style.color = '#9fe88a';
        setTimeout(() => { status.textContent = ''; }, 2000);
      } catch (err) {
        status.textContent = '✗ ' + (err.message || err);
        status.style.color = '#f3b6b6';
      }
    });
  }
})();
`;

  const withImage = rows.filter((v) => v.imageUrl).length;

  return c.html(
    <Layout title="Venues" active="venues">
      <style>{`
        .venue-list-toolbar {
          display: flex; gap: 8px; align-items: center;
          margin: 0 0 1rem; flex-wrap: wrap;
        }
        .venue-list-toolbar input[type=search],
        .venue-list-toolbar select {
          margin: 0; padding: 0.4rem 0.7rem; font-size: 13px; height: 36px;
        }
        .venue-list-toolbar input[type=search] { flex: 1; min-width: 180px; }
        .venue-list-toolbar select { width: auto; }
        .venue-thumb {
          width: 56px; height: 38px; border-radius: 4px;
          object-fit: cover; background: var(--pico-card-background-color);
          display: block;
        }
        .venue-thumb.empty {
          border: 1px dashed var(--pico-muted-border-color);
          background: transparent;
        }
        tr.row-drag td { background: rgba(212, 255, 58, 0.08); }
        tr.row-drag .venue-thumb {
          outline: 2px dashed #d4ff3a;
          outline-offset: 2px;
        }
        td.thumb-cell { width: 64px; padding-right: 4px; }
        td.status-cell { width: 24px; font-size: 14px; padding-left: 4px; }
        td.events-cell { font-size: 12px; white-space: nowrap; }
        .evt-zero { opacity: 0.4; }
        .evt-total { font-weight: 600; }
        .evt-upcoming { color: #9fe88a; }
        .evt-sep { opacity: 0.4; }
      `}</style>
      <div class="toolbar">
        <h2>Venues</h2>
        <a href="/admin/venues/new" role="button">+ Nieuwe venue</a>
      </div>
      <p style="font-size:13px;opacity:0.7;margin:0 0 0.5rem;">
        Sleep een afbeelding op een rij om de venue-foto direct te
        vervangen. <span id="venue-count">{`${rows.length} / ${rows.length}`}</span> ·
        {` ${withImage} met foto, ${rows.length - withImage} zonder`}
      </p>
      <div class="venue-list-toolbar">
        <input
          type="search"
          id="venue-search"
          placeholder="Zoek op naam…"
          autocomplete="off"
        />
        <select id="venue-imgfilter">
          <option value="all">Alle foto's</option>
          <option value="noimg">Zonder foto</option>
          <option value="hasimg">Met foto</option>
        </select>
        <select id="venue-eventsfilter">
          <option value="all">Alle events</option>
          <option value="has-events">Met events</option>
          <option value="no-events">Zonder events</option>
          <option value="has-upcoming">Met upcoming</option>
          <option value="no-upcoming">Zonder upcoming</option>
        </select>
        <select id="venue-typefilter">
          <option value="all">Alle types</option>
          {VENUE_TYPES.map((t) => (
            <option value={t}>{`${t} (${typeCounts.get(t) ?? 0})`}</option>
          ))}
          {untypedCount > 0 && (
            <option value="__none">{`zonder type (${untypedCount})`}</option>
          )}
        </select>
        <select id="venue-sort">
          <option value="name">Sort: naam</option>
          <option value="events-desc">Sort: events ↓</option>
          <option value="upcoming-desc">Sort: upcoming ↓</option>
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th class="thumb-cell"></th>
            <th>Naam</th>
            <th>Events</th>
            <th>Type</th>
            <th>Scene</th>
            <th>Dag/nacht</th>
            <th>Wijk</th>
            <th>Status</th>
            <th class="status-cell"></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const events = eventMap.get(v.id) ?? 0;
            const upcoming = upcomingMap.get(v.id) ?? 0;
            return (
            <tr
              class={v.published ? '' : 'row-unpub'}
              data-venue-row
              data-venue-id={v.id}
              data-name={v.name}
              data-hasimage={v.imageUrl ? '1' : '0'}
              data-events={events}
              data-upcoming={upcoming}
              data-type={v.type ?? ''}
            >
              <td class="thumb-cell">
                <img
                  data-thumb
                  src={
                    v.imageUrl ??
                    'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'/>'
                  }
                  alt=""
                  class={`venue-thumb${v.imageUrl ? '' : ' empty'}`}
                />
              </td>
              <td><a href={`/admin/venues/${encodeURIComponent(v.id)}`}>{v.name}</a></td>
              <td class="events-cell">
                {events === 0 ? (
                  <span class="evt-zero">—</span>
                ) : (
                  <>
                    <span class="evt-total">{events}</span>
                    <span class="evt-sep"> · </span>
                    <span class={upcoming === 0 ? 'evt-zero' : 'evt-upcoming'}>
                      {upcoming} komend
                    </span>
                  </>
                )}
              </td>
              <td style="font-size:12px;">{v.type ?? '—'}</td>
              <td style="font-size:12px;">{v.scene ?? '—'}</td>
              <td style="font-size:12px;">{v.dayNight ?? '—'}</td>
              <td style="font-size:12px;">{v.wijk ?? '—'}</td>
              <td><PublishedPill published={v.published} /></td>
              <td class="status-cell"><span data-status></span></td>
              <td class="actions">
                <form method="post" action={`/admin/venues/${encodeURIComponent(v.id)}/toggle`}>
                  <button type="submit" class="secondary outline">
                    {v.published ? 'Uit' : 'Aan'}
                  </button>
                </form>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </Layout>
  );
});

adminUi.get('/venues/new', (c) =>
  c.html(
    <Layout title="Nieuwe venue" active="venues">
      <h2>Nieuwe venue</h2>
      <VenueForm />
    </Layout>
  )
);

adminUi.post('/venues/new', async (c) => {
  const form = await c.req.parseBody();
  const name = String(form.name ?? '').trim();
  if (!name) {
    return c.html(<Layout title="Fout"><p>Naam verplicht.</p></Layout>, 400);
  }
  const id = String(form.id ?? '').trim() || slugify(name) || `venue-${shortId()}`;
  const slug = String(form.slug ?? '').trim() || slugify(name) || id;
  await db.insert(schema.venues).values({
    id,
    slug,
    name,
    address: String(form.address ?? '').trim(),
    lat: Number(form.lat ?? 0),
    lng: Number(form.lng ?? 0),
    description: (form.description as string) || null,
    imageUrl: (form.imageUrl as string) || null,
    categories: parseCategoriesField(String(form.categories ?? '')),
    type: parseEnumField(VENUE_TYPES, String(form.type ?? '')) ?? undefined,
    dayNight: parseEnumField(DAY_NIGHT, String(form.dayNight ?? '')) ?? undefined,
    wijk: parseEnumField(WIJKEN, String(form.wijk ?? '')) ?? undefined,
    scene: parseEnumField(SCENES, String(form.scene ?? '')) ?? undefined,
    capacity: parseEnumField(CAPACITIES, String(form.capacity ?? '')) ?? undefined,
    subtype: parseTagsField(String(form.subtype ?? '')),
    website: (form.website as string) || null,
    instagram: form.instagram ? normalizeInstagram(String(form.instagram)) : null,
    priceNote: form.priceNote ? String(form.priceNote).trim() || null : null,
    published: form.published !== 'off',
  });
  return c.redirect('/admin/venues');
});

adminUi.get('/venues/:id', async (c) => {
  const id = c.req.param('id');
  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, id))
    .limit(1);
  if (!venue) return c.notFound();

  // Events bij deze venue + alle occurrences in één join. Sort op
  // de eerstvolgende occurrence (upcoming bovenaan, dan verleden, dan
  // events zonder occurrences).
  const venueEvents = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.venueId, id))
    .orderBy(asc(schema.events.title));
  const eventIds = venueEvents.map((e) => e.id);
  const allOccurrences = eventIds.length
    ? await db
        .select()
        .from(schema.occurrences)
        .where(inArray(schema.occurrences.eventId, eventIds))
        .orderBy(asc(schema.occurrences.startsAt))
    : [];
  const occByEvent = new Map<string, typeof allOccurrences>();
  for (const o of allOccurrences) {
    const list = occByEvent.get(o.eventId) ?? [];
    list.push(o);
    occByEvent.set(o.eventId, list);
  }
  const now = Date.now();
  type EventRow = (typeof venueEvents)[number];
  type OccRow = (typeof allOccurrences)[number];
  function nextOcc(evId: string): OccRow | null {
    const list = occByEvent.get(evId) ?? [];
    return list.find((o) => o.startsAt.getTime() >= now) ?? null;
  }
  function eventSortKey(e: EventRow): number {
    const next = nextOcc(e.id);
    if (next) return next.startsAt.getTime();
    const list = occByEvent.get(e.id) ?? [];
    if (list.length === 0) return Number.MAX_SAFE_INTEGER; // geen occurrences → onderaan
    // alleen verleden — zet net boven "geen occurrences" met de laatste
    // datum als tiebreak (recent verleden eerst).
    const last = list[list.length - 1];
    return Number.MAX_SAFE_INTEGER - 1 - last.startsAt.getTime();
  }
  const sortedEvents = venueEvents.slice().sort((a, b) => eventSortKey(a) - eventSortKey(b));

  return c.html(
    <Layout title={venue.name} active="venues">
      <style>{`
        .venue-events { margin: 2rem 0; }
        .venue-events h3 { margin: 0 0 0.75rem; }
        .ve-row {
          display: grid;
          grid-template-columns: 56px 1fr auto;
          gap: 12px;
          padding: 10px 0;
          border-top: 1px solid var(--pico-muted-border-color);
        }
        .ve-row:last-child { border-bottom: 1px solid var(--pico-muted-border-color); }
        .ve-thumb {
          width: 56px; height: 56px; border-radius: 4px;
          object-fit: cover; background: var(--pico-card-background-color);
        }
        .ve-thumb.empty {
          border: 1px dashed var(--pico-muted-border-color);
          background: transparent;
        }
        .ve-title { font-weight: 600; }
        .ve-meta { font-size: 12px; opacity: 0.8; margin-top: 2px; }
        .ve-badges { margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
        .ve-badge {
          font-size: 10px; padding: 2px 6px; border-radius: 999px;
          background: rgba(243, 182, 182, 0.15); color: #f3b6b6;
          border: 1px solid rgba(243, 182, 182, 0.3);
        }
        .ve-badge.ok { background: rgba(159, 232, 138, 0.12); color: #9fe88a; border-color: rgba(159, 232, 138, 0.3); }
        .ve-occs { margin-top: 6px; font-size: 12px; opacity: 0.85; }
        .ve-occ {
          display: inline-block; margin-right: 12px;
          font-variant-numeric: tabular-nums;
        }
        .ve-occ.past { opacity: 0.45; }
        .ve-occ.cancelled { text-decoration: line-through; opacity: 0.5; }
        .ve-occ.sold_out::after { content: ' · uitverkocht'; opacity: 0.7; }
        .ve-right { text-align: right; font-size: 12px; white-space: nowrap; }
      `}</style>
      <div class="toolbar">
        <h2>{venue.name}</h2>
        <PublishedPill published={venue.published} />
      </div>
      <p style="font-size:13px;opacity:0.7;margin:0 0 1rem;">
        <a href="/admin/venues">← Terug naar venues</a>
      </p>
      <VenueForm venue={venue} />

      <section class="venue-events">
        <h3>
          Events ({sortedEvents.length})
          {sortedEvents.length > 0 && (
            <span style="font-weight:400;font-size:13px;opacity:0.7;">
              {' · '}
              {sortedEvents.filter((e) => nextOcc(e.id)).length} met upcoming
            </span>
          )}
        </h3>
        {sortedEvents.length === 0 ? (
          <p style="opacity:0.6;font-size:13px;">Geen events bij deze venue.</p>
        ) : (
          sortedEvents.map((e) => {
            const occs = occByEvent.get(e.id) ?? [];
            const next = nextOcc(e.id);
            const past = occs.length > 0 && !next;
            return (
              <div class="ve-row">
                <img
                  src={
                    e.imageUrl ??
                    'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'/>'
                  }
                  alt=""
                  class={`ve-thumb${e.imageUrl ? '' : ' empty'}`}
                />
                <div>
                  <div class="ve-title">
                    <a href={`/admin/events/${encodeURIComponent(e.id)}`}>{e.title}</a>
                  </div>
                  <div class="ve-meta">
                    {e.category} · {e.kind}
                    {e.featured ? ' · ⭐ featured' : ''}
                  </div>
                  <div class="ve-badges">
                    {!e.published && <span class="ve-badge">verborgen</span>}
                    {!e.imageUrl && <span class="ve-badge">geen image</span>}
                    {!e.description && <span class="ve-badge">geen beschrijving</span>}
                    {occs.length === 0 && <span class="ve-badge">geen occurrences</span>}
                    {past && <span class="ve-badge">alleen verleden</span>}
                  </div>
                  {occs.length > 0 && (
                    <div class="ve-occs">
                      {occs.map((o) => {
                        const isPast = o.startsAt.getTime() < now;
                        const cls = `ve-occ ${o.status === 'cancelled' ? 'cancelled' : ''} ${o.status === 'sold_out' ? 'sold_out' : ''} ${isPast ? 'past' : ''}`;
                        return (
                          <span class={cls.trim()}>
                            {fmtDate(o.startsAt)}
                            {o.room ? ` · ${o.room}` : ''}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div class="ve-right">
                  <PublishedPill published={e.published} />
                  <div style="margin-top:4px;opacity:0.7;">
                    {occs.length} {occs.length === 1 ? 'moment' : 'momenten'}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </section>

      <details style="margin-top:2rem;">
        <summary>Verwijderen</summary>
        <p style="font-size:13px;opacity:0.8;">
          Cascade: alle events bij deze venue, en hun saves/invites/series-koppelingen gaan ook weg.
        </p>
        <form
          method="post"
          action={`/admin/venues/${encodeURIComponent(venue.id)}/delete`}
          onsubmit="return confirm('Echt verwijderen? Cascade naar events.');"
        >
          <button type="submit" class="contrast outline">Permanent verwijderen</button>
        </form>
      </details>
    </Layout>
  );
});

adminUi.post('/venues/:id', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.parseBody();
  await db
    .update(schema.venues)
    .set({
      slug: String(form.slug ?? '').trim(),
      name: String(form.name ?? '').trim(),
      address: String(form.address ?? '').trim(),
      lat: Number(form.lat ?? 0),
      lng: Number(form.lng ?? 0),
      description: (form.description as string) || null,
      imageUrl: (form.imageUrl as string) || null,
      categories: parseCategoriesField(String(form.categories ?? '')),
      type: parseEnumField(VENUE_TYPES, String(form.type ?? '')),
      dayNight: parseEnumField(DAY_NIGHT, String(form.dayNight ?? '')),
      wijk: parseEnumField(WIJKEN, String(form.wijk ?? '')),
      scene: parseEnumField(SCENES, String(form.scene ?? '')),
      capacity: parseEnumField(CAPACITIES, String(form.capacity ?? '')),
      subtype: parseTagsField(String(form.subtype ?? '')),
      website: (form.website as string) || null,
      instagram: form.instagram ? normalizeInstagram(String(form.instagram)) : null,
      priceNote: form.priceNote ? String(form.priceNote).trim() || null : null,
      published: form.published !== 'off',
    })
    .where(eq(schema.venues.id, id));
  return c.redirect(`/admin/venues/${encodeURIComponent(id)}`);
});

adminUi.post('/venues/:id/toggle', async (c) => {
  const id = c.req.param('id');
  const [venue] = await db
    .select({ published: schema.venues.published })
    .from(schema.venues)
    .where(eq(schema.venues.id, id))
    .limit(1);
  if (!venue) return c.notFound();
  await db
    .update(schema.venues)
    .set({ published: !venue.published })
    .where(eq(schema.venues.id, id));
  return c.redirect(c.req.header('referer') ?? '/admin/venues');
});

adminUi.post('/venues/:id/delete', async (c) => {
  const id = c.req.param('id');
  await db.delete(schema.venues).where(eq(schema.venues.id, id));
  return c.redirect('/admin/venues');
});

function VenueForm({
  venue,
}: {
  venue?: typeof schema.venues.$inferSelect;
}) {
  const action = venue ? `/admin/venues/${encodeURIComponent(venue.id)}` : '/admin/venues/new';
  return (
    <form method="post" action={action}>
      <div class="grid-2">
        <label>
          Naam
          <input type="text" name="name" required value={venue?.name ?? ''} />
        </label>
        <label>
          Slug (URL)
          <input type="text" name="slug" pattern="[a-z0-9-]+" value={venue?.slug ?? ''} />
        </label>
      </div>
      <label>
        Adres
        <input type="text" name="address" value={venue?.address ?? ''} />
      </label>
      <div class="grid-2">
        <label>
          Latitude
          <input type="number" name="lat" step="0.000001" value={venue?.lat ?? ''} />
        </label>
        <label>
          Longitude
          <input type="number" name="lng" step="0.000001" value={venue?.lng ?? ''} />
        </label>
      </div>
      <div class="grid-3">
        <label>
          Type
          <select name="type">
            <option value="" selected={!venue?.type}>—</option>
            {VENUE_TYPES.map((t) => (
              <option value={t} selected={venue?.type === t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Dag / nacht
          <select name="dayNight">
            <option value="" selected={!venue?.dayNight}>—</option>
            {DAY_NIGHT.map((d) => (
              <option value={d} selected={venue?.dayNight === d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          Wijk
          <select name="wijk">
            <option value="" selected={!venue?.wijk}>—</option>
            {WIJKEN.map((w) => (
              <option value={w} selected={venue?.wijk === w}>{w}</option>
            ))}
          </select>
        </label>
      </div>
      <div class="grid-2">
        <label>
          Scene
          <select name="scene">
            <option value="" selected={!venue?.scene}>—</option>
            {SCENES.map((s) => (
              <option value={s} selected={venue?.scene === s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Capacity
          <select name="capacity">
            <option value="" selected={!venue?.capacity}>—</option>
            {CAPACITIES.map((c) => (
              <option value={c} selected={venue?.capacity === c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Categorieën (comma-separated, uit: Muziek, Theater, Literatuur, Film)
        <input
          type="text"
          name="categories"
          value={(venue?.categories ?? []).join(', ')}
        />
      </label>
      <label>
        Subtype-tags (comma-separated, vrij — bv. techno, queer, arthouse)
        <input
          type="text"
          name="subtype"
          value={(venue?.subtype ?? []).join(', ')}
        />
      </label>
      <label>
        Beschrijving
        <textarea name="description" rows={3}>{venue?.description ?? ''}</textarea>
      </label>
      <div class="grid-2">
        <label>
          Website
          <input
            type="url"
            name="website"
            placeholder="https://venue.nl"
            value={venue?.website ?? ''}
          />
        </label>
        <label>
          Instagram (handle, zonder @)
          <input
            type="text"
            name="instagram"
            placeholder="paradiso"
            value={venue?.instagram ?? ''}
          />
        </label>
      </div>
      <label>
        Prijs-noot (default voor alle events — bv. "lidmaatschap vereist")
        <input
          type="text"
          name="priceNote"
          placeholder="leeg = niets onder de prijs"
          value={venue?.priceNote ?? ''}
        />
      </label>
      <ImageUrlField
        name="imageUrl"
        kind="venues"
        currentUrl={venue?.imageUrl ?? ''}
      />
      {!venue && (
        <label>
          ID (optioneel — leeg laten voor auto uit slug)
          <input type="text" name="id" />
        </label>
      )}
      <label>
        <input type="checkbox" name="published" checked={venue?.published ?? true} />
        Live
      </label>
      <button type="submit">{venue ? 'Opslaan' : 'Venue aanmaken'}</button>
    </form>
  );
}

// ─── Series ─────────────────────────────────────────────────────────────

adminUi.get('/series', async (c) => {
  const rows = await db
    .select()
    .from(schema.series)
    .orderBy(asc(schema.series.startsAt), asc(schema.series.name));
  return c.html(
    <Layout title="Series" active="series">
      <div class="toolbar">
        <h2>Series</h2>
        <a href="/admin/series/new" role="button">+ Nieuwe serie</a>
      </div>
      <table>
        <thead>
          <tr>
            <th>Naam</th>
            <th>Periode</th>
            <th>Categorieën</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr class={s.published ? '' : 'row-unpub'}>
              <td><a href={`/admin/series/${encodeURIComponent(s.id)}`}>{s.name}</a></td>
              <td style="font-size:12px;opacity:0.8;">
                {s.startsAt ? fmtDate(s.startsAt) : '—'} → {s.endsAt ? fmtDate(s.endsAt) : '—'}
              </td>
              <td style="font-size:12px;">{s.categories.join(', ')}</td>
              <td><PublishedPill published={s.published} /></td>
              <td class="actions">
                <form method="post" action={`/admin/series/${encodeURIComponent(s.id)}/toggle`}>
                  <button type="submit" class="secondary outline">
                    {s.published ? 'Uitzetten' : 'Aanzetten'}
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  );
});

adminUi.get('/series/new', (c) =>
  c.html(
    <Layout title="Nieuwe serie" active="series">
      <h2>Nieuwe serie</h2>
      <SeriesForm />
    </Layout>
  )
);

adminUi.post('/series/new', async (c) => {
  const form = await c.req.parseBody();
  const name = String(form.name ?? '').trim();
  if (!name) {
    return c.html(<Layout title="Fout"><p>Naam verplicht.</p></Layout>, 400);
  }
  const id = String(form.id ?? '').trim() || `series-${slugify(name)}` || `series-${shortId()}`;
  const slug = String(form.slug ?? '').trim() || slugify(name) || id;
  await db.insert(schema.series).values({
    id,
    slug,
    name,
    description: (form.description as string) || null,
    imageUrl: (form.imageUrl as string) || null,
    startsAt: fromDateTimeLocal(String(form.startsAt ?? '')),
    endsAt: fromDateTimeLocal(String(form.endsAt ?? '')),
    categories: parseCategoriesField(String(form.categories ?? '')),
    published: form.published === 'on',
    featured: form.featured === 'on',
  });
  return c.redirect(`/admin/series/${encodeURIComponent(id)}`);
});

adminUi.get('/series/:id', async (c) => {
  const id = c.req.param('id');
  const [series] = await db
    .select()
    .from(schema.series)
    .where(eq(schema.series.id, id))
    .limit(1);
  if (!series) return c.notFound();

  // Gekoppelde events (alle, ook verleden). startsAt komt uit de
  // eerstvolgende occurrence (of de oudste als alle voorbij zijn).
  const linkedRaw = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      startsAt: schema.occurrences.startsAt,
      published: schema.events.published,
      venueName: schema.venues.name,
    })
    .from(schema.eventsInSeries)
    .innerJoin(schema.events, eq(schema.events.id, schema.eventsInSeries.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .leftJoin(
      schema.occurrences,
      eq(schema.occurrences.eventId, schema.events.id)
    )
    .where(eq(schema.eventsInSeries.seriesId, id))
    .orderBy(asc(schema.occurrences.startsAt));
  // Eén rij per event (eerste occurrence). leftJoin geeft mogelijk
  // meerdere rijen per event als er meerdere occurrences zijn.
  const seenLinked = new Set<string>();
  const linked = linkedRaw.filter((r) => {
    if (seenLinked.has(r.id)) return false;
    seenLinked.add(r.id);
    return true;
  });

  // Beschikbare events om te koppelen — toekomst-only.
  const linkedIds = new Set(linked.map((l) => l.id));
  const availableRaw = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      startsAt: schema.occurrences.startsAt,
      venueName: schema.venues.name,
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.eventId, schema.events.id)
    )
    .where(gte(schema.occurrences.startsAt, new Date()))
    .orderBy(asc(schema.occurrences.startsAt));
  const seenAvail = new Set<string>();
  const available = availableRaw.filter((e) => {
    if (linkedIds.has(e.id)) return false;
    if (seenAvail.has(e.id)) return false;
    seenAvail.add(e.id);
    return true;
  });

  return c.html(
    <Layout title={series.name} active="series">
      <div class="toolbar">
        <h2>{series.name}</h2>
        <PublishedPill published={series.published} />
      </div>
      <SeriesForm series={series} />

      <article style="margin-top:1.5rem;">
        <header>Gekoppelde events ({linked.length})</header>
        {linked.length === 0 ? (
          <p style="opacity:0.7;">Nog geen events gekoppeld.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Wanneer</th>
                <th>Titel</th>
                <th>Venue</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {linked.map((e) => (
                <tr class={e.published ? '' : 'row-unpub'}>
                  <td style="white-space:nowrap;">{fmtDate(e.startsAt)}</td>
                  <td><a href={`/admin/events/${encodeURIComponent(e.id)}`}>{e.title}</a></td>
                  <td>{e.venueName}</td>
                  <td class="actions">
                    <form method="post" action={`/admin/series/${encodeURIComponent(series.id)}/unlink`}>
                      <input type="hidden" name="eventId" value={e.id} />
                      <button type="submit" class="contrast outline">Ontkoppelen</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form method="post" action={`/admin/series/${encodeURIComponent(series.id)}/link`} style="margin-top:1rem;">
          <div class="grid-2" style="grid-template-columns: 1fr auto;">
            <select name="eventId" required>
              <option value="">— kies event —</option>
              {available.map((e) => (
                <option value={e.id}>
                  {fmtDate(e.startsAt)} — {e.title} ({e.venueName})
                </option>
              ))}
            </select>
            <button type="submit">Koppelen</button>
          </div>
        </form>
      </article>

      <details style="margin-top:2rem;">
        <summary>Verwijderen</summary>
        <p style="font-size:13px;opacity:0.8;">
          Verwijdert de serie + alle koppelingen. Events zelf blijven.
        </p>
        <form
          method="post"
          action={`/admin/series/${encodeURIComponent(series.id)}/delete`}
          onsubmit="return confirm('Echt verwijderen?');"
        >
          <button type="submit" class="contrast outline">Permanent verwijderen</button>
        </form>
      </details>
    </Layout>
  );
});

adminUi.post('/series/:id', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.parseBody();
  await db
    .update(schema.series)
    .set({
      slug: String(form.slug ?? '').trim(),
      name: String(form.name ?? '').trim(),
      description: (form.description as string) || null,
      imageUrl: (form.imageUrl as string) || null,
      startsAt: fromDateTimeLocal(String(form.startsAt ?? '')),
      endsAt: fromDateTimeLocal(String(form.endsAt ?? '')),
      categories: parseCategoriesField(String(form.categories ?? '')),
      published: form.published === 'on',
      featured: form.featured === 'on',
    })
    .where(eq(schema.series.id, id));
  return c.redirect(`/admin/series/${encodeURIComponent(id)}`);
});

adminUi.post('/series/:id/toggle', async (c) => {
  const id = c.req.param('id');
  const [series] = await db
    .select({ published: schema.series.published })
    .from(schema.series)
    .where(eq(schema.series.id, id))
    .limit(1);
  if (!series) return c.notFound();
  await db
    .update(schema.series)
    .set({ published: !series.published })
    .where(eq(schema.series.id, id));
  return c.redirect(c.req.header('referer') ?? '/admin/series');
});

adminUi.post('/series/:id/delete', async (c) => {
  const id = c.req.param('id');
  await db.delete(schema.series).where(eq(schema.series.id, id));
  return c.redirect('/admin/series');
});

adminUi.post('/series/:id/link', async (c) => {
  const seriesId = c.req.param('id');
  const form = await c.req.parseBody();
  const eventId = String(form.eventId ?? '');
  if (!eventId) return c.redirect(`/admin/series/${encodeURIComponent(seriesId)}`);
  await db
    .insert(schema.eventsInSeries)
    .values({ eventId, seriesId })
    .onConflictDoNothing();
  return c.redirect(`/admin/series/${encodeURIComponent(seriesId)}`);
});

adminUi.post('/series/:id/unlink', async (c) => {
  const seriesId = c.req.param('id');
  const form = await c.req.parseBody();
  const eventId = String(form.eventId ?? '');
  await db
    .delete(schema.eventsInSeries)
    .where(
      and(
        eq(schema.eventsInSeries.seriesId, seriesId),
        eq(schema.eventsInSeries.eventId, eventId)
      )
    );
  return c.redirect(`/admin/series/${encodeURIComponent(seriesId)}`);
});

function SeriesForm({
  series,
}: {
  series?: typeof schema.series.$inferSelect;
}) {
  const action = series ? `/admin/series/${encodeURIComponent(series.id)}` : '/admin/series/new';
  return (
    <form method="post" action={action}>
      <div class="grid-2">
        <label>
          Naam
          <input type="text" name="name" required value={series?.name ?? ''} />
        </label>
        <label>
          Slug (URL)
          <input type="text" name="slug" pattern="[a-z0-9-]+" value={series?.slug ?? ''} />
        </label>
      </div>
      <div class="grid-2">
        <label>
          Start (optioneel)
          <input
            type="datetime-local"
            name="startsAt"
            value={toDateTimeLocal(series?.startsAt ?? null)}
          />
        </label>
        <label>
          Eind (optioneel — leeg = doorlopend)
          <input
            type="datetime-local"
            name="endsAt"
            value={toDateTimeLocal(series?.endsAt ?? null)}
          />
        </label>
      </div>
      <label>
        Categorieën (comma-separated)
        <input
          type="text"
          name="categories"
          value={(series?.categories ?? []).join(', ')}
        />
      </label>
      <label>
        Beschrijving
        <textarea name="description" rows={3}>{series?.description ?? ''}</textarea>
      </label>
      <ImageUrlField
        name="imageUrl"
        kind="series"
        currentUrl={series?.imageUrl ?? ''}
      />
      {!series && (
        <label>
          ID (optioneel — leeg laten voor auto)
          <input type="text" name="id" placeholder="series-…" />
        </label>
      )}
      <fieldset>
        <label>
          <input type="checkbox" name="published" checked={series?.published ?? true} />
          Live (verschijnt in de app)
        </label>
        <label>
          <input type="checkbox" name="featured" checked={series?.featured ?? false} />
          Featured — top-strook in Venues-tab (alleen voor periode-festivals zoals ADE/IDFA/Holland Festival; mini-series rond een opening uitlaten)
        </label>
      </fieldset>
      <button type="submit">{series ? 'Opslaan' : 'Serie aanmaken'}</button>
    </form>
  );
}

// ─── Import (LLM-extract van URL) ──────────────────────────────────

adminUi.get('/import', async (c) => {
  // Lijst alle musea + galleries voor de venue-selector. Andere
  // venue-types horen niet bij dit flow (die hebben event-feeds).
  const venues = await db
    .select({ id: schema.venues.id, name: schema.venues.name, type: schema.venues.type })
    .from(schema.venues)
    .where(inArray(schema.venues.type, ['museum', 'galerie']))
    .orderBy(asc(schema.venues.name));

  return c.html(
    <Layout title="Import" active="import">
      <h2>LLM-import voor tentoonstellingen</h2>
      <p style="opacity:0.7;max-width:60ch">
        Plak een URL van een museum- of galerie-agenda. De server haalt
        de pagina op (Playwright als 't een SPA is) en laat Claude alle
        tentoonstellingen extraheren — titel, datums, beschrijving,
        image. Daarna kun je per-item bevestigen en bulk-inserten.
      </p>
      <form id="extract-form">
        <label>
          Venue (museum of galerie)
          <select name="venueId" required>
            <option value="">— kies venue —</option>
            {venues.map((v) => (
              <option value={v.id}>
                {v.name} ({v.type})
              </option>
            ))}
          </select>
        </label>
        <label>
          URL van de agenda-/tentoonstellings-pagina
          <input
            type="url"
            name="url"
            placeholder="https://www.stedelijk.nl/nl/nu-te-zien"
            required
          />
        </label>
        <button type="submit" id="extract-btn">
          Pak tentoonstellingen op
        </button>
      </form>

      <div id="status" style="margin-top:1em"></div>
      <div id="result" style="margin-top:1em"></div>

      <script
        dangerouslySetInnerHTML={{
          __html: `
const form = document.getElementById('extract-form');
const btn = document.getElementById('extract-btn');
const status = document.getElementById('status');
const result = document.getElementById('result');

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const url = fd.get('url');
  const venueId = fd.get('venueId');
  if (!url || !venueId) return;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  status.textContent = 'Pagina ophalen + Claude analyseert…';
  result.innerHTML = '';
  try {
    const res = await fetch('/admin/api/import/extract-from-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) {
      status.innerHTML = '<mark>Fout: ' + esc(data.error || res.status) + '</mark>';
      return;
    }
    status.innerHTML = 'Klaar in ' + Math.round(data.durationMs/1000) + 's · fetch=' + data.fetchMethod + ' · ' + data.exhibitions.length + ' items · ' + data.promptTokens + ' tokens in / ' + data.completionTokens + ' uit';

    // Render review-tabel
    const items = data.exhibitions;
    if (items.length === 0) {
      result.innerHTML = '<p><em>Geen tentoonstellingen gevonden.</em></p>';
      return;
    }
    let html = '<form id="import-form"><table><thead><tr><th></th><th>Titel</th><th>Datums</th><th>Cat</th><th>Beschrijving</th><th>Image</th></tr></thead><tbody>';
    items.forEach((it, idx) => {
      html += '<tr>';
      html += '<td><input type="checkbox" name="pick" value="' + idx + '" checked></td>';
      html += '<td><input type="text" name="title-' + idx + '" value="' + esc(it.title) + '" style="width:200px"></td>';
      html += '<td><input type="date" name="startDate-' + idx + '" value="' + esc(it.startDate || '') + '" style="width:140px"> – <input type="date" name="endDate-' + idx + '" value="' + esc(it.endDate || '') + '" style="width:140px"></td>';
      html += '<td><select name="category-' + idx + '">' + ['Kunst','Theater','Literatuur','Film','Muziek'].map(c => '<option' + (c === it.category ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></td>';
      html += '<td><textarea name="description-' + idx + '" rows="2" style="width:280px">' + esc(it.description || '') + '</textarea></td>';
      html += '<td>' + (it.imageUrl ? '<img src="' + esc(it.imageUrl) + '" style="max-width:80px;max-height:60px">' : '—') + '<input type="hidden" name="imageUrl-' + idx + '" value="' + esc(it.imageUrl || '') + '"><input type="hidden" name="sourceUrl-' + idx + '" value="' + esc(it.sourceUrl || '') + '"></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    html += '<button type="submit" id="import-btn">Importeer geselecteerde</button>';
    html += '</form>';
    result.innerHTML = html;

    document.getElementById('import-form').addEventListener('submit', async (e2) => {
      e2.preventDefault();
      const fd2 = new FormData(e2.target);
      const picked = fd2.getAll('pick');
      const exhibitions = picked.map(idx => ({
        title: fd2.get('title-' + idx),
        startDate: fd2.get('startDate-' + idx) || null,
        endDate: fd2.get('endDate-' + idx) || null,
        description: fd2.get('description-' + idx) || null,
        imageUrl: fd2.get('imageUrl-' + idx) || null,
        sourceUrl: fd2.get('sourceUrl-' + idx) || null,
        category: fd2.get('category-' + idx),
      }));
      const importBtn = document.getElementById('import-btn');
      importBtn.disabled = true;
      importBtn.setAttribute('aria-busy', 'true');
      const r2 = await fetch('/admin/api/import/exhibitions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ venueId, exhibitions }),
      });
      const d2 = await r2.json();
      importBtn.removeAttribute('aria-busy');
      importBtn.disabled = false;
      if (!r2.ok) {
        status.innerHTML += '<br><mark>Import-fout: ' + esc(d2.error || r2.status) + '</mark>';
        return;
      }
      status.innerHTML += '<br><strong>Klaar:</strong> ' + d2.inserted + ' inserted, ' + d2.updated + ' updated, ' + d2.errors.length + ' errors';
      if (d2.errors.length > 0) {
        status.innerHTML += '<br>' + d2.errors.map(e => esc(e.title) + ': ' + esc(e.error)).join('<br>');
      }
    });
  } catch (err) {
    status.innerHTML = '<mark>Fout: ' + esc(err.message) + '</mark>';
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
});
`,
        }}
      />
    </Layout>,
  );
});
