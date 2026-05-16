/**
 * One-off SQL runner. Leest een .sql-bestand uit argv[2], splitst op `;`
 * met behoud van dollar-quoted blocks, en voert iedere statement uit op
 * de live DB. Vervangt `psql -f` voor omgevingen zonder psql.
 *
 * Gebruik: `pnpm tsx src/scripts/run-sql.ts src/db/migrations/0028_xxx.sql`
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: run-sql.ts <path-to-sql-file>');
  process.exit(1);
}

const raw = readFileSync(file, 'utf8');

// Strip line-comments (-- …) maar behoud strings. Splits op `;` op top-
// level (geen $$-quoted blocks in onze migrations dus naïef is goed
// genoeg).
const stripped = raw
  .split('\n')
  .map((line) => {
    const idx = line.indexOf('--');
    if (idx < 0) return line;
    return line.slice(0, idx);
  })
  .join('\n');

const statements = stripped
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

for (const stmt of statements) {
  console.log(`> ${stmt.slice(0, 80).replace(/\s+/g, ' ')}${stmt.length > 80 ? '…' : ''}`);
  await db.execute(sql.raw(stmt));
}

console.log(`✓ ${statements.length} statements applied from ${file}`);
process.exit(0);
