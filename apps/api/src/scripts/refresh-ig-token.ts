/**
 * Verlengt een long-lived IG-token met nog eens ~60 dagen.
 * Gebruik 1x per ~50 dagen om te voorkomen dat 't token vervalt.
 *
 *   pnpm tsx --env-file=.env src/scripts/refresh-ig-token.ts
 *
 * Het script leest IG_ACCESS_TOKEN uit je .env (of uit een Fly secret
 * als je 'm via SSH draait), doet de refresh, en print het nieuwe
 * token. Daarna:
 *
 *   1. Vervang IG_ACCESS_TOKEN lokaal in .env voor dev
 *   2. fly secrets set -a andreas-api IG_ACCESS_TOKEN="<nieuw>"
 *
 * Meta's refresh-endpoint vereist géén App Secret — alleen de
 * bestaande long-lived token. Wel moet 't token >24u oud zijn, anders
 * weigert Meta 'm te verversen.
 */

export {};

async function main() {
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) {
    console.error('IG_ACCESS_TOKEN ontbreekt in env');
    process.exit(1);
  }

  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);

  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) {
    console.error(`Meta API ${res.status}: ${text}`);
    process.exit(1);
  }

  const json = JSON.parse(text) as {
    access_token: string;
    token_type: string;
    expires_in: number;
  };

  const days = Math.round(json.expires_in / 86400);
  console.log('');
  console.log(`✓ Token verlengd met ${days} dagen`);
  console.log('');
  console.log('Lokaal (apps/api/.env):');
  console.log(`  IG_ACCESS_TOKEN=${json.access_token}`);
  console.log('');
  console.log('Fly:');
  console.log(`  fly secrets set -a andreas-api IG_ACCESS_TOKEN="${json.access_token}"`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
