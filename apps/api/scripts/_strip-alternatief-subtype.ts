/**
 * Eenmalige cleanup: verwijder 'alternatief' uit alle venue.subtype
 * arrays. Die informatie wordt nu door het `scene`-veld gedragen.
 *
 *   pnpm tsx --env-file=.env scripts/_strip-alternatief-subtype.ts
 */

const BASE = process.env.ADMIN_BASE_URL ?? 'http://localhost:8787';
const KEY = process.env.ADMIN_API_KEY!;

const res = await fetch(`${BASE}/admin/api/venues`, {
  headers: { Authorization: `Bearer ${KEY}` },
});
const { venues } = (await res.json()) as {
  venues: Array<{ id: string; name: string; subtype: string[] }>;
};

let n = 0;
for (const v of venues) {
  const cleaned = v.subtype.filter((s) => s.toLowerCase() !== 'alternatief');
  if (cleaned.length === v.subtype.length) continue;
  const r = await fetch(`${BASE}/admin/api/venues/${encodeURIComponent(v.id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ subtype: cleaned }),
  });
  if (r.ok) {
    n++;
    console.log(`✓ ${v.id} — was [${v.subtype.join(', ')}], nu [${cleaned.join(', ')}]`);
  }
}
console.log(`\nCleaned ${n} venues.`);
process.exit(0);
