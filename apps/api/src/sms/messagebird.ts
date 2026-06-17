/**
 * SMS sender via Bird (voorheen MessageBird) Channels API.
 * Endpoint: POST /workspaces/<ws>/channels/<ch>/messages
 *
 * Env vars:
 *   - MESSAGEBIRD_ACCESS_KEY  (heet historisch zo; werkt op Bird)
 *   - BIRD_WORKSPACE_ID
 *   - BIRD_CHANNEL_ID
 *
 * Als één van die drie ontbreekt loggen we de OTP naar de server-
 * console en sturen we niets — handig voor lokaal én TestFlight-beta
 * zonder credit te verbranden.
 */

const ENDPOINT_BASE = 'https://api.bird.com';

export async function sendSms(opts: { to: string; body: string }) {
  const key = process.env.MESSAGEBIRD_ACCESS_KEY;
  const workspaceId = process.env.BIRD_WORKSPACE_ID;
  const channelId = process.env.BIRD_CHANNEL_ID;

  // In dev/test draaien we Bird niet — log de OTP gewoon naar de
  // server-console. Voorkomt dat lokaal testen credit verbrandt of
  // echte SMS'jes naar je telefoon stuurt. Productie (NODE_ENV=
  // production, gezet in Dockerfile) gebruikt Bird wel.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[sms:dev] → ${opts.to}: ${opts.body}`);
    return;
  }

  if (!key || !workspaceId || !channelId) {
    console.warn(
      `[sms:fallback] ontbrekende Bird-config (key=${!!key} ws=${!!workspaceId} ch=${!!channelId}) → SMS niet verstuurd naar ${opts.to}`
    );
    return;
  }

  const url = `${ENDPOINT_BASE}/workspaces/${workspaceId}/channels/${channelId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `AccessKey ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      receiver: {
        contacts: [{ identifierValue: opts.to }],
      },
      body: {
        type: 'text',
        text: { text: opts.body },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bird send failed: ${res.status} ${text}`);
  }
}
