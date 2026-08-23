import { expo } from '@better-auth/expo';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { anonymous, bearer, mcp, phoneNumber } from 'better-auth/plugins';
import { eq, sql as dsql } from 'drizzle-orm';

import { db, schema } from './db/index.js';
import { sendSms } from './sms/messagebird.js';

if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error('BETTER_AUTH_SECRET is not set');
}

/**
 * Apple App Store-review bypass voor het OTP-pad. Reviewers in Cupertino
 * krijgen onze Bird-SMS niet, dus we accepteren één vast nummer met één
 * vaste code zonder echte Bird-aanroep. Active alleen als beide env-vars
 * gezet zijn — laat ze leeg in dev en je hebt de gewone flow.
 *
 * Setup:
 *   fly secrets set \
 *     APPLE_REVIEW_DEMO_PHONE='+31600000000' \
 *     APPLE_REVIEW_DEMO_CODE='739184' \
 *     -a andreas-api
 *
 * Vul daarna dezelfde combinatie in op:
 *   App Store Connect → App Review → Sign-In Information
 *
 * Het bypass-nummer +31600000000 is bewust een NL-mobile-format dat
 * geen enkele operator uitgeeft (mobile blocks beginnen niet met 00) —
 * geen risico op botsing met een echte user. Code is geen patroon en
 * niet "000000" om brute-force op het demo-nummer uit te sluiten.
 */
const DEMO_PHONE_RAW = process.env.APPLE_REVIEW_DEMO_PHONE ?? null;
const DEMO_CODE = process.env.APPLE_REVIEW_DEMO_CODE ?? null;
const normalizePhone = (s: string) => s.replace(/[\s\-()]/g, '');
const DEMO_PHONE = DEMO_PHONE_RAW ? normalizePhone(DEMO_PHONE_RAW) : null;
const demoActive = Boolean(DEMO_PHONE && DEMO_CODE);

/** Canonieke basis-URL van de API (= auth-host). In prod
    https://api.andreas.amsterdam, lokaal http://localhost:8787. */
const BASE_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:8787';

/**
 * Normaliseer een telefoonnummer naar E.164 zodat élke inlog-route (app,
 * web-MCP-login, …) hetzelfde formaat opslaat — anders maakt better-auth
 * dubbele users aan bij een format-verschil (+31639… vs 31639…). NL-default
 * voor lokale 06-nummers; al-E.164 blijft ongemoeid.
 */
function toE164(raw: string): string {
  const s = raw.replace(/[\s()-]/g, '');
  if (s.startsWith('00')) return '+' + s.slice(2);
  if (s.startsWith('+')) return s;
  if (s.startsWith('0')) return '+31' + s.slice(1);
  return '+' + s;
}

export const auth = betterAuth({
  logger: {
    // In prod alleen errors: better-auth's debug/info-logs bevatten
    // request/verification-context (o.a. telefoonnummers) — niet in de
    // Fly-logs willen. Lokaal volledige verbosity voor debugging.
    level: process.env.NODE_ENV === 'production' ? 'error' : 'debug',
    log: (level, msg, ...rest) => {
      // eslint-disable-next-line no-console
      console.log(`[auth:${level}] ${msg}`, ...rest);
    },
  },
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      oauthApplication: schema.oauthApplication,
      oauthAccessToken: schema.oauthAccessToken,
      oauthConsent: schema.oauthConsent,
      rateLimit: schema.rateLimit,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: BASE_URL,
  trustedOrigins: [
    'andreas://',
    'https://andreas.amsterdam',
    'https://api.andreas.amsterdam',
    // Dev-origins ook in prod toegestaan zodat lokale Expo-builds tegen
    // de prod-API kunnen testen (handig voor demo-account verificatie
    // en algemeen smoke-testen). CSRF is geen risico — Andreas gebruikt
    // bearer-tokens (geen cookies), dus origin-spoofing geeft een
    // aanvaller niets om mee te liften.
    'exp://',
    'exp://**',
    'http://localhost',
    'http://localhost:**',
    'http://127.0.0.1',
    'http://127.0.0.1:**',
    'http://192.168.*.*:**',
    'http://10.*.*.*:**',
  ],
  session: {
    // Mobile-app default: ingelogd blijven tot je uitlogt. Sliding
    // window — elke `updateAge` van activiteit schuift de expiry
    // weer naar +6 maanden.
    expiresIn: 60 * 60 * 24 * 180, // 180 dagen ≈ 6 maanden
    updateAge: 60 * 60 * 24, // 1 dag — sessie wordt dagelijks ververst
  },
  advanced: {
    // Forceer dezelfde 180-dagen Max-Age op de Set-Cookie response
    // zodat de mobile-client (better-auth-expo) het cookie ook 180
    // dagen vasthoudt in SecureStore. Zonder deze override viel een
    // cookie soms terug op de 7-dagen-default, waardoor users na ±een
    // week leek-uitgelogd waren terwijl hun server-side sessie nog
    // lang geldig was.
    defaultCookieAttributes: {
      maxAge: 60 * 60 * 24 * 180,
    },
    // Client-IP uit Fly's vertrouwde `Fly-Client-IP` (door de Fly-edge
    // gezet/overschreven → niet spoofbaar), niet de leftmost X-Forwarded-
    // For (wél client-spoofbaar → rate-limit-bypass). Fallback op XFF voor
    // lokaal/dev.
    ipAddress: {
      ipAddressHeaders: ['fly-client-ip', 'x-forwarded-for'],
    },
  },
  // Per-IP rate limit op de OTP-paden om SMS-bombing en Bird-credit-
  // brand te voorkomen. Better-auth's default (100 req / 60s) blijft
  // gelden voor alle andere auth-routes. enabled blijft undefined → aan
  // in productie, uit in dev (better-auth-default).
  //
  // Storage 'database' (gedeelde rate_limit-tabel) i.p.v. 'memory': zo telt
  // de limiet over álle Fly-machines samen, ook bij autoscale (>1 machine).
  rateLimit: {
    storage: 'database',
    customRules: {
      // Max 3 SMS-verzoeken per 5 min per IP. Een legit user klikt
      // hooguit 2-3x op "verstuur opnieuw"; daarna eerst even wachten.
      '/phone-number/send-otp': { window: 5 * 60, max: 3 },
      // Better-auth telt zelf al max 3 mislukte verify-pogingen per
      // OTP (allowedAttempts). Deze laag dempt automated probing dat
      // telkens nieuwe OTPs triggert.
      '/phone-number/verify': { window: 5 * 60, max: 10 },
    },
  },
  // Server-side normalisatie: herschrijf het telefoonnummer naar E.164 op
  // elke phone-route, vóór de plugin 'm verwerkt. Zo is het formaat altijd
  // consistent — ongeacht welke client/route 'm instuurt.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!ctx.path.includes('phone-number')) return;
      const body = ctx.body as { phoneNumber?: unknown } | undefined;
      if (!body || typeof body.phoneNumber !== 'string') return;
      const normalized = toE164(body.phoneNumber);
      if (normalized === body.phoneNumber) return;
      return { context: { ...ctx, body: { ...body, phoneNumber: normalized } } };
    }),
  },
  plugins: [
    expo(),
    /**
     * Anoniem-eerst. Bij eerste app-start doet de client een
     * `signIn.anonymous()`; dat levert een echte user-rij en sessie op,
     * zodat elk bestaand endpoint ongewijzigd blijft werken — geen
     * tweede soort identiteit door de hele API heen.
     *
     * `onLinkAccount` vuurt zodra zo iemand écht inlogt. Daar verhuizen
     * we z'n spullen naar het echte account. Dat moet expliciet: zonder
     * deze hook gooit de plugin de anonieme user weg en is alles wat je
     * vóór het inloggen bewaarde verdwenen.
     */
    anonymous({
      emailDomainName: 'anon.andreas.amsterdam',
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        const from = anonymousUser.user.id;
        const to = newUser.user.id;
        if (!from || !to || from === to) return;
        await migrateAnonymousData(from, to);
      },
    }),
    // Mobile draagt sessie via Authorization: Bearer <token> i.p.v.
    // cookies — bearer-plugin laat better-auth dat herkennen.
    bearer(),
    phoneNumber({
      sendOTP: async ({ phoneNumber, code }) => {
        // Apple-review bypass: voor het demo-nummer overschrijven we de
        // zojuist door better-auth aangemaakte verification-row met onze
        // vaste code. De reviewer kan dan inloggen zonder echte SMS.
        // Geen Bird-aanroep, geen kosten, geen log-spoor naar Bird.
        if (demoActive && normalizePhone(phoneNumber) === DEMO_PHONE) {
          await db
            .update(schema.verification)
            .set({
              value: `${DEMO_CODE!}:0`,
              updatedAt: new Date(),
            })
            .where(eq(schema.verification.identifier, phoneNumber));
          return;
        }
        // Apple "domain-bound code" format: de tweede regel
        // `@<domain> #<code>` triggert iOS' SMS-autofill direct in
        // het OTP-veld. Domain moet matchen met een associatedDomain
        // in de app (zie app.json: applinks:andreas.amsterdam).
        // Android (SMS Retriever API) gebruikt een ander format —
        // pakken we later op zodra Android-build live is.
        const body = `Andreas: je inlogcode is ${code}. Geldig 5 minuten.\n\n@andreas.amsterdam #${code}`;
        await sendSms({
          to: phoneNumber,
          body,
        });
      },
      otpLength: 6,
      expiresIn: 5 * 60, // seconds
      // Maak een user aan als deze nog niet bestaat — phone-OTP is
      // meteen sign-up én sign-in. Tijdelijk email/name zodat
      // better-auth's user-model gevuld kan worden; user kan later
      // zelf z'n naam/handle invullen.
      signUpOnVerification: {
        getTempEmail: (phoneNumber) =>
          `${phoneNumber.replace(/[^0-9]/g, '')}@phone.andreas.local`,
        getTempName: (phoneNumber) => phoneNumber,
      },
    }),
    // OAuth-provider voor MCP-clients (Claude/ChatGPT/eigen agents). Externe
    // AI's loggen via deze flow in met de telefoon-OTP; de webpagina op
    // `loginPage` doet de OTP en stuurt terug naar /authorize. `resource` is
    // de canonieke MCP-endpoint-URL (RFC 8707 resource indicator).
    mcp({
      loginPage: `${BASE_URL}/mcp-login`,
      resource: `${BASE_URL}/mcp`,
    }),
  ],
});


/**
 * Verhuis alles wat een anonieme gebruiker heeft opgebouwd naar het
 * account waarmee 'ie zojuist inlogde.
 *
 * Twee gevallen, en het tweede is de reden dat dit geen simpele UPDATE
 * is: logt iemand in op een nummer dat al een account heeft (oude
 * telefoon, herinstallatie), dan bestaan beide kanten al. Een blinde
 * UPDATE knalt dan op de primary keys — `(user_id, occurrence_id)` is
 * uniek. Dus: verplaats alleen wat het doel-account nog niet heeft, en
 * gooi de rest weg. Het bestaande account wint, want dat is het oudere
 * en bewustere signaal.
 *
 * `zoek_logs` heeft geen unique constraint per user, dus die kan in één
 * keer over.
 */
async function migrateAnonymousData(from: string, to: string) {
  // Elk paar: tabel + de kolom die samen met user_id de rij uniek maakt.
  const pairs = [
    { table: 'saves', key: 'occurrence_id' },
    { table: 'dismisses', key: 'occurrence_id' },
    { table: 'venue_follows', key: 'venue_id' },
    { table: 'push_tokens', key: 'token' },
  ] as const;

  for (const { table, key } of pairs) {
    await db.execute(dsql`
      UPDATE ${dsql.identifier(table)} AS a
         SET user_id = ${to}
       WHERE a.user_id = ${from}
         AND NOT EXISTS (
           SELECT 1 FROM ${dsql.identifier(table)} AS b
            WHERE b.user_id = ${to}
              AND b.${dsql.identifier(key)} = a.${dsql.identifier(key)}
         )
    `);
    // Wat overblijft is een dubbeling met het bestaande account.
    await db.execute(
      dsql`DELETE FROM ${dsql.identifier(table)} WHERE user_id = ${from}`
    );
  }

  await db.execute(
    dsql`UPDATE zoek_logs SET user_id = ${to} WHERE user_id = ${from}`
  );
}
