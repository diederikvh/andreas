import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
const sessions = await sql`
  SELECT s.token, s.expires_at, u.handle, u.name, u.phone_number, u.id
  FROM session s JOIN users u ON u.id = s.user_id
  ORDER BY s.created_at DESC
`;
console.log('active sessions:');
for (const r of sessions) {
  console.log('  user:', r.handle, '|', r.name, '|', r.phone_number, '|', r.id, '| token:', r.token.slice(0, 12) + '...');
}
