/**
 * Wissel een short-lived IG access token (~1u) om naar een long-lived
 * token (~60d). Gebruik:
 *
 *   pnpm tsx --env-file=.env src/scripts/swap-ig-token.ts <APP_SECRET>
 *
 * Het script leest IG_ACCESS_TOKEN uit je .env, doet de exchange, en
 * print het nieuwe long-lived token. Zet daarna die waarde in .env en
 * herstart `pnpm dev`.
 */

export {};

async function main() {
  const appSecret = process.argv[2];
  if (!appSecret) {
    console.error(
      'Usage: pnpm tsx --env-file=.env src/scripts/swap-ig-token.ts <APP_SECRET>'
    );
    console.error(
      'App Secret vind je in Meta Developer Dashboard → API setup with Instagram login → "Instagram app secret" (Show)'
    );
    process.exit(1);
  }

  const shortToken = process.env.IG_ACCESS_TOKEN;
  if (!shortToken) {
    console.error('IG_ACCESS_TOKEN ontbreekt in .env — zet eerst je short-lived token daarin.');
    process.exit(1);
  }

  const url = new URL('https://graph.instagram.com/access_token');
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('access_token', shortToken);

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
  console.log('✓ Long-lived token verkregen');
  console.log(`  Geldig: ${json.expires_in}s (~${days} dagen)`);
  console.log('');
  console.log('Zet dit in apps/api/.env:');
  console.log('');
  console.log(`IG_ACCESS_TOKEN=${json.access_token}`);
  console.log('');
  console.log('Daarna: herstart `pnpm dev`.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
