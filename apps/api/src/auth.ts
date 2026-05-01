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
    ...(isDev ? ['exp://', 'exp://**', 'exp://192.168.*.*:*/**'] : []),
  ],
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
