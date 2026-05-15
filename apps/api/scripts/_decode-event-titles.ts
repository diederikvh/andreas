/**
 * Eenmalig: alle event-titles in de DB met HTML-entities decoden.
 * Pakt zowel decimal (`&#8211;`), hex (`&#xE9;`) als named (`&amp;`,
 * `&quot;`, etc) entities. Print per-event de oude → nieuwe title.
 *
 * Gebruik:
 *   tsx --env-file=.env apps/api/scripts/_decode-event-titles.ts
 */

import { eq, like, or } from 'drizzle-orm';

import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) =>
      String.fromCodePoint(parseInt(c, 16))
    )
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

const rows = await db
  .select({ id: schema.events.id, title: schema.events.title })
  .from(schema.events)
  .where(
    or(
      like(schema.events.title, '%&amp;%'),
      like(schema.events.title, '%&#%'),
      like(schema.events.title, '%&quot;%'),
      like(schema.events.title, '%&apos;%'),
      like(schema.events.title, '%&lt;%'),
      like(schema.events.title, '%&gt;%'),
      like(schema.events.title, '%&nbsp;%')
    )
  );

console.log(`[decode-titles] ${rows.length} kandidaten`);
let updated = 0;
for (const row of rows) {
  const decoded = decodeEntities(row.title);
  if (decoded === row.title) continue;
  console.log(`  ${row.id}`);
  console.log(`    oud: ${row.title}`);
  console.log(`    nieuw: ${decoded}`);
  await db
    .update(schema.events)
    .set({ title: decoded })
    .where(eq(schema.events.id, row.id));
  updated++;
}
console.log(`[decode-titles] ${updated} events bijgewerkt`);
process.exit(0);
