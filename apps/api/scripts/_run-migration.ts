/** Voert één migratiebestand uit via de drizzle-verbinding. Nodig omdat
    psql hier niet geïnstalleerd is; `db:push` doet een schema-diff over
    de hele database en dat is voor een losse migratie te grof. */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';

const pad = process.argv[2];
if (!pad) { console.error('gebruik: _run-migration.ts <pad>'); process.exit(1); }
const inhoud = readFileSync(pad, 'utf8');
// Commentaarregels eruit, dan splitsen op ';' aan het regeleinde.
const statements = inhoud
  .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);

for (const [i, st] of statements.entries()) {
  const kop = st.replace(/\s+/g, ' ').slice(0, 80);
  try {
    await db.execute(sql.raw(st));
    console.log(`  ${i + 1}/${statements.length} ok    ${kop}`);
  } catch (e) {
    const m = (e as Error).message;
    if (/already exists|bestaat al/i.test(m)) console.log(`  ${i + 1}/${statements.length} staat al  ${kop}`);
    else { console.error(`  ${i + 1}/${statements.length} FOUT  ${kop}\n     ${m}`); process.exit(1); }
  }
}
console.log('klaar');
process.exit(0);
