import { eq, and, isNotNull, not, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';
import { uploadToBunny } from '../src/storage/bunny.js';

const UA = 'Mozilla/5.0 (Andreas/1.0)';
const ALL = 'https://www.podiummozaiek.nl/data/events/all.json';

type ApiEvent = { id: string; name?: string; custom_images?: string | null };

// Fetch fresh all.json
const r = await fetch(ALL, { headers: { 'user-agent': UA, accept: 'application/json' } });
const events = (await r.json()) as ApiEvent[];

// Build title → image map. PM's `custom_images` veld bevat CDN-URLs
// (saits.online) die soms 404 geven; de werkende URL gebruikt het
// eigen domein voor dezelfde filename.
function normalizeImage(raw: string): string {
  let img = raw;
  if (img.startsWith('/')) return `https://www.podiummozaiek.nl${img}`;
  // Replace saits.online CDN met eigen domein (zelfde path)
  return img.replace(/^https:\/\/static-podiummozaiek-nl\.saits\.online/, 'https://www.podiummozaiek.nl');
}

const byTitle = new Map<string, string>();
for (const e of events) {
  if (!e.name || !e.custom_images) continue;
  byTitle.set(e.name.toLowerCase(), normalizeImage(e.custom_images));
}

const dbRows = await db
  .select({ id: schema.events.id, title: schema.events.title, imageUrl: schema.events.imageUrl })
  .from(schema.events)
  .where(
    and(
      eq(schema.events.venueId, 'podium-mozaiek'),
      isNotNull(schema.events.imageUrl),
      not(like(schema.events.imageUrl, 'https://andreas-x.b-cdn.net/%'))
    )
  );

console.log(`${dbRows.length} PM events met stale remote URL`);

let ok = 0, fail = 0;
for (const ev of dbRows) {
  const fresh = byTitle.get(ev.title.toLowerCase());
  if (!fresh) {
    console.log(`  ${ev.title.slice(0, 40)}: no match in all.json`);
    fail++;
    continue;
  }
  try {
    const r = await fetch(fresh, { headers: { 'user-agent': UA, referer: 'https://www.podiummozaiek.nl/' } });
    if (!r.ok) { console.log(`  ${ev.title.slice(0, 40)}: HTTP ${r.status}`); fail++; continue; }
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) { console.log(`  ${ev.title.slice(0, 40)}: not image (${mime})`); fail++; continue; }
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) { console.log(`  ${ev.title.slice(0, 40)}: bad size ${buf.byteLength}`); fail++; continue; }
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const slug = ev.id.replace(/^evt-pm-/, '').slice(0, 60);
    const cdnUrl = await uploadToBunny(`media/events/pm-${slug}.${ext}`, buf, mime);
    await db.update(schema.events).set({ imageUrl: cdnUrl }).where(eq(schema.events.id, ev.id));
    console.log(`  ${ev.title.slice(0, 40)} ✓ ${cdnUrl.slice(40)}`);
    ok++;
  } catch (e) {
    console.log(`  ${ev.title.slice(0, 40)}: err ${(e as Error).message}`);
    fail++;
  }
}
console.log(`\nResult: ${ok} mirrored, ${fail} failed`);
process.exit(0);
