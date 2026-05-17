import * as Sentry from '@sentry/node';

// Init zo vroeg mogelijk in het proces — voor elke andere import die
// HTTP/DB-aanroepen doet — anders mist Sentry de auto-instrumentatie.
// `index.ts` importeert dit als allereerste regel.
//
// Alleen actief in productie (Dockerfile zet NODE_ENV=production op
// Fly). Lokaal blijft 't stil — geen network-calls, geen telemetry.
// DSN-key is publiek (identificeert project, niet auth) → hardcode net
// als de mobile-DSN.
if (process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn: 'https://9f2a442933efba5e8918b8da60e0912c@o4507032745607168.ingest.de.sentry.io/4511404778061904',
    environment: 'production',
    release: process.env.FLY_MACHINE_VERSION ?? undefined,
    tracesSampleRate: 0.05,
    sendDefaultPii: false,
  });
}
