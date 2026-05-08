import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';
import { uploadToBunny } from '../src/storage/bunny.js';

const UA = 'Mozilla/5.0 (compatible; Andreas/1.0)';

const venues: Array<{ id: string; sourceUrl: string }> = [
  {
    id: 'johan-cruijff-arena',
    sourceUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/Arena%2C_Ajax_stadion%2C_Amsterdam.JPG/3840px-Arena%2C_Ajax_stadion%2C_Amsterdam.JPG',
  },
  {
    id: 'boom-chicago',
    sourceUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/a0/Rozentheater.JPG',
  },
  {
    id: 'rai-theater',
    sourceUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Europaplein%2C_RAI%2C_Amsterdam_pic7.jpg/3840px-Europaplein%2C_RAI%2C_Amsterdam_pic7.jpg',
  },
];

for (const v of venues) {
  const r = await fetch(v.sourceUrl, { headers: { 'user-agent': UA } });
  if (!r.ok) {
    console.error(`  ! ${v.id}: HTTP ${r.status}`);
    continue;
  }
  const mime = r.headers.get('content-type') ?? 'image/jpeg';
  const buf = await r.arrayBuffer();
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const stamp = Date.now();
  const path = `media/venues/${stamp}-${v.id}.${ext}`;
  const cdnUrl = await uploadToBunny(path, buf, mime);
  await db.update(schema.venues).set({ imageUrl: cdnUrl }).where(eq(schema.venues.id, v.id));
  console.log(`  + ${v.id} → ${cdnUrl} (${(buf.byteLength / 1024).toFixed(0)}kB)`);
}
process.exit(0);
