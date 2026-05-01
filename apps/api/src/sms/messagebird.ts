/**
 * Minimal MessageBird (Bird) SMS sender for the OTP flow.
 * Uses their REST API directly — no SDK dependency.
 */

const ENDPOINT = 'https://rest.messagebird.com/messages';

export async function sendSms(opts: { to: string; body: string }) {
  const key = process.env.MESSAGEBIRD_ACCESS_KEY;
  const originator = process.env.MESSAGEBIRD_ORIGINATOR ?? 'Andreas';

  if (!key) {
    if (process.env.NODE_ENV !== 'production') {
      // Development fallback: log to console so the OTP flow is testable
      // without burning SMS credit.
      console.log(`[sms:dev] → ${opts.to}: ${opts.body}`);
      return;
    }
    throw new Error('MESSAGEBIRD_ACCESS_KEY is not set');
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `AccessKey ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      originator,
      recipients: [opts.to],
      body: opts.body,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MessageBird send failed: ${res.status} ${text}`);
  }
}
