import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

type Cfg = {
  id: string;
  sitemapUrl: string;
  showUrlPattern: string;
  useGooglebotUA?: boolean;
  useDataDateAttrs?: boolean;
};

const configs: Cfg[] = [
  {
    id: 'carre',
    sitemapUrl: 'https://carre.nl/sitemap.xml',
    showUrlPattern: '^https://carre\\.nl/voorstelling/[a-z0-9-]+$',
    useGooglebotUA: true,
  },
  {
    id: 'meervaart',
    sitemapUrl: 'https://meervaart.nl/sitemap.xml',
    showUrlPattern: '^https://meervaart\\.nl/agenda/[a-z0-9-]+$',
    useGooglebotUA: false,
  },
  {
    id: 'delamar',
    sitemapUrl: 'https://delamar.nl/sitemap.xml',
    showUrlPattern: '^https://delamar\\.nl/voorstellingen/[a-z0-9-]+/?$',
    useGooglebotUA: true,
    useDataDateAttrs: true,
  },
];

for (const c of configs) {
  const [existing] = await db
    .select({ scraperConfig: schema.venues.scraperConfig })
    .from(schema.venues)
    .where(eq(schema.venues.id, c.id));
  if (!existing) {
    console.log(`  ! ${c.id} ontbreekt`);
    continue;
  }
  const next = {
    ...(existing.scraperConfig ?? {}),
    theater: {
      sitemapUrl: c.sitemapUrl,
      showUrlPattern: c.showUrlPattern,
      ...(c.useGooglebotUA ? { useGooglebotUA: true } : {}),
      ...(c.useDataDateAttrs ? { useDataDateAttrs: true } : {}),
    },
  };
  await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, c.id));
  console.log(`  + ${c.id} → theater config gezet`);
}
process.exit(0);
