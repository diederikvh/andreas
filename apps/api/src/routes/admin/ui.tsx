import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, gte } from 'drizzle-orm';
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

const CATEGORIES = ['Muziek', 'Theater', 'Literatuur', 'Film'] as const;
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
  const [eventsUpcoming] = await db
    .select({ n: count() })
    .from(schema.events)
    .where(
      and(eq(schema.events.published, true), gte(schema.events.startsAt, now))
    );
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
  const now = new Date();

  const conditions = [];
  if (filter === 'upcoming') {
    conditions.push(gte(schema.events.startsAt, now));
  }
  if (filter === 'unpublished') {
    conditions.push(eq(schema.events.published, false));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      startsAt: schema.events.startsAt,
      category: schema.events.category,
      featured: schema.events.featured,
      published: schema.events.published,
      venueName: schema.venues.name,
      venueSlug: schema.venues.slug,
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(where)
    .orderBy(asc(schema.events.startsAt));

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
              <td style="white-space:nowrap;">{fmtDate(r.startsAt)}</td>
              <td>
                <a href={`/admin/events/${encodeURIComponent(r.id)}`}>{r.title}</a>
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
  const startsAt = fromDateTimeLocal(String(form.startsAt ?? ''));
  if (!title || !venueId || !startsAt) {
    return c.html(<Layout title="Fout"><p>Titel, venue en starttijd verplicht.</p></Layout>, 400);
  }
  await db.insert(schema.events).values({
    id,
    title,
    venueId,
    startsAt,
    endsAt: fromDateTimeLocal(String(form.endsAt ?? '')),
    description: (form.description as string) || null,
    imageUrl: (form.imageUrl as string) || null,
    ticketUrl: (form.ticketUrl as string) || null,
    priceCents: form.priceCents ? Number(form.priceCents) : null,
    priceNote: form.priceNote ? String(form.priceNote).trim() || null : null,
    category: (CATEGORIES as readonly string[]).includes(String(form.category))
      ? (String(form.category) as Category)
      : 'Muziek',
    featured: form.featured === 'on',
    genres: parseTagsField(String(form.genres ?? '')),
    published: form.published !== 'off',
  });
  return c.redirect('/admin/events');
});

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
      <EventForm event={event} venues={venues} />
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
  const startsAt = fromDateTimeLocal(String(form.startsAt ?? ''));
  if (!startsAt) {
    return c.html(<Layout title="Fout"><p>Starttijd verplicht.</p></Layout>, 400);
  }
  await db
    .update(schema.events)
    .set({
      title: String(form.title ?? '').trim(),
      venueId: String(form.venueId ?? ''),
      startsAt,
      endsAt: fromDateTimeLocal(String(form.endsAt ?? '')),
      description: (form.description as string) || null,
      imageUrl: (form.imageUrl as string) || null,
      ticketUrl: (form.ticketUrl as string) || null,
      priceCents: form.priceCents ? Number(form.priceCents) : null,
      priceNote: form.priceNote ? String(form.priceNote).trim() || null : null,
      category: (CATEGORIES as readonly string[]).includes(String(form.category))
        ? (String(form.category) as Category)
        : 'Muziek',
      featured: form.featured === 'on',
      genres: parseTagsField(String(form.genres ?? '')),
      published: form.published !== 'off',
    })
    .where(eq(schema.events.id, id));
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
  venues,
}: {
  event?: typeof schema.events.$inferSelect;
  venues: { id: string; name: string }[];
}) {
  const action = event ? `/admin/events/${encodeURIComponent(event.id)}` : '/admin/events/new';
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
      <div class="grid-2">
        <label>
          Start
          <input
            type="datetime-local"
            name="startsAt"
            required
            value={toDateTimeLocal(event?.startsAt ?? null)}
          />
        </label>
        <label>
          Eind (optioneel)
          <input
            type="datetime-local"
            name="endsAt"
            value={toDateTimeLocal(event?.endsAt ?? null)}
          />
        </label>
      </div>
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
        Ticket URL
        <input type="url" name="ticketUrl" value={event?.ticketUrl ?? ''} />
      </label>
      <label>
        Prijs (cents) — laat leeg voor "—" of zet 0 voor "Gratis"
        <input type="number" name="priceCents" min="0" step="50" value={event?.priceCents ?? ''} />
      </label>
      <label>
        Prijs-noot (vrij — overschrijft venue-default; bv. "lidmaatschap vereist")
        <input type="text" name="priceNote" value={event?.priceNote ?? ''} placeholder="leeg = erf van venue" />
      </label>
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
      <button type="submit">{event ? 'Opslaan' : 'Event aanmaken'}</button>
    </form>
  );
}

// ─── Venues ─────────────────────────────────────────────────────────────

adminUi.get('/venues', async (c) => {
  const rows = await db
    .select()
    .from(schema.venues)
    .orderBy(asc(schema.venues.name));

  // Inline JS voor:
  //   • zoek-filter (naam) en image-filter (alle / zonder)
  //   • drag-and-drop image-upload per rij — drop een file op een
  //     rij-thumbnail en de file gaat direct naar /admin/api/uploads,
  //     daarna PATCH naar /admin/api/venues/:id met de nieuwe URL.
  const script = `
(function () {
  const search = document.getElementById('venue-search');
  const filter = document.getElementById('venue-imgfilter');
  const rows = Array.from(document.querySelectorAll('[data-venue-row]'));

  function applyFilter() {
    const q = (search.value || '').trim().toLowerCase();
    const f = filter.value;
    let visible = 0;
    for (const r of rows) {
      const name = r.dataset.name || '';
      const hasImg = r.dataset.hasimage === '1';
      let show = true;
      if (q && !name.toLowerCase().includes(q)) show = false;
      if (f === 'noimg' && hasImg) show = false;
      if (f === 'hasimg' && !hasImg) show = false;
      r.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    document.getElementById('venue-count').textContent = visible + ' / ' + rows.length;
  }
  search.addEventListener('input', applyFilter);
  filter.addEventListener('change', applyFilter);

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
          <option value="all">Alle</option>
          <option value="noimg">Zonder foto</option>
          <option value="hasimg">Met foto</option>
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th class="thumb-cell"></th>
            <th>Naam</th>
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
          {rows.map((v) => (
            <tr
              class={v.published ? '' : 'row-unpub'}
              data-venue-row
              data-venue-id={v.id}
              data-name={v.name}
              data-hasimage={v.imageUrl ? '1' : '0'}
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
          ))}
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
  return c.html(
    <Layout title={venue.name} active="venues">
      <div class="toolbar">
        <h2>{venue.name}</h2>
        <PublishedPill published={venue.published} />
      </div>
      <VenueForm venue={venue} />
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
    published: form.published !== 'off',
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

  // Gekoppelde events (alle, ook verleden, om te zien wat er hangt).
  const linked = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      startsAt: schema.events.startsAt,
      published: schema.events.published,
      venueName: schema.venues.name,
    })
    .from(schema.eventsInSeries)
    .innerJoin(schema.events, eq(schema.events.id, schema.eventsInSeries.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(eq(schema.eventsInSeries.seriesId, id))
    .orderBy(asc(schema.events.startsAt));

  // Beschikbare events om te koppelen — toekomst-only zodat de dropdown
  // niet vol staat met oude events.
  const linkedIds = new Set(linked.map((l) => l.id));
  const available = (
    await db
      .select({
        id: schema.events.id,
        title: schema.events.title,
        startsAt: schema.events.startsAt,
        venueName: schema.venues.name,
      })
      .from(schema.events)
      .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
      .where(gte(schema.events.startsAt, new Date()))
      .orderBy(asc(schema.events.startsAt))
  ).filter((e) => !linkedIds.has(e.id));

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
      published: form.published !== 'off',
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
      <label>
        <input type="checkbox" name="published" checked={series?.published ?? true} />
        Live
      </label>
      <button type="submit">{series ? 'Opslaan' : 'Serie aanmaken'}</button>
    </form>
  );
}
