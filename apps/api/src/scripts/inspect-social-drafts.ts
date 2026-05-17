/**
 * Quick-and-dirty inspectie van de laatste social_posts: caption +
 * welke venues + hun IG-handles. Voor debuggen of de @-mention feature
 * werkt zoals bedoeld.
 */

export {};

import { desc, eq, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

async function main() {
  const posts = await db
    .select()
    .from(schema.socialPosts)
    .orderBy(desc(schema.socialPosts.createdAt))
    .limit(5);

  for (const post of posts) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`POST ${post.id}  slot=${post.slot}  status=${post.status}`);
    console.log(`Created: ${post.createdAt.toISOString()}`);
    console.log('\nCaption:');
    console.log(post.caption ?? '(geen caption)');
    console.log('\nEvents → Venues:');

    if (post.eventIds.length > 0) {
      const rows = await db
        .select({
          eventId: schema.events.id,
          title: schema.events.title,
          venueId: schema.venues.id,
          venueName: schema.venues.name,
          venueInstagram: schema.venues.instagram,
        })
        .from(schema.events)
        .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
        .where(inArray(schema.events.id, post.eventIds));

      for (const r of rows) {
        const handle = r.venueInstagram ? `@${r.venueInstagram}` : '(geen handle)';
        console.log(`  ${r.title} — ${r.venueName} ${handle}`);
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
