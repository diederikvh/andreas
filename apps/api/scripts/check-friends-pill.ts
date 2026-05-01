import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
const u = await sql`SELECT id, handle FROM users`;
console.log('users:'); for (const r of u) console.log(' ', r.handle, r.id);
const f = await sql`SELECT from_user_id, to_user_id, status FROM friendships`;
console.log('friendships:'); for (const r of f) console.log(' ', r.from_user_id, '->', r.to_user_id, r.status);
const s = await sql`SELECT user_id, event_id FROM saves`;
console.log('saves:'); for (const r of s) console.log(' ', r.user_id, 'saved', r.event_id);
