import { eq, and, isNotNull, not, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';
import { uploadToBunny } from '../src/storage/bunny.js';

const UA = 'Mozilla/5.0 (Andreas/1.0)';

/** ITA's CDN ImageMagick geeft "cache resources exhausted" voor
 * originele files, maar werkt prima met een `?w=1200` transform-trigger. */
function withTransform(url: string): string {
  if (url.includes('?')) return url;
  return `${url}?w=1200`;
}

const dbRows = await db
  .select({ id: schema.events.id, title: schema.events.title, imageUrl: schema.events.imageUrl })
  .from(schema.events)
  .where(
    and(
      eq(schema.events.venueId, 'ita'),
      isNotNull(schema.events.imageUrl),
      not(like(schema.events.imageUrl, 'https://andreas-x.b-cdn.net/%'))
    )
  );

console.log(`${dbRows.length} ITA events met remote URL`);

let ok = 0, fail = 0;
for (const ev of dbRows) {
  const url = withTransform(ev.imageUrl!);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*' } });
    if (!r.ok) { console.log(`  ${ev.title.slice(0, 40)}: HTTP ${r.status}`); fail++; continue; }
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) { console.log(`  ${ev.title.slice(0, 40)}: not image (${mime})`); fail++; continue; }
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024) { console.log(`  ${ev.title.slice(0, 40)}: too small`); fail++; continue; }
    if (buf.byteLength > 16 * 1024 * 1024) { console.log(`  ${ev.title.slice(0, 40)}: too large`); fail++; continue; }
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const slug = ev.id.replace(/^evt-ita-/, '').slice(0, 60);
    const cdnUrl = await uploadToBunny(`media/events/ita-${slug}.${ext}`, buf, mime);
    await db.update(schema.events).set({ imageUrl: cdnUrl }).where(eq(schema.events.id, ev.id));
    console.log(`  ${ev.title.slice(0, 40)} ✓ ${cdnUrl.slice(40)} (${(buf.byteLength / 1024).toFixed(0)}kB)`);
    ok++;
  } catch (e) {
    console.log(`  ${ev.title.slice(0, 40)}: err ${(e as Error).message}`);
    fail++;
  }
}
console.log(`\nResult: ${ok} mirrored, ${fail} failed`);
process.exit(0);
