import { eq, and, isNotNull, not, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';
import { uploadToBunny } from '../src/storage/bunny.js';

/**
 * Backfill: vind alle events met remote (niet-Bunny) imageUrl,
 * download het plaatje en upload naar Bunny CDN. Update event.imageUrl
 * naar de nieuwe Bunny URL. Skip URLs die geen image-extensie hebben
 * of die op een page-URL lijken (bv. `https://brakkegrond.nl/` zonder
 * pad — dat is een scrape-bug die we los moeten fixen).
 */
const UA = 'Mozilla/5.0 (Andreas/1.0; +https://andreas.amsterdam)';
const MAX_BYTES = 16 * 1024 * 1024; // 16MB — ITA serveert soms grote tiff-conversies

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function tryFetch(sourceUrl: string): Promise<{ buf: ArrayBuffer; mime: string } | null> {
  const referer = new URL(sourceUrl).origin + '/';
  const r = await fetch(sourceUrl, {
    headers: { 'user-agent': UA, accept: 'image/*,*/*;q=0.8', referer },
  });
  if (!r.ok) return null;
  const mime = r.headers.get('content-type') ?? 'image/jpeg';
  if (!mime.startsWith('image/')) return null;
  const buf = await r.arrayBuffer();
  if (buf.byteLength < 1024) return null;
  if (buf.byteLength > MAX_BYTES) return null;
  return { buf, mime };
}

async function fetchAndMirror(
  rawUrl: string,
  prefix: string,
  slug: string
): Promise<string | null> {
  const sourceUrl = decodeHtmlEntities(rawUrl);
  // Try once, retry once after 2s if it failed (ITA cache-exhausted is transient)
  let result = await tryFetch(sourceUrl).catch(() => null);
  if (!result) {
    await new Promise((r) => setTimeout(r, 2000));
    result = await tryFetch(sourceUrl).catch(() => null);
  }
  if (!result) {
    console.warn(`    failed (after retry): ${sourceUrl.slice(0, 80)}`);
    return null;
  }
  const { buf, mime } = result;
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
  try {
    return await uploadToBunny(`media/events/${prefix}-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`    upload err: ${(e as Error).message}`);
    return null;
  }
}

const rows = await db
  .select({
    id: schema.events.id,
    venueId: schema.events.venueId,
    title: schema.events.title,
    imageUrl: schema.events.imageUrl,
  })
  .from(schema.events)
  .where(
    and(
      isNotNull(schema.events.imageUrl),
      not(like(schema.events.imageUrl, 'https://andreas-x.b-cdn.net/%'))
    )
  );

console.log(`${rows.length} events met remote imageUrl te migreren...\n`);

let mirrored = 0;
let skipped = 0;
let failed = 0;

for (const ev of rows) {
  const url = ev.imageUrl!;
  // Sanity: must look like an image URL (not just a domain)
  if (!/\.(?:jpe?g|png|webp|gif|avif)(?:\?|$)/i.test(url) && !/\/(?:img|image|media|uploads?|content|assets)\//i.test(url)) {
    console.log(`  ${ev.id} SKIP (geen image-URL): ${url.slice(0, 80)}`);
    skipped++;
    // Clear de URL want hij is niet bruikbaar
    await db.update(schema.events).set({ imageUrl: null }).where(eq(schema.events.id, ev.id));
    continue;
  }

  // Prefix per venue voor consistente Bunny-paden
  const prefix = ev.id.startsWith('evt-th-')
    ? 'th'
    : ev.id.startsWith('evt-pm-')
    ? 'pm'
    : ev.id.startsWith('evt-ita-')
    ? 'ita'
    : ev.id.startsWith('evt-bg-')
    ? 'bg'
    : 'misc';
  const slug = ev.id.replace(/^evt-[a-z]+-/, '').slice(0, 60);
  const cdnUrl = await fetchAndMirror(url, prefix, slug);
  if (cdnUrl) {
    await db.update(schema.events).set({ imageUrl: cdnUrl }).where(eq(schema.events.id, ev.id));
    console.log(`  ${ev.title.slice(0, 40).padEnd(42)} ✓ ${cdnUrl.slice(40, 100)}`);
    mirrored++;
  } else {
    console.log(`  ${ev.title.slice(0, 40).padEnd(42)} ✗ ${url.slice(0, 60)}`);
    failed++;
  }
}

console.log(`\nResult: ${mirrored} mirrored, ${skipped} cleared (invalid URL), ${failed} failed`);
process.exit(0);
