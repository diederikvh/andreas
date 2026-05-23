/**
 * Gedeelde fetch-helpers voor scrapers.
 *
 * Probleem: `fetch()` heeft geen default-timeout. Eén hangende
 * venue-pagina sloopt de hele scrape-run tot de 25-min cron-timeout
 * (zoals 2026-05-23 nacht met The Movies). De Movies heeft 550 film-
 * URLs — als één daarvan hangt op TCP-niveau bleef de scraper plakken.
 *
 * `fetchTextWithTimeout` aborteert na N ms (default 15s) en returnt
 * null bij timeout/error. Per-file `fetchText` wrappers blijven
 * bestaan voor backwards-compat met de bestaande callsites; ze
 * delegeren hierheen.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface FetchOpts {
  /** User-Agent header. Default `AndreasBot/1.0`. */
  ua?: string;
  /** Timeout in ms. Default 15 000. */
  timeoutMs?: number;
  /** Extra headers (worden gemerged bovenop UA + Accept). */
  headers?: Record<string, string>;
  /** HTTP-method. Default 'GET'. */
  method?: string;
  /** Body voor non-GET. */
  body?: string;
}

/**
 * Fetch + decode-naar-string met AbortController-timeout. Returnt
 * null bij:
 *   - non-2xx response
 *   - timeout (15s default)
 *   - network/DNS error
 *
 * Caller doet doorgaans `if (!html) continue;` — geen exception, geen
 * herhaalde try/catch in elke scraper.
 */
export async function fetchTextWithTimeout(
  url: string,
  opts: FetchOpts = {}
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  try {
    const r = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'User-Agent': opts.ua ?? DEFAULT_UA,
        ...opts.headers,
      },
      body: opts.body,
      signal: controller.signal,
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Variant die JSON parseert. Returnt null bij dezelfde fout-condities
 * als `fetchTextWithTimeout` of als de body geen valid JSON is.
 */
export async function fetchJsonWithTimeout<T = unknown>(
  url: string,
  opts: FetchOpts = {}
): Promise<T | null> {
  const text = await fetchTextWithTimeout(url, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers ?? {}) },
  });
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
