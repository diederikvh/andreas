import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
const f = await sql`
  SELECT 
    fu.handle as from_handle, fu.name as from_name,
    tu.handle as to_handle, tu.name as to_name,
    f.status, f.created_at
  FROM friendships f
  JOIN users fu ON fu.id = f.from_user_id
  JOIN users tu ON tu.id = f.to_user_id
`;
console.log('friendships:');
for (const r of f) console.log(' ', r.from_handle, '->', r.to_handle, '|', r.status);
const u = await sql`SELECT handle, name FROM users`;
console.log('users:');
for (const r of u) console.log(' ', r.handle, '|', r.name);
