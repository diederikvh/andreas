/**
 * "Meer zoals wat je doet": aanbevelingen met een reden per event.
 *
 * Geen score die je niet kan uitleggen, maar dezelfde keurder als bij de
 * smaakmeldingen, met jouw keuzes als voorbeelden: waar je heen gaat en wat
 * je gered hebt (past wel), wat je wegveegde (past niet), plus je gevolgde
 * artiesten, genres leuk/niet leuk en de omschrijvingen van je meldingen.
 *
 * Twee stappen, zodat het betaalbaar en snel blijft:
 *  1. Kandidaten binnen de grenzen, zonder wat al in je agenda staat, wat je
 *     gered of weggeveegd hebt, geblokkeerde zalen en niet-leuk-genres (dat
 *     laatste via `ALERT_MATCH`, dezelfde regels als de meldingen). Een
 *     snelle voorselectie op zalen waar je komt, genre-overlap en gevolgde
 *     artiesten kiest er `JUDGE_TOP` uit.
 *  2. De keurder beoordeelt die en geeft per treffer een reden.
 */
import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { GENRES, MAIN_LABELS, genresOf, type Category, type GenreKey } from './genres.js';
import { judgeMany, loadEventInfo, type FeedbackExample } from './judge.js';
import { ALERT_MATCH, GENRE_ALIAS_CTE, alertSource } from './match.js';
import { honestReason } from './reason.js';

/** Hoeveel kandidaten de keurder ziet. */
const JUDGE_TOP = 50;

export type Recommendation = {
  eventId: string;
  title: string;
  venue: string;
  city: string;
  startsAt: string;
  reason: string;
};

type Profile = {
  taste: string;
  examples: FeedbackExample[];
  venueIds: Set<string>;
  genreWeights: Map<GenreKey, number>;
  artistNames: string[];
  categories: Set<string>;
  cities: Map<string, number>;
};

/** Alles wat we van iemands smaak weten, samengevat voor de keurder en de
    voorselectie. */
async function buildProfile(userId: string): Promise<Profile> {
  const chosen = await db.execute<{
    title: string;
    venue: string;
    venue_id: string;
    city: string;
    category: Category;
    genres: string[];
    how: 'going' | 'saved';
  }>(sql`
    SELECT DISTINCT ON (e.id) e.title, v.name AS venue, v.id AS venue_id, v.city::text AS city,
           e.category::text AS category, e.genres, x.how
    FROM (
      SELECT occurrence_id, 'going' AS how, created_at FROM attendance WHERE user_id = ${userId}
      UNION ALL
      SELECT occurrence_id, 'saved', created_at FROM saves WHERE user_id = ${userId}
    ) x
    JOIN occurrences o ON o.id = x.occurrence_id
    JOIN events e ON e.id = o.event_id
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id)
    WHERE x.created_at > NOW() - INTERVAL '365 days'
    ORDER BY e.id, CASE x.how WHEN 'going' THEN 0 ELSE 1 END
  `);
  const dismissed = await db.execute<{ title: string; venue: string }>(sql`
    SELECT DISTINCT ON (e.id) e.title, v.name AS venue
    FROM dismisses d
    JOIN occurrences o ON o.id = d.occurrence_id
    JOIN events e ON e.id = o.event_id
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id)
    WHERE d.user_id = ${userId}
    ORDER BY e.id, d.created_at DESC
    LIMIT 8
  `);
  const [artists, prefs, alerts, followedVenues] = await Promise.all([
    db.execute<{ name: string }>(sql`
      SELECT ar.name FROM artist_follows f JOIN artists ar ON ar.id = f.artist_id WHERE f.user_id = ${userId}`),
    db.execute<{ genre: string; sentiment: string }>(sql`
      SELECT genre, sentiment FROM genre_prefs WHERE user_id = ${userId}`),
    db.execute<{ taste: string }>(sql`
      SELECT taste FROM alerts WHERE user_id = ${userId} AND taste IS NOT NULL AND active`),
    db.execute<{ venue_id: string }>(sql`
      SELECT venue_id FROM venue_follows WHERE user_id = ${userId} AND state = 'volgen'`),
  ]);

  const genreWeights = new Map<GenreKey, number>();
  const bump = (k: GenreKey, w: number) => genreWeights.set(k, (genreWeights.get(k) ?? 0) + w);
  const venueIds = new Set(followedVenues.rows.map((r) => r.venue_id));
  const categories = new Set<string>();
  const cities = new Map<string, number>();
  for (const c of chosen.rows) {
    venueIds.add(c.venue_id);
    categories.add(c.category);
    cities.set(c.city, (cities.get(c.city) ?? 0) + 1);
    for (const k of genresOf(c.category, c.genres.slice(0, MAIN_LABELS))) bump(k, c.how === 'going' ? 2 : 1);
  }
  const likes = prefs.rows.filter((p) => p.sentiment === 'like').map((p) => p.genre as GenreKey);
  const dislikes = prefs.rows.filter((p) => p.sentiment === 'dislike').map((p) => p.genre as GenreKey);
  for (const k of likes) bump(k, 3);

  const label = (k: GenreKey) => GENRES[k]?.label ?? k;
  const topGenres = [...genreWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => label(k));
  const parts = [
    alerts.rows.length ? `Eigen omschrijvingen: ${alerts.rows.map((a) => `"${a.taste}"`).join('; ')}.` : '',
    artists.rows.length ? `Volgt: ${artists.rows.map((a) => a.name).join(', ')}.` : '',
    topGenres.length ? `Kiest vooral: ${topGenres.join(', ')}.` : '',
    dislikes.length ? `Wil niet: ${dislikes.map(label).join(', ')}.` : '',
  ].filter(Boolean);

  // Voorbeelden: recent gekozen (ik ga eerst) en een paar weggeveegde.
  const examples: FeedbackExample[] = [
    ...chosen.rows
      .sort((a, b) => (a.how === b.how ? 0 : a.how === 'going' ? -1 : 1))
      .slice(0, 14)
      .map((c) => ({ title: c.title, venue: c.venue, fits: true, note: c.how === 'going' ? 'ik ga' : 'gered' })),
    ...dismissed.rows.map((d) => ({ title: d.title, venue: d.venue, fits: false, note: 'niet interessant' })),
  ];

  return {
    taste:
      'Aanbevelingen: zou deze persoon dit event willen weten, gezien wat die tot nu toe koos? ' +
      (parts.join(' ') || 'Nog weinig bekend; ga af op de voorbeelden.'),
    examples,
    venueIds,
    genreWeights,
    artistNames: artists.rows.map((a) => a.name.toLowerCase()),
    categories,
    cities,
  };
}

export async function recommendEvents(
  userId: string,
  opts: { cities?: string[]; categories?: string[]; from?: Date; to?: Date; limit?: number } = {}
): Promise<{ recommendations: Recommendation[]; judged: number; basis: string }> {
  const profile = await buildProfile(userId);
  // Zonder opgegeven stad: de steden waar je zelf heen gaat. Zonder soort:
  // de soorten die je kiest. Zo blijft de kandidatenlijst behapbaar.
  const cities = opts.cities?.length
    ? opts.cities
    : [...profile.cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
  const categories = opts.categories?.length ? opts.categories : [...profile.categories];
  const from = opts.from ?? new Date();
  const to = opts.to ?? new Date(Date.now() + 60 * 86_400_000);

  const source = alertSource({
    userId,
    venueIds: null,
    cities: cities.length ? cities : null,
    categories: categories.length ? categories : null,
    genres: null,
    artistNames: null,
    priceMaxCents: null,
    startsFrom: from,
    startsUntil: to,
  });
  const rows = await db.execute<{
    id: string;
    category: Category;
    genres: string[];
    venue_id: string;
    title: string;
    lineup: string[] | null;
  }>(sql`
    WITH ${GENRE_ALIAS_CTE}
    SELECT DISTINCT ON (e.id) e.id, e.category::text AS category, e.genres, v.id AS venue_id, e.title,
      (SELECT array_agg(lower(le->>'name')) FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup ELSE '[]'::jsonb END) le) AS lineup
    FROM ${source} a
    JOIN occurrences o ON o.starts_at > NOW() AND o.status <> 'cancelled'
    JOIN events e ON e.id = o.event_id AND e.published
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
    WHERE ${ALERT_MATCH}
      AND NOT EXISTS (SELECT 1 FROM attendance x JOIN occurrences xo ON xo.id = x.occurrence_id
                      WHERE x.user_id = ${userId} AND xo.event_id = e.id)
      -- Ook een ja op een uitnodiging is "ik ga".
      AND NOT EXISTS (SELECT 1 FROM invitation_responses ir
                      JOIN invitations i ON i.id = ir.invitation_id AND i.revoked_at IS NULL
                      JOIN occurrences xo ON xo.id = i.occurrence_id
                      WHERE ir.user_id = ${userId} AND ir.status = 'going' AND xo.event_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM saves x JOIN occurrences xo ON xo.id = x.occurrence_id
                      WHERE x.user_id = ${userId} AND xo.event_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM dismisses x JOIN occurrences xo ON xo.id = x.occurrence_id
                      WHERE x.user_id = ${userId} AND xo.event_id = e.id)
    ORDER BY e.id, o.starts_at
    LIMIT 1500
  `);

  // ponytail: grove voorselectie op signalen; de keurder beslist. Als de
  // keurder te vaak iets mist, is dit de plek om ruimer te kiezen.
  // Avonden van artiesten die je al volgt vallen eruit: die hoor je via je
  // artiest-meldingen al, en "meer zoals" hoort iets nieuws te laten zien.
  const followsArtist = (r: (typeof rows.rows)[number]) => {
    const t = r.title.toLowerCase();
    return profile.artistNames.some((n) => (r.lineup ?? []).includes(n) || (n.length >= 4 && t.includes(n)));
  };
  const scored = rows.rows.filter((r) => !followsArtist(r)).map((r) => {
    let score = 0;
    if (profile.venueIds.has(r.venue_id)) score += 3;
    for (const k of genresOf(r.category, r.genres.slice(0, MAIN_LABELS))) score += 2 * (profile.genreWeights.get(k) ?? 0);
    return { id: r.id, score };
  });
  const top = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, JUDGE_TOP);

  const info = await loadEventInfo(top.map((s) => s.id));
  const verdicts = await judgeMany(profile.taste, [...info.values()], profile.examples, 10);
  const recommendations = [...info.values()]
    .filter((e) => verdicts.get(e.id)?.match)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, opts.limit ?? 15)
    .map((e) => ({
      eventId: e.id,
      title: e.title,
      venue: e.venue,
      city: e.city,
      startsAt: e.startsAt.toISOString(),
      reason: honestReason(verdicts.get(e.id)!.reason, profile.artistNames),
    }));

  return {
    recommendations,
    judged: info.size,
    basis:
      `${profile.examples.filter((x) => x.fits).length} keuzes (ik ga/gered), ` +
      `${profile.examples.filter((x) => !x.fits).length} weggeveegd, ${profile.artistNames.length} gevolgde artiesten` +
      (cities.length ? `; in ${cities.join(', ')}` : ''),
  };
}
