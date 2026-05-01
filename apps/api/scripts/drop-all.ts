import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

await sql`DROP TABLE IF EXISTS saves CASCADE`;
await sql`DROP TABLE IF EXISTS venue_follows CASCADE`;
await sql`DROP TABLE IF EXISTS friendships CASCADE`;
await sql`DROP TABLE IF EXISTS session CASCADE`;
await sql`DROP TABLE IF EXISTS account CASCADE`;
await sql`DROP TABLE IF EXISTS verification CASCADE`;
await sql`DROP TABLE IF EXISTS users CASCADE`;
await sql`DROP TABLE IF EXISTS events CASCADE`;
await sql`DROP TABLE IF EXISTS venues CASCADE`;
await sql`DROP TABLE IF EXISTS __drizzle_migrations CASCADE`;
await sql`DROP TYPE IF EXISTS mode_pref CASCADE`;
await sql`DROP TYPE IF EXISTS event_category CASCADE`;
await sql`DROP TYPE IF EXISTS friendship_status CASCADE`;
console.log('all dropped');
