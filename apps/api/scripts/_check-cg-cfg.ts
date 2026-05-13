import { db, schema } from '../src/db/index.js';
import { eq } from 'drizzle-orm';

const [v] = await db.select().from(schema.venues).where(eq(schema.venues.id, 'het-concertgebouw'));
console.log(JSON.stringify(v?.scraperConfig?.theater, null, 2));
process.exit(0);
