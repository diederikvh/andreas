/**
 * MCP-endpoint (Streamable HTTP, stateless) op `POST /mcp`. Externe AI-clients
 * koppelen hier hun eigen model aan ons event-aanbod.
 *
 * Stateless: per request een verse server + transport (geen sessies). De
 * transport schrijft direct naar de Node-response; via @hono/node-server
 * pakken we de rauwe `incoming`/`outgoing` van `c.env` en geven die door.
 *
 * Auth: `Authorization: Bearer <MCP_API_KEY>`. Is de secret niet gezet, dan is
 * het endpoint in productie uit (503) en lokaal open (dev).
 */
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { auth } from '../auth.js';
import { buildMcpServer } from '../mcp/server.js';

export const mcpRoute = new Hono();

const BASE_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:8787';

// MCP JSON-RPC-bodies zijn klein; cap tegen geheugen-/parse-DoS.
mcpRoute.use('*', bodyLimit({ maxSize: 64 * 1024 }));

// Per-user rate-limit (sliding window). Voorkomt dat één OAuth-user de tool
// onbeperkt hamert (DB-resource-exhaustion / dataset-scraping / uitputten van
// de gedeelde zoek_logs-cap). In-memory per Fly-machine — een eerste laag;
// een gedeelde store (Redis) volgt als we autoscalen. Service-key (server-to-
// server) is vertrouwd en wordt niet gelimiteerd.
const RL_WINDOW_MS = 60_000;
const RL_MAX_PER_WINDOW = Number(process.env.MCP_RATE_PER_MIN ?? 30);
const rlHits = new Map<string, number[]>();
function mcpRateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (rlHits.get(userId) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  if (recent.length >= RL_MAX_PER_WINDOW) {
    rlHits.set(userId, recent);
    return true;
  }
  recent.push(now);
  rlHits.set(userId, recent);
  // Opportunistisch prunen zodat de Map niet onbeperkt groeit.
  if (rlHits.size > 5000) {
    for (const [k, v] of rlHits) {
      if (v.every((t) => now - t >= RL_WINDOW_MS)) rlHits.delete(k);
    }
  }
  return false;
}

/** Valideer de OAuth-access-token (better-auth mcp-plugin) → userId of null. */
async function oauthUserId(headers: Headers): Promise<string | null> {
  try {
    const session = await auth.api.getMcpSession({ headers });
    return session?.userId ?? null;
  } catch {
    return null;
  }
}

mcpRoute.all('/', async (c) => {
  // Twee toegangspaden:
  //  1. OAuth (eindgebruiker logde in met telefoon-OTP) → userId.
  //  2. Service-key (server-to-server / testen) via MCP_API_KEY.
  const serviceKey = process.env.MCP_API_KEY;
  const authz = c.req.header('authorization');
  const viaServiceKey = Boolean(serviceKey && authz === `Bearer ${serviceKey}`);
  const userId = viaServiceKey ? null : await oauthUserId(c.req.raw.headers);

  if (!viaServiceKey && !userId) {
    // MCP/OAuth-discovery: wijs de client naar de protected-resource-metadata
    // zodat 'ie de login-flow kan starten.
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`
    );
    return c.json({ error: 'unauthorized' }, 401);
  }

  if (userId && mcpRateLimited(userId)) {
    c.header('Retry-After', '60');
    return c.json({ error: 'rate_limited' }, 429);
  }

  const { incoming, outgoing } = c.env as unknown as {
    incoming: IncomingMessage;
    outgoing: ServerResponse;
  };

  // Body vooraf parsen: @hono/node-server heeft de Node-stream al verbruikt
  // voor de Web Request, dus we geven 'm als parsedBody mee (transport leest
  // dan niet opnieuw van de stream).
  let body: unknown;
  if (c.req.method === 'POST') {
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
  }

  const server = buildMcpServer(userId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  await transport.handleRequest(incoming, outgoing, body);
  return RESPONSE_ALREADY_SENT;
});
