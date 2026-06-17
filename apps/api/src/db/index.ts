import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';

import * as schema from './schema.js';

/**
 * De genre-labels die publieke endpoints tonen: `effective_genres` (eigen
 * genres + doorgedruppelde line-up-artiest-genres) met fallback naar de eigen
 * `genres` voor events die nog niet herberekend zijn (vers gescrapet, vóór de
 * nachtelijke recompute). Gebruik als projectie i.p.v. `schema.events.genres`
 * zodat app + SEO de verrijkte labels krijgen zonder client-wijziging.
 */
export const displayGenres = sql<
  string[]
>`COALESCE(NULLIF(${schema.events.effectiveGenres}, ARRAY[]::text[]), ${schema.events.genres})`;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

// Node heeft geen ingebouwde WebSocket — neon-serverless gebruikt de
// `ws` polyfill. neon-http ondersteunt geen transacties, en
// better-auth gebruikt die voor user-updates.
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle({ client: pool, schema, casing: 'snake_case' });

export { schema };
