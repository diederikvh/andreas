import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
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
import { generateCaption } from '../../social/caption.js';
import { SLOTS, runGenerate, runPublish, type Slot } from './social.js';

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
  'amstelveen',
  'zaandam',
  'haarlem',
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
    agendaUrl: form.agendaUrl ? String(form.agendaUrl).trim() || null : null,
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
      agendaUrl: form.agendaUrl ? String(form.agendaUrl).trim() || null : null,
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
      <label>
        Agenda-URL (voor LLM-import — alleen musea + galleries)
        <input
          type="url"
          name="agendaUrl"
          placeholder="https://venue.nl/tentoonstellingen"
          value={venue?.agendaUrl ?? ''}
        />
        {venue?.agendaUrl && venue?.id && (
          <small>
            <a
              href={`/admin/import?venueId=${encodeURIComponent(venue.id)}&url=${encodeURIComponent(venue.agendaUrl)}`}
            >
              → Open import met deze URL
            </a>
            {venue.lastImportedAt && (
              <span style="opacity:0.7;margin-left:1em">
                Laatst gesynced: {venue.lastImportedAt.toISOString().slice(0, 10)}
              </span>
            )}
          </small>
        )}
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
    .select({
      id: schema.venues.id,
      name: schema.venues.name,
      type: schema.venues.type,
      agendaUrl: schema.venues.agendaUrl,
      lastImportedAt: schema.venues.lastImportedAt,
    })
    .from(schema.venues)
    .where(inArray(schema.venues.type, ['museum', 'galerie']))
    .orderBy(asc(schema.venues.name));

  function fmtRelative(d: Date | null): string {
    if (!d) return 'nooit';
    const ms = Date.now() - d.getTime();
    const days = Math.floor(ms / (24 * 3600_000));
    if (days < 1) return 'vandaag';
    if (days < 7) return `${days}d geleden`;
    if (days < 30) return `${Math.floor(days / 7)}w geleden`;
    if (days < 365) return `${Math.floor(days / 30)}m geleden`;
    return `${Math.floor(days / 365)}j geleden`;
  }

  // Querystring-prefill: ?venueId=…&url=… (komt vanaf venue-pagina).
  const preselectedId = c.req.query('venueId') ?? '';
  const preselectedUrl = c.req.query('url') ?? '';

  // Inline data-map voor de client-side: venueId → agendaUrl, zodat
  // we de URL automatisch invullen bij venue-keuze.
  const venueAgendaMap: Record<string, string> = {};
  for (const v of venues) {
    if (v.agendaUrl) venueAgendaMap[v.id] = v.agendaUrl;
  }

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
          <input
            type="text"
            list="venue-list"
            name="venueLabel"
            id="venueLabel"
            placeholder="Begin te typen…"
            autocomplete="off"
            value={
              preselectedId
                ? venues.find((v) => v.id === preselectedId)?.name ?? ''
                : ''
            }
            required
          />
          <datalist id="venue-list">
            {venues.map((v) => (
              <option
                value={`${v.name} — ${v.type} · laatst: ${fmtRelative(v.lastImportedAt)}`}
                data-id={v.id}
              />
            ))}
          </datalist>
          <input type="hidden" name="venueId" id="venueId" value={preselectedId} />
          <small style="opacity:0.7">
            Datalist met alle {venues.length} musea + galleries — typ naam om te zoeken.
          </small>
        </label>
        <label>
          URL van de agenda-/tentoonstellings-pagina
          <input
            type="url"
            name="url"
            id="urlField"
            placeholder="https://www.stedelijk.nl/nl/nu-te-zien"
            value={preselectedUrl}
            required
          />
          <small style="opacity:0.7">
            Wordt automatisch ingevuld als de venue een opgeslagen agenda-URL heeft.
          </small>
        </label>
        <button type="submit" id="extract-btn">
          Pak tentoonstellingen op
        </button>
      </form>

      <script
        dangerouslySetInnerHTML={{
          __html: `window.__venueAgendaMap = ${JSON.stringify(venueAgendaMap)};
window.__venueLabelToId = ${JSON.stringify(
            Object.fromEntries(
              venues.map((v) => [
                `${v.name} — ${v.type} · laatst: ${fmtRelative(v.lastImportedAt)}`,
                v.id,
              ]),
            ),
          )};
const venueLabel = document.getElementById('venueLabel');
const venueId = document.getElementById('venueId');
const urlField = document.getElementById('urlField');
venueLabel.addEventListener('input', () => {
  const id = window.__venueLabelToId[venueLabel.value];
  if (id) {
    venueId.value = id;
    const url = window.__venueAgendaMap[id];
    if (url && !urlField.value) urlField.value = url;
  } else {
    venueId.value = '';
  }
});`,
        }}
      />

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
  if (!url || !venueId) {
    status.innerHTML = '<mark>Kies eerst een venue uit de lijst (typen → selecteer een suggestie).</mark>';
    return;
  }
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

/* ═══════════════════════════════════════════════════════════════════════
 * /admin/insights — geaggregeerde inzichten voor het Andreas-team.
 * Quick wins eerst: discovery-channel mix, trending events + venues,
 * genre/cat-trends per maand. Slow cadence (refresh op page-load,
 * geen realtime). Privacy: alleen totals + counts, geen user-IDs.
 * ═══════════════════════════════════════════════════════════════════ */

const NL_MONTHS_SHORT = [
  'jan', 'feb', 'mrt', 'apr', 'mei', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
];

function ymToLabel(ym: string): string {
  // ym = "2026-05"
  const [y, m] = ym.split('-');
  const mi = Math.max(0, Math.min(11, Number(m) - 1));
  return `${NL_MONTHS_SHORT[mi]} '${y.slice(2)}`;
}

adminUi.get('/insights', async (c) => {
  // ─── 0. Growth — DAU / WAU / MAU ──────────────────────────────────
  // Aantal users actief in de afgelopen 24h / 7d / 30d, op basis van
  // `users.last_seen_at`. NULL = nooit gezien sinds tracking begon.
  const [growth] = (
    await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE last_seen_at >= NOW() - INTERVAL '24 hours'
        )::int AS dau,
        COUNT(*) FILTER (
          WHERE last_seen_at >= NOW() - INTERVAL '7 days'
        )::int AS wau,
        COUNT(*) FILTER (
          WHERE last_seen_at >= NOW() - INTERVAL '30 days'
        )::int AS mau
      FROM users
    `)
  ).rows as Array<{ total: number; dau: number; wau: number; mau: number }>;

  // Nieuwe signups en saves per dag — 30 dagen terug. Generate_series
  // vult lege dagen met 0 zodat de tabel monotoon scrollt.
  const dailyActivityRows = await db.execute(sql`
    WITH days AS (
      SELECT generate_series(
        DATE_TRUNC('day', NOW() - INTERVAL '29 days'),
        DATE_TRUNC('day', NOW()),
        INTERVAL '1 day'
      )::date AS day
    ),
    signups AS (
      SELECT DATE_TRUNC('day', created_at)::date AS day, COUNT(*)::int AS n
      FROM users
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY day
    ),
    saves_daily AS (
      SELECT DATE_TRUNC('day', created_at)::date AS day, COUNT(*)::int AS n
      FROM saves
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY day
    )
    SELECT
      d.day::text AS day,
      COALESCE(s.n, 0) AS signups,
      COALESCE(sd.n, 0) AS saves
    FROM days d
    LEFT JOIN signups s ON s.day = d.day
    LEFT JOIN saves_daily sd ON sd.day = d.day
    ORDER BY d.day DESC
  `);
  const dailyActivity = dailyActivityRows.rows as Array<{
    day: string;
    signups: number;
    saves: number;
  }>;
  const maxSignups = Math.max(1, ...dailyActivity.map((r) => r.signups));
  const maxSaves = Math.max(1, ...dailyActivity.map((r) => r.saves));

  // ─── 1. Discovery-channel mix ─────────────────────────────────────
  // Per save-source: hoeveel saves zijn er via dat scherm gemaakt?
  // Legacy saves (vóór source-attributie, mei 2026) tellen we apart als
  // "onbekend" zodat de mix transparant is.
  const discoveryRows = await db.execute(sql`
    SELECT
      COALESCE(source::text, 'onbekend') AS source,
      COUNT(*)::int AS n
    FROM saves
    GROUP BY source
    ORDER BY n DESC
  `);
  const discovery = discoveryRows.rows as Array<{
    source: string;
    n: number;
  }>;
  const discoveryTotal = discovery.reduce((s, r) => s + r.n, 0);

  // ─── 2. Trending events (laatste 7 dagen) ─────────────────────────
  // Save-velocity: events met meeste saves in de laatste 7 dagen, plus
  // hoeveel unieke users + of er nog upcoming occurrences zijn (zodat
  // de redactie weet of 't actionable is om te pushen).
  const trendingEventsRows = await db.execute(sql`
    WITH recent AS (
      SELECT
        e.id,
        e.title,
        e.category::text AS category,
        v.name AS venue_name,
        v.slug AS venue_slug,
        COUNT(*)::int AS recent_saves,
        COUNT(DISTINCT s.user_id)::int AS unique_users
      FROM saves s
      JOIN occurrences o ON o.id = s.occurrence_id
      JOIN events e ON e.id = o.event_id
      JOIN venues v ON v.id = e.venue_id
      WHERE s.created_at >= NOW() - INTERVAL '7 days'
        AND e.published = true
        AND v.published = true
      GROUP BY e.id, e.title, e.category, v.name, v.slug
    )
    SELECT
      r.*,
      EXISTS (
        SELECT 1 FROM occurrences o2
        WHERE o2.event_id = r.id
          AND COALESCE(o2.ends_at, o2.starts_at + INTERVAL '4 hours') >= NOW()
          AND o2.status <> 'cancelled'
      ) AS has_upcoming
    FROM recent r
    ORDER BY recent_saves DESC, unique_users DESC
    LIMIT 25
  `);
  const trendingEvents = trendingEventsRows.rows as Array<{
    id: string;
    title: string;
    category: string;
    venue_name: string;
    venue_slug: string;
    recent_saves: number;
    unique_users: number;
    has_upcoming: boolean;
  }>;

  // ─── 3. Trending venues ───────────────────────────────────────────
  // Follower-groei (30d) + save-conversion (saves-totaal / followers-
  // totaal). Een hoge ratio = volgers zetten hun follow vaak om in een
  // concrete save. Lage ratio = followers maar weinig conversie.
  const trendingVenuesRows = await db.execute(sql`
    WITH followers AS (
      SELECT
        venue_id,
        COUNT(*)::int AS total_followers,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int
          AS new_30d
      FROM venue_follows
      WHERE state = 'volgen'
      GROUP BY venue_id
    ),
    venue_saves AS (
      SELECT e.venue_id, COUNT(*)::int AS total_saves
      FROM saves s
      JOIN occurrences o ON o.id = s.occurrence_id
      JOIN events e ON e.id = o.event_id
      GROUP BY e.venue_id
    )
    SELECT
      v.id, v.name, v.slug, v.type::text AS type,
      COALESCE(f.total_followers, 0) AS followers,
      COALESCE(f.new_30d, 0) AS new_followers_30d,
      COALESCE(vs.total_saves, 0) AS total_saves
    FROM venues v
    LEFT JOIN followers f ON f.venue_id = v.id
    LEFT JOIN venue_saves vs ON vs.venue_id = v.id
    WHERE v.published = true
      AND (COALESCE(f.total_followers, 0) > 0
           OR COALESCE(vs.total_saves, 0) > 0)
    ORDER BY new_followers_30d DESC, total_saves DESC, followers DESC
    LIMIT 25
  `);
  const trendingVenues = trendingVenuesRows.rows as Array<{
    id: string;
    name: string;
    slug: string;
    type: string | null;
    followers: number;
    new_followers_30d: number;
    total_saves: number;
  }>;

  // ─── 4. Genre/cat-trends per maand (6 maanden) ────────────────────
  // Per kalender-maand totaal saves per category. UI rendert als grid:
  // rij = maand, kolom = category. Mensen zien zo direct welke cat
  // bovenkomt seizoen-op-seizoen.
  const catTrendsRows = await db.execute(sql`
    SELECT
      TO_CHAR(DATE_TRUNC('month', s.created_at), 'YYYY-MM') AS month,
      e.category::text AS category,
      COUNT(*)::int AS n
    FROM saves s
    JOIN occurrences o ON o.id = s.occurrence_id
    JOIN events e ON e.id = o.event_id
    WHERE s.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '5 months'
    GROUP BY DATE_TRUNC('month', s.created_at), e.category
    ORDER BY month DESC, n DESC
  `);
  const catTrends = catTrendsRows.rows as Array<{
    month: string;
    category: string;
    n: number;
  }>;
  // Pivot: months × categories
  const monthsSet = new Set<string>();
  const catSet = new Set<string>();
  const cellMap = new Map<string, number>(); // key `${month}|${cat}` → n
  for (const r of catTrends) {
    monthsSet.add(r.month);
    catSet.add(r.category);
    cellMap.set(`${r.month}|${r.category}`, r.n);
  }
  const months = [...monthsSet].sort().reverse(); // newest first
  const cats = [...catSet].sort();

  // ─── 5. Wijken-heatmap — saves per stadsdeel per maand ────────────
  // Beleids-/cureer-input: welke stadsdelen worden meer of minder
  // bezocht over tijd. Venues zonder wijk vallen weg (NULL).
  const wijkRows = await db.execute(sql`
    SELECT
      TO_CHAR(DATE_TRUNC('month', s.created_at), 'YYYY-MM') AS month,
      v.wijk::text AS wijk,
      COUNT(*)::int AS n
    FROM saves s
    JOIN occurrences o ON o.id = s.occurrence_id
    JOIN events e ON e.id = o.event_id
    JOIN venues v ON v.id = e.venue_id
    WHERE s.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '5 months'
      AND v.wijk IS NOT NULL
    GROUP BY DATE_TRUNC('month', s.created_at), v.wijk
    ORDER BY month DESC, n DESC
  `);
  const wijkData = wijkRows.rows as Array<{
    month: string;
    wijk: string;
    n: number;
  }>;
  const wijkMonthsSet = new Set<string>();
  const wijkSet = new Set<string>();
  const wijkCellMap = new Map<string, number>();
  let wijkMaxCell = 0;
  for (const r of wijkData) {
    wijkMonthsSet.add(r.month);
    wijkSet.add(r.wijk);
    wijkCellMap.set(`${r.month}|${r.wijk}`, r.n);
    if (r.n > wijkMaxCell) wijkMaxCell = r.n;
  }
  const wijkMonths = [...wijkMonthsSet].sort().reverse();
  // Wijken in vaste volgorde: centrum / noord / oost / west / zuid /
  // zuidoost / nieuw-west / outer (zelfde als enum-definitie).
  const WIJK_ORDER = [
    'centrum',
    'noord',
    'oost',
    'west',
    'zuid',
    'zuidoost',
    'nieuw-west',
    'diemen',
    'amstelveen',
    'haarlem',
    'zaandam',
    'haarlemmermeer',
  ];
  const wijken = WIJK_ORDER.filter((w) => wijkSet.has(w)).concat(
    [...wijkSet].filter((w) => !WIJK_ORDER.includes(w))
  );

  // ─── 6. Editorial radar — niet-clique-saves ────────────────────────
  // Events met ≥5 saves in 7d waar de savers in ≥3 verschillende
  // vriend-clusters zitten. Hoog cluster-aantal = breed signaal (niet
  // één vriend-groep die elkaar napt) → kandidaat voor newsletter-pickup.
  const radarCandidatesRows = await db.execute(sql`
    SELECT
      e.id,
      e.title,
      e.category::text AS category,
      v.name AS venue_name,
      v.slug AS venue_slug,
      ARRAY_AGG(DISTINCT s.user_id) AS user_ids
    FROM saves s
    JOIN occurrences o ON o.id = s.occurrence_id
    JOIN events e ON e.id = o.event_id
    JOIN venues v ON v.id = e.venue_id
    WHERE s.created_at >= NOW() - INTERVAL '7 days'
      AND e.published = true
      AND v.published = true
    GROUP BY e.id, e.title, e.category, v.name, v.slug
    HAVING COUNT(DISTINCT s.user_id) >= 5
  `);
  const radarCandidates = radarCandidatesRows.rows as Array<{
    id: string;
    title: string;
    category: string;
    venue_name: string;
    venue_slug: string;
    user_ids: string[];
  }>;

  // Verzamel alle unieke savers en hun friendships in één query.
  const allSavers = new Set<string>();
  for (const c of radarCandidates) {
    for (const id of c.user_ids) allSavers.add(id);
  }
  type Edge = { a: string; b: string };
  const friendEdges: Edge[] = [];
  if (allSavers.size > 0) {
    const friendsRows = await db.execute(sql`
      SELECT from_user_id, to_user_id
      FROM friendships
      WHERE status = 'accepted'
        AND from_user_id = ANY(${sql.raw(`ARRAY['${[...allSavers].join("','")}']::text[]`)})
        AND to_user_id   = ANY(${sql.raw(`ARRAY['${[...allSavers].join("','")}']::text[]`)})
    `);
    for (const f of friendsRows.rows as Array<{
      from_user_id: string;
      to_user_id: string;
    }>) {
      friendEdges.push({ a: f.from_user_id, b: f.to_user_id });
    }
  }

  // Per kandidaat: bouw friend-graph op subset van savers, tel
  // connected components via union-find.
  function countComponents(userIds: string[]): number {
    const parent = new Map<string, string>();
    for (const u of userIds) parent.set(u, u);
    const find = (x: string): string => {
      let cur = x;
      while (parent.get(cur) !== cur) cur = parent.get(cur)!;
      // path compression
      let p = x;
      while (parent.get(p) !== cur) {
        const next = parent.get(p)!;
        parent.set(p, cur);
        p = next;
      }
      return cur;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const userSet = new Set(userIds);
    for (const e of friendEdges) {
      if (userSet.has(e.a) && userSet.has(e.b)) union(e.a, e.b);
    }
    const roots = new Set<string>();
    for (const u of userIds) roots.add(find(u));
    return roots.size;
  }

  const radar = radarCandidates
    .map((c) => ({
      ...c,
      saves: c.user_ids.length,
      components: countComponents(c.user_ids),
    }))
    .filter((c) => c.components >= 3)
    .sort((a, b) => {
      if (b.components !== a.components) return b.components - a.components;
      return b.saves - a.saves;
    })
    .slice(0, 20);

  return c.html(
    <Layout title="Insights" active="insights">
      <h2>Insights</h2>
      <p style="opacity:0.7;margin-top:-0.5rem;font-size:13px;">
        Snapshot van vandaag. Aggregaten over alle users — geen persoonlijke
        identifiers.
      </p>

      {/* ── Growth ── */}
      <section style="margin-top:1.5rem;">
        <h3>Growth</h3>
        <p style="opacity:0.7;font-size:13px;">
          Actieve users op basis van laatste app-launch / tab-focus.
          `lastSeenAt` wordt 1× per uur per user bijgewerkt.
        </p>
        <div class="grid-3" style="grid-template-columns:repeat(4,1fr);">
          <div class="stat">
            <small>DAU · 24h</small>
            <strong>{growth?.dau ?? 0}</strong>
          </div>
          <div class="stat">
            <small>WAU · 7d</small>
            <strong>{growth?.wau ?? 0}</strong>
          </div>
          <div class="stat">
            <small>MAU · 30d</small>
            <strong>{growth?.mau ?? 0}</strong>
          </div>
          <div class="stat">
            <small>Totaal users</small>
            <strong>{growth?.total ?? 0}</strong>
          </div>
        </div>
        <details style="margin-top:1rem;">
          <summary style="font-size:13px;opacity:0.7;">
            Dagelijkse activiteit · laatste 30 dagen
          </summary>
          <table style="margin-top:0.75rem;">
            <thead>
              <tr>
                <th>Dag</th>
                <th style="text-align:right;">Signups</th>
                <th style="width:30%;">Signups bar</th>
                <th style="text-align:right;">Saves</th>
                <th style="width:30%;">Saves bar</th>
              </tr>
            </thead>
            <tbody>
              {dailyActivity.map((r) => (
                <tr>
                  <td style="font-family:monospace;font-size:12px;">{r.day}</td>
                  <td style="text-align:right;">
                    {r.signups > 0 ? r.signups : (
                      <span style="opacity:0.3;">·</span>
                    )}
                  </td>
                  <td>
                    {r.signups > 0 && (
                      <div
                        style={`background:#5a8a5a;height:8px;border-radius:4px;width:${(r.signups / maxSignups) * 100}%;min-width:2px;`}
                      />
                    )}
                  </td>
                  <td style="text-align:right;">
                    {r.saves > 0 ? r.saves : (
                      <span style="opacity:0.3;">·</span>
                    )}
                  </td>
                  <td>
                    {r.saves > 0 && (
                      <div
                        style={`background:#7c6cd2;height:8px;border-radius:4px;width:${(r.saves / maxSaves) * 100}%;min-width:2px;`}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      {/* ── Discovery-channel mix ── */}
      <section style="margin-top:2rem;">
        <h3>Discovery-channel mix</h3>
        <p style="opacity:0.7;font-size:13px;">
          Welk scherm levert saves op? Onbekend = saves van vóór de
          source-attributie (mei 2026).
        </p>
        {discoveryTotal === 0 ? (
          <p style="opacity:0.6;">Nog geen saves.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th style="text-align:right;">Saves</th>
                <th style="text-align:right;">Aandeel</th>
              </tr>
            </thead>
            <tbody>
              {discovery.map((d) => (
                <tr>
                  <td>{d.source}</td>
                  <td style="text-align:right;">{d.n}</td>
                  <td style="text-align:right;">
                    {((d.n / discoveryTotal) * 100).toFixed(0)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Trending events (7d) ── */}
      <section style="margin-top:2rem;">
        <h3>Trending events · laatste 7 dagen</h3>
        <p style="opacity:0.7;font-size:13px;">
          Events met de meeste saves in de laatste 7 dagen. ✓ = nog
          upcoming occurrence, actionable om te featuren.
        </p>
        {trendingEvents.length === 0 ? (
          <p style="opacity:0.6;">Nog geen saves deze week.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Event</th>
                <th>Venue</th>
                <th>Cat</th>
                <th style="text-align:right;">Saves</th>
                <th style="text-align:right;">Uniek</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {trendingEvents.map((e, i) => (
                <tr>
                  <td style="opacity:0.5;">{i + 1}</td>
                  <td>
                    <a href={`/admin/events/${e.id}`}>{e.title}</a>
                  </td>
                  <td>
                    <a href={`/admin/venues/${e.venue_slug}`}>{e.venue_name}</a>
                  </td>
                  <td>
                    <small>{e.category}</small>
                  </td>
                  <td style="text-align:right;">
                    <strong>{e.recent_saves}</strong>
                  </td>
                  <td style="text-align:right;">{e.unique_users}</td>
                  <td>
                    {e.has_upcoming ? (
                      <span class="pill pill-pub">✓ live</span>
                    ) : (
                      <span class="pill pill-unpub">voorbij</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Trending venues ── */}
      <section style="margin-top:2rem;">
        <h3>Trending venues</h3>
        <p style="opacity:0.7;font-size:13px;">
          Nieuwe volgers in de laatste 30 dagen + cumulatieve save-conversion
          (saves/volger).
        </p>
        {trendingVenues.length === 0 ? (
          <p style="opacity:0.6;">Nog geen volgers of saves.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Venue</th>
                <th>Type</th>
                <th style="text-align:right;">Volgers</th>
                <th style="text-align:right;">+30d</th>
                <th style="text-align:right;">Saves</th>
                <th style="text-align:right;">Saves/volger</th>
              </tr>
            </thead>
            <tbody>
              {trendingVenues.map((v, i) => {
                const ratio =
                  v.followers > 0
                    ? (v.total_saves / v.followers).toFixed(1)
                    : '—';
                return (
                  <tr>
                    <td style="opacity:0.5;">{i + 1}</td>
                    <td>
                      <a href={`/admin/venues/${v.slug}`}>{v.name}</a>
                    </td>
                    <td>
                      <small>{v.type ?? '—'}</small>
                    </td>
                    <td style="text-align:right;">{v.followers}</td>
                    <td style="text-align:right;">
                      {v.new_followers_30d > 0 ? (
                        <strong>+{v.new_followers_30d}</strong>
                      ) : (
                        <span style="opacity:0.4;">0</span>
                      )}
                    </td>
                    <td style="text-align:right;">{v.total_saves}</td>
                    <td style="text-align:right;">{ratio}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Genre/cat-trends per maand ── */}
      <section style="margin-top:2rem;">
        <h3>Cat-trends · laatste 6 maanden</h3>
        <p style="opacity:0.7;font-size:13px;">
          Saves per category per kalender-maand. Bovenste rij = huidige
          maand (loopt nog).
        </p>
        {months.length === 0 ? (
          <p style="opacity:0.6;">Geen saves in de laatste 6 maanden.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Maand</th>
                {cats.map((c) => (
                  <th style="text-align:right;">{c}</th>
                ))}
                <th style="text-align:right;">Totaal</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const row = cats.map((cat) => cellMap.get(`${m}|${cat}`) ?? 0);
                const total = row.reduce((s, n) => s + n, 0);
                return (
                  <tr>
                    <td>{ymToLabel(m)}</td>
                    {row.map((n) => (
                      <td style="text-align:right;">
                        {n > 0 ? n : <span style="opacity:0.3;">·</span>}
                      </td>
                    ))}
                    <td style="text-align:right;">
                      <strong>{total}</strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Wijken-heatmap ── */}
      <section style="margin-top:2rem;">
        <h3>Wijken · laatste 6 maanden</h3>
        <p style="opacity:0.7;font-size:13px;">
          Saves per stadsdeel per maand. Cellen kleuren met intensiteit
          relatief aan de hoogste cel in de matrix.
        </p>
        {wijkMonths.length === 0 ? (
          <p style="opacity:0.6;">Nog geen saves bij venues met wijk.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Maand</th>
                {wijken.map((w) => (
                  <th style="text-align:right;font-size:11px;">{w}</th>
                ))}
                <th style="text-align:right;">Totaal</th>
              </tr>
            </thead>
            <tbody>
              {wijkMonths.map((m) => {
                const row = wijken.map((w) => wijkCellMap.get(`${m}|${w}`) ?? 0);
                const total = row.reduce((s, n) => s + n, 0);
                return (
                  <tr>
                    <td>{ymToLabel(m)}</td>
                    {row.map((n) => {
                      const intensity = wijkMaxCell > 0 ? n / wijkMaxCell : 0;
                      // 0 → transparant, 1 → vol acid-tint. Pico-dark
                      // achtergrond is #131316, dus we overlay'en met
                      // een halftransparante acid.
                      const bg = intensity > 0
                        ? `rgba(212,255,58,${(0.08 + intensity * 0.35).toFixed(2)})`
                        : 'transparent';
                      return (
                        <td
                          style={`text-align:right;background:${bg};`}
                        >
                          {n > 0 ? n : (
                            <span style="opacity:0.25;">·</span>
                          )}
                        </td>
                      );
                    })}
                    <td style="text-align:right;">
                      <strong>{total}</strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Editorial radar ── */}
      <section style="margin-top:2rem;">
        <h3>Editorial radar</h3>
        <p style="opacity:0.7;font-size:13px;">
          Events met ≥5 saves in 7d waarvan de savers in ≥3 verschillende
          vriend-clusters zitten. Hoog clusters-getal = breed signaal, geen
          echo-kamer-effect. Kandidaten om editorial op te pikken.
        </p>
        {radar.length === 0 ? (
          <p style="opacity:0.6;">
            Geen events met breed signaal deze week.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Event</th>
                <th>Venue</th>
                <th>Cat</th>
                <th style="text-align:right;">Clusters</th>
                <th style="text-align:right;">Saves</th>
              </tr>
            </thead>
            <tbody>
              {radar.map((r, i) => (
                <tr>
                  <td style="opacity:0.5;">{i + 1}</td>
                  <td>
                    <a href={`/admin/events/${r.id}`}>{r.title}</a>
                  </td>
                  <td>
                    <a href={`/admin/venues/${r.venue_slug}`}>
                      {r.venue_name}
                    </a>
                  </td>
                  <td>
                    <small>{r.category}</small>
                  </td>
                  <td style="text-align:right;">
                    <strong>{r.components}</strong>
                  </td>
                  <td style="text-align:right;">{r.saves}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Layout>,
  );
});

/* ═══════════════════════════════════════════════════════════════════════
 * /admin/social — IG-post-generator, draft-overzicht, approve-flow.
 *
 * Mens-in-de-loop voor de eerste week: genereer een draft, bekijk
 * caption + slides, approve of skip. De cron-publisher pakt later
 * alleen wat status='approved' is.
 *
 * Geen full preview hier — voor de tijdelijke debug-page zie
 * /admin/api/social/preview?slot=evening (Bearer/cookie auth).
 * ═══════════════════════════════════════════════════════════════════ */

const SLOT_LABEL: Record<Slot, string> = {
  morning: 'Ochtend (09:00)',
  afternoon: 'Middag (14:00)',
  evening: 'Avond (19:00)',
};

const SOCIAL_STATUS_LABEL: Record<string, string> = {
  draft: 'concept',
  approved: 'klaar voor publicatie',
  posted: 'gepost',
  skipped: 'overgeslagen',
  failed: 'mislukt',
};

function socialStatusPillStyle(status: string): string {
  const base = 'display:inline-block;padding:0.15rem 0.55rem;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;';
  switch (status) {
    case 'draft':
      return base + 'background:#3a3a1d;color:#f3eab6;';
    case 'approved':
      return base + 'background:#1d4d2c;color:#b6f3c8;';
    case 'posted':
      return base + 'background:#1d3a4d;color:#b6d8f3;';
    case 'skipped':
      return base + 'background:#2a2a2e;color:#9a9a94;';
    case 'failed':
      return base + 'background:#4d1d1d;color:#f3b6b6;';
    default:
      return base + 'background:#2a2a2e;color:#9a9a94;';
  }
}

interface SocialPostRow {
  id: string;
  slot: string;
  status: string;
  scheduledFor: Date;
  createdAt: Date;
  postedAt: Date | null;
  caption: string | null;
  imageUrls: string[];
  eventIds: string[];
  igMediaId: string | null;
  error: string | null;
  meta: {
    occurrenceIds?: string[];
    templateVersion?: string;
    scoreBreakdown?: Record<string, number>;
    skippedEventIds?: string[];
    permalink?: string;
  } | null;
}

adminUi.get('/social', async (c) => {
  const flash = c.req.query('flash');
  const error = c.req.query('error');

  const rows = (await db
    .select()
    .from(schema.socialPosts)
    .orderBy(desc(schema.socialPosts.createdAt))
    .limit(50)) as SocialPostRow[];

  return c.html(
    <Layout title="Social" active="social">
      <div class="toolbar">
        <h2>Social — IG-posts</h2>
      </div>

      {flash && (
        <p
          style="background:#1d4d2c;color:#b6f3c8;padding:0.6rem 0.9rem;border-radius:6px;font-size:13px;margin-bottom:1rem;"
        >
          {flash}
        </p>
      )}
      {error && (
        <p
          style="background:#4d1d1d;color:#f3b6b6;padding:0.6rem 0.9rem;border-radius:6px;font-size:13px;margin-bottom:1rem;"
        >
          {error}
        </p>
      )}

      <article style="margin-bottom:2rem;">
        <h3 style="margin-top:0;">Nieuwe carousel genereren</h3>
        <p style="font-size:13px;color:var(--pico-muted-color);margin-bottom:0.75rem;">
          Selecteert 3 picks voor het gekozen slot, rendert de slides, uploadt naar Bunny en
          vraagt Claude een caption. Resultaat verschijnt als concept onderin.
        </p>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
          {SLOTS.map((slot) => (
            <form method="post" action="/admin/social/generate" style="margin:0;">
              <input type="hidden" name="slot" value={slot} />
              <button type="submit" class="secondary">
                Genereer {SLOT_LABEL[slot]}
              </button>
            </form>
          ))}
        </div>
      </article>

      {rows.length === 0 ? (
        <p style="color:var(--pico-muted-color);">
          Nog geen posts. Klik hierboven op een slot om je eerste carousel te genereren.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th style="width:90px;">Status</th>
              <th>Slot · gepland</th>
              <th style="width:120px;">Slides</th>
              <th>Caption</th>
              <th style="width:240px;">Acties</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((post) => {
              const slotLabel = SLOT_LABEL[post.slot as Slot] ?? post.slot;
              const statusLabel = SOCIAL_STATUS_LABEL[post.status] ?? post.status;
              const captionPreview = post.caption
                ? post.caption.length > 140
                  ? post.caption.slice(0, 140) + '…'
                  : post.caption
                : '—';
              const firstImage = post.imageUrls[0];
              return (
                <tr>
                  <td>
                    <span style={socialStatusPillStyle(post.status)}>{statusLabel}</span>
                    {post.error && (
                      <div
                        style="font-size:11px;color:#f3b6b6;margin-top:4px;max-width:200px;"
                        title={post.error}
                      >
                        {post.error.length > 50 ? post.error.slice(0, 50) + '…' : post.error}
                      </div>
                    )}
                  </td>
                  <td>
                    <strong>{slotLabel}</strong>
                    <br />
                    <small style="color:var(--pico-muted-color);">
                      {fmtDate(post.scheduledFor)}
                    </small>
                    {post.postedAt && (
                      <>
                        <br />
                        <small style="color:#b6d8f3;">
                          gepost {fmtDate(post.postedAt)}
                        </small>
                      </>
                    )}
                  </td>
                  <td>
                    {firstImage ? (
                      <a
                        href={`/admin/social/${post.id}`}
                        title={`${post.imageUrls.length} slides`}
                      >
                        <img
                          src={firstImage}
                          alt=""
                          style="width:60px;height:75px;object-fit:cover;border-radius:4px;display:block;"
                        />
                      </a>
                    ) : (
                      <small style="color:var(--pico-muted-color);">geen slides</small>
                    )}
                    <small style="display:block;color:var(--pico-muted-color);margin-top:2px;font-size:11px;">
                      {post.imageUrls.length} slides · {post.eventIds.length} events
                    </small>
                  </td>
                  <td style="font-size:13px;max-width:340px;">
                    <pre style="margin:0;font-family:inherit;white-space:pre-wrap;font-size:12px;line-height:1.4;">
                      {captionPreview}
                    </pre>
                  </td>
                  <td class="actions">
                    <a
                      href={`/admin/social/${post.id}`}
                      role="button"
                      class="outline"
                      style="padding:0.25rem 0.6rem;font-size:12px;"
                    >
                      Bekijk
                    </a>
                    {post.status === 'draft' && (
                      <>
                        <form
                          method="post"
                          action={`/admin/social/${post.id}/approve`}
                        >
                          <button type="submit">Goedkeuren</button>
                        </form>
                        <form
                          method="post"
                          action={`/admin/social/${post.id}/regenerate`}
                          onsubmit="return confirm('Slides + caption opnieuw genereren? Dit overschrijft de huidige.');"
                        >
                          <button type="submit" class="secondary outline">
                            Opnieuw
                          </button>
                        </form>
                      </>
                    )}
                    {post.status === 'approved' && (
                      <form
                        method="post"
                        action={`/admin/social/${post.id}/publish`}
                        onsubmit="return confirm('Nu publiceren naar Instagram?');"
                      >
                        <button type="submit">Publiceer</button>
                      </form>
                    )}
                    {post.status !== 'posted' && (
                      <form
                        method="post"
                        action={`/admin/social/${post.id}/delete`}
                        onsubmit="return confirm('Deze post definitief verwijderen?');"
                      >
                        <button type="submit" class="secondary outline">
                          Verwijder
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Layout>,
  );
});

adminUi.get('/social/:id', async (c) => {
  const id = c.req.param('id');
  const [post] = (await db
    .select()
    .from(schema.socialPosts)
    .where(eq(schema.socialPosts.id, id))) as SocialPostRow[];
  if (!post) {
    return c.html(
      <Layout title="Social — niet gevonden" active="social">
        <p>Post niet gevonden. <a href="/admin/social">Terug</a></p>
      </Layout>,
      404,
    );
  }
  const slotLabel = SLOT_LABEL[post.slot as Slot] ?? post.slot;
  const statusLabel = SOCIAL_STATUS_LABEL[post.status] ?? post.status;
  return c.html(
    <Layout title={`Social · ${slotLabel}`} active="social">
      <div class="toolbar">
        <h2>
          {slotLabel}{' '}
          <span style={socialStatusPillStyle(post.status)}>{statusLabel}</span>
        </h2>
        <a href="/admin/social" role="button" class="outline">
          Terug
        </a>
      </div>

      <p style="color:var(--pico-muted-color);font-size:13px;margin-top:-0.5rem;">
        ID <code>{post.id}</code> · gepland {fmtDate(post.scheduledFor)} · aangemaakt{' '}
        {fmtDate(post.createdAt)}
        {post.postedAt && <> · gepost {fmtDate(post.postedAt)}</>}
      </p>

      {post.error && (
        <article style="background:#4d1d1d;color:#f3b6b6;">
          <strong>Fout:</strong> {post.error}
        </article>
      )}

      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1.5rem;">
        {post.status === 'draft' && (
          <>
            <form method="post" action={`/admin/social/${post.id}/approve`} style="margin:0;">
              <button type="submit">Goedkeuren</button>
            </form>
            <form
              method="post"
              action={`/admin/social/${post.id}/regenerate`}
              style="margin:0;"
              onsubmit="return confirm('Slides + caption opnieuw genereren? Dit overschrijft de huidige.');"
            >
              <button type="submit" class="secondary outline">
                Opnieuw genereren
              </button>
            </form>
          </>
        )}
        {post.status === 'approved' && (
          <form
            method="post"
            action={`/admin/social/${post.id}/publish`}
            style="margin:0;"
            onsubmit="return confirm('Nu publiceren naar Instagram?');"
          >
            <button type="submit">Publiceer naar Instagram</button>
          </form>
        )}
        {post.status === 'posted' && post.meta?.permalink && (
          <a
            href={post.meta.permalink}
            role="button"
            class="outline"
            target="_blank"
            rel="noreferrer"
          >
            Bekijk op Instagram ↗
          </a>
        )}
        {post.status !== 'posted' && (
          <form
            method="post"
            action={`/admin/social/${post.id}/delete`}
            style="margin:0;"
            onsubmit="return confirm('Deze post definitief verwijderen?');"
          >
            <button type="submit" class="secondary outline">
              Verwijderen
            </button>
          </form>
        )}
      </div>

      {post.status === 'posted' && post.igMediaId && (
        <p style="color:var(--pico-muted-color);font-size:13px;">
          IG media-id: <code>{post.igMediaId}</code>
        </p>
      )}

      <div style="display:flex;align-items:center;gap:0.75rem;margin-top:0.5rem;">
        <h3 style="margin:0;">Caption</h3>
        {post.status === 'draft' && (
          <form
            method="post"
            action={`/admin/social/${post.id}/regenerate-caption`}
            style="margin:0;"
          >
            <button
              type="submit"
              class="secondary outline"
              style="padding:0.2rem 0.55rem;font-size:12px;margin:0;"
            >
              Probeer een alternatief
            </button>
          </form>
        )}
      </div>
      <pre style="background:#0a0a0b;padding:1rem;border-radius:6px;white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.5;">
        {post.caption ?? '(geen caption)'}
      </pre>

      <h3 style="margin-top:1.5rem;">Slides ({post.imageUrls.length})</h3>
      <div style="display:flex;flex-wrap:wrap;gap:16px;">
        {post.imageUrls.map((url, i) => (
          <figure style="margin:0;">
            <img
              src={url}
              alt={`slide ${i + 1}`}
              style="width:260px;height:325px;object-fit:cover;border-radius:8px;display:block;background:#0a0a0b;"
            />
            <figcaption style="font-size:11px;color:var(--pico-muted-color);text-align:center;margin-top:4px;">
              slide {i + 1}
            </figcaption>
          </figure>
        ))}
      </div>

      <h3 style="margin-top:1.5rem;">Events ({post.eventIds.length})</h3>
      <ul style="list-style:none;padding:0;">
        {post.eventIds.map((eid) => (
          <li style="display:flex;align-items:center;gap:0.75rem;padding:0.4rem 0;border-bottom:1px solid var(--pico-muted-border-color);">
            <a href={`/admin/events/${eid}`} style="flex:1;">
              <code>{eid}</code>
            </a>
            {post.status === 'draft' && (
              <form
                method="post"
                action={`/admin/social/${post.id}/regenerate`}
                style="margin:0;"
                onsubmit="return confirm('Dit event skippen en een alternatief kiezen?');"
              >
                <input type="hidden" name="skip" value={eid} />
                <button
                  type="submit"
                  class="secondary outline"
                  style="padding:0.25rem 0.6rem;font-size:12px;margin:0;"
                >
                  Skip & probeer alternatief
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>

      {(post.meta?.skippedEventIds?.length ?? 0) > 0 && (
        <section style="margin-top:1.25rem;padding:0.75rem 1rem;background:#1a1a1d;border-radius:6px;">
          <strong style="font-size:13px;">
            Eerder geskipt ({post.meta?.skippedEventIds?.length})
          </strong>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:0.5rem;">
            {(post.meta?.skippedEventIds ?? []).map((eid) => (
              <a
                href={`/admin/events/${eid}`}
                style="font-size:11px;font-family:ui-monospace,Menlo,monospace;background:#2a2a2e;color:#9a9a94;padding:0.15rem 0.5rem;border-radius:4px;text-decoration:none;"
              >
                {eid}
              </a>
            ))}
          </div>
          {post.status === 'draft' && (
            <form
              method="post"
              action={`/admin/social/${post.id}/regenerate`}
              style="margin:0.75rem 0 0 0;"
              onsubmit="return confirm('Skip-lijst wissen en alle events weer mogelijk maken?');"
            >
              <input type="hidden" name="reset" value="1" />
              <button
                type="submit"
                class="secondary outline"
                style="padding:0.25rem 0.6rem;font-size:12px;margin:0;"
              >
                Skip-lijst wissen
              </button>
            </form>
          )}
        </section>
      )}
    </Layout>,
  );
});

adminUi.post('/social/generate', async (c) => {
  const form = await c.req.parseBody();
  const slotRaw = String(form.slot ?? '');
  if (!(SLOTS as readonly string[]).includes(slotRaw)) {
    return c.redirect('/admin/social?error=' + encodeURIComponent('Ongeldig slot'));
  }
  const slot = slotRaw as Slot;
  try {
    const { post, warnings } = await runGenerate(slot);
    const flash =
      `Concept aangemaakt voor ${SLOT_LABEL[slot]}.` +
      (warnings.length > 0 ? ' Let op: ' + warnings.join('; ') : '');
    return c.redirect(
      `/admin/social/${post.id}?flash=${encodeURIComponent(flash)}`,
    );
  } catch (e) {
    return c.redirect(
      '/admin/social?error=' + encodeURIComponent((e as Error).message),
    );
  }
});

adminUi.post('/social/:id/approve', async (c) => {
  const id = c.req.param('id');
  const [updated] = await db
    .update(schema.socialPosts)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(
      and(
        eq(schema.socialPosts.id, id),
        eq(schema.socialPosts.status, 'draft'),
      ),
    )
    .returning();
  if (!updated) {
    return c.redirect(
      '/admin/social?error=' +
        encodeURIComponent('Alleen concepten kunnen worden goedgekeurd'),
    );
  }
  return c.redirect(
    '/admin/social?flash=' + encodeURIComponent('Goedgekeurd — wacht op publish-cron'),
  );
});

adminUi.post('/social/:id/publish', async (c) => {
  const id = c.req.param('id');
  try {
    const { igMediaId } = await runPublish(id);
    return c.redirect(
      `/admin/social/${id}?flash=` +
        encodeURIComponent(`Gepubliceerd op Instagram (media-id ${igMediaId})`),
    );
  } catch (e) {
    return c.redirect(
      `/admin/social/${id}?error=` + encodeURIComponent((e as Error).message),
    );
  }
});

adminUi.post('/social/:id/delete', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db
    .select({ status: schema.socialPosts.status })
    .from(schema.socialPosts)
    .where(eq(schema.socialPosts.id, id));
  if (!existing) {
    return c.redirect('/admin/social?error=' + encodeURIComponent('Niet gevonden'));
  }
  if (existing.status === 'posted') {
    return c.redirect(
      '/admin/social?error=' +
        encodeURIComponent('Geposte berichten kunnen niet worden verwijderd'),
    );
  }
  await db.delete(schema.socialPosts).where(eq(schema.socialPosts.id, id));
  return c.redirect('/admin/social?flash=' + encodeURIComponent('Verwijderd'));
});

/** Alleen de caption opnieuw vragen aan Claude — slides en picks blijven. */
adminUi.post('/social/:id/regenerate-caption', async (c) => {
  const id = c.req.param('id');
  const [existing] = (await db
    .select()
    .from(schema.socialPosts)
    .where(eq(schema.socialPosts.id, id))) as SocialPostRow[];
  if (!existing) {
    return c.redirect('/admin/social?error=' + encodeURIComponent('Niet gevonden'));
  }
  if (existing.status !== 'draft') {
    return c.redirect(
      `/admin/social/${id}?error=` +
        encodeURIComponent('Alleen concepten kunnen worden aangepast'),
    );
  }
  const occurrenceIds = existing.meta?.occurrenceIds ?? [];
  if (occurrenceIds.length === 0) {
    return c.redirect(
      `/admin/social/${id}?error=` +
        encodeURIComponent('Geen occurrence-IDs opgeslagen voor deze post'),
    );
  }

  const rows = await db
    .select({
      occurrenceId: schema.occurrences.id,
      startsAt: schema.occurrences.startsAt,
      title: schema.events.title,
      category: schema.events.category,
      venueName: schema.venues.name,
      venueType: schema.venues.type,
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(inArray(schema.occurrences.id, occurrenceIds));

  // Herstel oorspronkelijke volgorde uit meta zodat Claude dezelfde lijst ziet
  const ordered = occurrenceIds
    .map((oid) => rows.find((r) => r.occurrenceId === oid))
    .filter((r): r is NonNullable<typeof r> => r != null);

  if (ordered.length === 0) {
    return c.redirect(
      `/admin/social/${id}?error=` +
        encodeURIComponent('Bijbehorende events kunnen niet meer worden gevonden'),
    );
  }

  try {
    const result = await generateCaption({
      date: existing.scheduledFor,
      picks: ordered.map((r) => ({
        title: r.title,
        venueName: r.venueName,
        venueType: r.venueType,
        category: r.category,
        startsAt: r.startsAt,
      })),
    });
    await db
      .update(schema.socialPosts)
      .set({ caption: result.caption, updatedAt: new Date() })
      .where(eq(schema.socialPosts.id, id));
    const flashText =
      result.source === 'fallback'
        ? 'Caption ververst (fallback — Claude niet bereikt)'
        : 'Caption ververst';
    return c.redirect(`/admin/social/${id}?flash=` + encodeURIComponent(flashText));
  } catch (e) {
    return c.redirect(
      `/admin/social/${id}?error=` + encodeURIComponent((e as Error).message),
    );
  }
});

adminUi.post('/social/:id/regenerate', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.parseBody();
  const skipParam = String(form.skip ?? '').trim();
  const resetSkips = String(form.reset ?? '') === '1';

  const [existing] = await db
    .select()
    .from(schema.socialPosts)
    .where(eq(schema.socialPosts.id, id));
  if (!existing) {
    return c.redirect('/admin/social?error=' + encodeURIComponent('Niet gevonden'));
  }
  if (existing.status !== 'draft') {
    return c.redirect(
      '/admin/social?error=' +
        encodeURIComponent('Alleen concepten kunnen worden regenererd'),
    );
  }

  const accumulated = new Set<string>(
    resetSkips ? [] : (existing.meta?.skippedEventIds ?? []),
  );
  for (const raw of skipParam.split(',').map((s) => s.trim()).filter(Boolean)) {
    accumulated.add(raw);
  }

  try {
    await runGenerate(existing.slot as Slot, {
      existingId: id,
      skipIds: accumulated,
    });
    const flashText = resetSkips
      ? 'Skip-lijst gewist en opnieuw gegenereerd'
      : skipParam
        ? `Event geskipt, alternatief gekozen`
        : 'Opnieuw gegenereerd';
    return c.redirect(
      `/admin/social/${id}?flash=` + encodeURIComponent(flashText),
    );
  } catch (e) {
    return c.redirect(
      `/admin/social/${id}?error=` + encodeURIComponent((e as Error).message),
    );
  }
});
