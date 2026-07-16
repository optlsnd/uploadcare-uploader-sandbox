/**
 * Minimal Cloudflare-backed network speed probe. Uses
 * `speed.cloudflare.com/__down` and `__up` — the same endpoints their
 * public speedtest page hits. CORS-friendly, no signup.
 *
 * Costs: 5 MB down + 2 MB up per run by default. Only ships behind
 * `?speedtest=1` because that traffic is meaningful on cellular.
 *
 * @typedef {{
 *   bytes: number,
 *   ms: number,
 *   mbps: number,
 * }} SpeedResult
 *
 * @typedef {{
 *   download: SpeedResult | { error: string, bytes: number },
 *   upload:   SpeedResult | { error: string, bytes: number },
 *   startedAt: number,
 *   finishedAt: number,
 * }} SpeedtestResult
 */

const DOWN_URL = "https://speed.cloudflare.com/__down";
const UP_URL = "https://speed.cloudflare.com/__up";

/**
 * @param {number} bytes
 * @param {number} ms
 * @returns {number}
 */
function mbpsOf(bytes, ms) {
  if (!Number.isFinite(bytes) || !Number.isFinite(ms) || ms <= 0) return 0;
  return Number(((bytes * 8) / (ms * 1000)).toFixed(2));
}

/**
 * Fetch a known-size payload from Cloudflare and time it.
 * @param {{ bytes?: number, fetch?: (input: string, init?: RequestInit) => Promise<Response>, now?: () => number }} [opts]
 * @returns {Promise<SpeedResult | { error: string, bytes: number }>}
 */
export async function downloadSpeed(opts = {}) {
  const bytes = opts.bytes ?? 5_000_000;
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => performance.now());
  const url = `${DOWN_URL}?bytes=${bytes}`;
  const started = now();
  try {
    const res = await fetchFn(url, { cache: "no-store" });
    if (!res.ok) return { error: `HTTP ${res.status}`, bytes };
    await res.arrayBuffer();
    const ms = Math.round(now() - started);
    return { bytes, ms, mbps: mbpsOf(bytes, ms) };
  } catch (err) {
    return { error: String(/** @type {any} */ (err)?.message ?? err), bytes };
  }
}

/**
 * POST a random-payload body to Cloudflare and time it.
 * @param {{ bytes?: number, fetch?: (input: string, init?: RequestInit) => Promise<Response>, now?: () => number }} [opts]
 * @returns {Promise<SpeedResult | { error: string, bytes: number }>}
 */
export async function uploadSpeed(opts = {}) {
  const bytes = opts.bytes ?? 2_000_000;
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => performance.now());
  const body = new Uint8Array(bytes);
  const started = now();
  try {
    const res = await fetchFn(UP_URL, {
      method: "POST",
      body,
      cache: "no-store",
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, bytes };
    await res.text();
    const ms = Math.round(now() - started);
    return { bytes, ms, mbps: mbpsOf(bytes, ms) };
  } catch (err) {
    return { error: String(/** @type {any} */ (err)?.message ?? err), bytes };
  }
}

/**
 * Run a sequential download-then-upload probe. Both halves swallow their
 * own errors so a partial result is always returned.
 * @param {{ downloadBytes?: number, uploadBytes?: number, fetch?: (input: string, init?: RequestInit) => Promise<Response>, now?: () => number, clock?: () => number }} [opts]
 * @returns {Promise<SpeedtestResult>}
 */
export async function runSpeedtest(opts = {}) {
  const clock = opts.clock ?? (() => Date.now());
  const startedAt = clock();
  const download = await downloadSpeed({
    bytes: opts.downloadBytes,
    fetch: opts.fetch,
    now: opts.now,
  });
  const upload = await uploadSpeed({
    bytes: opts.uploadBytes,
    fetch: opts.fetch,
    now: opts.now,
  });
  return { download, upload, startedAt, finishedAt: clock() };
}
