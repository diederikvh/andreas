import { expo } from '@better-auth/expo';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, phoneNumber } from 'better-auth/plugins';

import { db, schema } from './db/index.js';
import { sendSms } from './sms/messagebird.js';

if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error('BETTER_AUTH_SECRET is not set');
}

const isDev = process.env.NODE_ENV !== 'production';

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
    ...(isDev
      ? [
          // Expo Go fetched bundle / dev-client
          'exp://',
          'exp://**',
          // Metro / browser dev-server
          'http://localhost',
          'http://localhost:**',
          'http://127.0.0.1',
          'http://127.0.0.1:**',
          // Telefoon hangt aan LAN-IP van je laptop (Expo Go fetch
          // hits API rechtstreeks vanaf het toestel)
          'http://192.168.*.*:**',
          'http://10.*.*.*:**',
        ]
      : []),
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
  plugins: [
    expo(),
    // Mobile draagt sessie via Authorization: Bearer <token> i.p.v.
    // cookies — bearer-plugin laat better-auth dat herkennen.
    bearer(),
    phoneNumber({
      sendOTP: async ({ phoneNumber, code }) => {
        await sendSms({
          to: phoneNumber,
          body: `Andreas: je inlogcode is ${code}. Geldig 5 minuten.`,
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
