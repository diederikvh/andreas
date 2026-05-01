import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
await sql`TRUNCATE users, account, session, verification CASCADE`;
console.log('users + sessions cleared');
