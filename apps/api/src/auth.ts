import { expo } from '@better-auth/expo';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, phoneNumber } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';

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

export const auth = betterAuth({
  logger: {
    level: 'debug',
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
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:8787',
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
  },
  // Per-IP rate limit op de OTP-paden om SMS-bombing en Bird-credit-
  // brand te voorkomen. Better-auth's default (100 req / 60s) blijft
  // gelden voor alle andere auth-routes. enabled blijft undefined → aan
  // in productie, uit in dev (better-auth-default).
  //
  // Storage 'memory' is per-Fly-machine; met 1-2 machines is dat ruim
  // genoeg voor abuse-protectie. IP-rotatie tegen één telefoonnummer
  // valt buiten scope — voeg per-phone middleware toe als dat zich
  // voordoet.
  rateLimit: {
    storage: 'memory',
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
  plugins: [
    expo(),
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
  ],
});
