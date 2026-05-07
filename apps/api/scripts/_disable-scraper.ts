/**
 * Generieke kill-switch: wist alle door een specifieke scraper
 * gegenereerde events van een venue + verwijdert de scraper-config zodat
 * de daily cron 'm overslaat. Venue zelf blijft staan.
 *
 *   pnpm tsx --env-file=.env scripts/_disable-scraper.ts <scraper> <slug>[,<slug>...]
 *
 *   pnpm tsx --env-file=.env scripts/_disable-scraper.ts jsonld kriterion,filmhallen,the-movies
 *   pnpm tsx --env-file=.env scripts/_disable-scraper.ts ical de-ateliers
 *
 * Event-id-prefix per scraper:
 *   stager → evt-stg-
 *   ical   → evt-ical-
 *   jsonld → evt-jld-
 */
import { eq, like, and } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';

const PREFIX: Record<string, string> = {
  stager: 'evt-stg-',
  ical: 'evt-ical-',
  jsonld: 'evt-jld-',
};

const [scraperName, slugsArg] = process.argv.slice(2);
if (!scraperName || !slugsArg) {
  console.error(
    'Usage: scripts/_disable-scraper.ts <scraper> <slug>[,<slug>...]'
  );
  process.exit(1);
}
const prefix = PREFIX[scraperName];
if (!prefix) {
  console.error(
    `✗ onbekende scraper '${scraperName}'. Beschikbaar: ${Object.keys(PREFIX).join(', ')}`
  );
  process.exit(1);
}

const slugs = slugsArg.split(',').map((s) => s.trim()).filter(Boolean);
for (const slug of slugs) {
  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.slug, slug))
    .limit(1);
  if (!venue) {
    console.error(`✗ venue ${slug} niet gevonden`);
    continue;
  }
  const deleted = await db
    .delete(schema.events)
    .where(
      and(
        eq(schema.events.venueId, venue.id),
        like(schema.events.id, `${prefix}%`)
      )
    )
    .returning({ id: schema.events.id });

  const cfg = (venue.scraperConfig ?? {}) as Record<string, unknown>;
  const { [scraperName]: _omit, ...rest } = cfg;
  await db
    .update(schema.venues)
    .set({
      scraperConfig: Object.keys(rest).length > 0 ? rest : null,
    })
    .where(eq(schema.venues.id, venue.id));

  console.log(
    `✓ ${venue.name.padEnd(20)} ${deleted.length.toString().padStart(3)} events weg, scraperConfig.${scraperName} uit`
  );
}
process.exit(0);
