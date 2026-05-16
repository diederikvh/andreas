/**
 * IG Graph API publisher voor carousel-posts. Gebruikt de Instagram
 * Business Login flow (graph.instagram.com), niet de oudere Facebook
 * Page flow (graph.facebook.com). Drie HTTP-calls per carousel:
 *
 *   1. Per slide: POST /{ig-user-id}/media met image_url + is_carousel_item=true
 *      → returnt een child-container-ID
 *   2. POST /{ig-user-id}/media met media_type=CAROUSEL + children + caption
 *      → returnt een master container-ID
 *   3. POST /{ig-user-id}/media_publish met creation_id
 *      → returnt het definitieve IG-media-ID dat we opslaan
 *
 * Container-creatie is async aan Meta-kant: tussen stap 2 en 3 moet de
 * status van de master container op `FINISHED` staan voordat publish
 * werkt. We pollen kort op `status_code`.
 */

const GRAPH = 'https://graph.instagram.com';
const VERSION = 'v23.0';

function requireEnv(): { token: string; userId: string } {
  const token = process.env.IG_ACCESS_TOKEN;
  const userId = process.env.IG_USER_ID;
  if (!token || !userId) {
    throw new Error(
      'IG_ACCESS_TOKEN en/of IG_USER_ID ontbreken in env — kan niet publiceren',
    );
  }
  return { token, userId };
}

interface GraphError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

async function postGraph(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<Record<string, unknown>> {
  const url = `${GRAPH}/${VERSION}/${path}`;
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let json: Record<string, unknown> & GraphError;
  try {
    json = JSON.parse(text) as Record<string, unknown> & GraphError;
  } catch {
    throw new Error(`IG API gaf non-JSON terug (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.error) {
    const e = json.error;
    throw new Error(
      `IG API ${res.status}: ${e?.message ?? 'onbekende fout'}` +
        (e?.code ? ` [code=${e.code}]` : '') +
        (e?.error_subcode ? ` [subcode=${e.error_subcode}]` : ''),
    );
  }
  return json;
}

async function getGraph(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const url = `${GRAPH}/${VERSION}/${path}?${qs.toString()}`;
  const res = await fetch(url);
  const text = await res.text();
  let json: Record<string, unknown> & GraphError;
  try {
    json = JSON.parse(text) as Record<string, unknown> & GraphError;
  } catch {
    throw new Error(`IG API gaf non-JSON terug (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.error) {
    const e = json.error;
    throw new Error(`IG API ${res.status}: ${e?.message ?? 'onbekende fout'}`);
  }
  return json;
}

/** Wacht tot de master-container status `FINISHED` is, of geeft een
 *  duidelijke fout als 't `ERROR` of `EXPIRED` wordt. Poll-interval is
 *  klein (1s) maar met max 30s totaal — voor 5 slides is doorgaans
 *  ~3-5s nodig. */
async function waitForContainerReady(
  containerId: string,
  token: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const r = (await getGraph(
      containerId,
      { fields: 'status_code,status' },
      token,
    )) as { status_code?: string; status?: string };
    lastStatus = r.status_code ?? r.status ?? '';
    if (lastStatus === 'FINISHED') return;
    if (lastStatus === 'ERROR' || lastStatus === 'EXPIRED') {
      throw new Error(`IG container status=${lastStatus}`);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`IG container niet klaar binnen 30s (last status=${lastStatus})`);
}

export interface PublishInput {
  imageUrls: string[]; // alle slides in volgorde — cover + events + outro
  caption: string;
}

export interface PublishResult {
  igMediaId: string;
  permalink: string | null;
}

/**
 * Publiceert een carousel naar het geconfigureerde IG-account.
 * Throws bij elke fout — caller moet die opvangen en op de DB-rij
 * naar status='failed' schrijven met de error-message.
 */
export async function publishCarousel(input: PublishInput): Promise<PublishResult> {
  if (input.imageUrls.length < 2) {
    throw new Error('IG carousel vereist minimaal 2 slides');
  }
  if (input.imageUrls.length > 10) {
    throw new Error('IG carousel max 10 slides — heeft ' + input.imageUrls.length);
  }

  const { token, userId } = requireEnv();

  // 1. Maak child-containers parallel — elke slide z'n eigen container
  const childIds = await Promise.all(
    input.imageUrls.map(async (url) => {
      const r = (await postGraph(
        `${userId}/media`,
        {
          image_url: url,
          is_carousel_item: 'true',
        },
        token,
      )) as { id?: string };
      if (!r.id) throw new Error('IG child-container geen id terug');
      return r.id;
    }),
  );

  // 2. Master carousel-container
  const master = (await postGraph(
    `${userId}/media`,
    {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption: input.caption,
    },
    token,
  )) as { id?: string };
  if (!master.id) throw new Error('IG master-container geen id terug');

  // 3. Wacht tot de master container klaar is
  await waitForContainerReady(master.id, token);

  // 4. Publish
  const published = (await postGraph(
    `${userId}/media_publish`,
    { creation_id: master.id },
    token,
  )) as { id?: string };
  if (!published.id) throw new Error('IG publish geen media-id terug');

  // 5. Permalink ophalen — de media-id is numeriek, niet de shortcode die IG
  //    in URLs gebruikt. Eén losse fetch om de canonieke `instagram.com/p/<sc>/`
  //    URL op te slaan voor de admin-UI. Best-effort: bij fout returnen we null.
  let permalink: string | null = null;
  try {
    const meta = (await getGraph(
      published.id,
      { fields: 'permalink' },
      token,
    )) as { permalink?: string };
    permalink = meta.permalink ?? null;
  } catch {
    // permalink-fetch is niet kritisch; publish is al gelukt
  }

  return { igMediaId: published.id, permalink };
}
