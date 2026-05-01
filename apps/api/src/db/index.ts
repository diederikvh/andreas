import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';

import * as schema from './schema.js';

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
