/**
 * Reachability probes for the Uploadcare API hosts. Uses HEAD with
 * `no-cors` so DNS/TLS-level failures surface as fetch rejections while
 * CORS blocks return an opaque response — we only care that the network
 * layer reached the origin, not the HTTP body.
 *
 * @typedef {{
 *   host: string,
 *   url: string,
 *   ok: boolean,
 *   ms: number,
 *   status?: number|null,
 *   type?: string|null,
 *   error?: string,
 *   message?: string,
 * }} ProbeResult
 */

export const DEFAULT_HOSTS = /** @type {const} */ ([
  "upload.uploadcare.com",
  "api.uploadcare.com",
  "ucarecdn.com",
  "ucarecd.net",
]);

/**
 * @param {string} host
 * @param {{
 *   fetch?: (input: string, init?: RequestInit) => Promise<Response>,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   path?: string,
 *   AbortCtrl?: typeof AbortController,
 * }} [opts]
 * @returns {Promise<ProbeResult>}
 */
export async function probeHost(host, opts = {}) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => performance.now());
  const timeoutMs = opts.timeoutMs ?? 5000;
  const path = opts.path ?? "/";
  const Ctrl = opts.AbortCtrl ?? globalThis.AbortController;
  const url = `https://${host}${path}`;

  const controller = Ctrl ? new Ctrl() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const startedAt = now();

  try {
    const res = await fetchFn(url, {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      redirect: "follow",
      credentials: "omit",
      signal: controller?.signal,
    });
    return {
      host,
      url,
      ok: true,
      ms: Math.round(now() - startedAt),
      status: typeof res.status === "number" ? res.status : null,
      type: typeof res.type === "string" ? res.type : null,
    };
  } catch (err) {
    /** @type {any} */
    const e = err;
    const isAbort = e?.name === "AbortError";
    return {
      host,
      url,
      ok: false,
      ms: Math.round(now() - startedAt),
      error: isAbort ? "timeout" : (e?.name ?? "network"),
      message: String(e?.message ?? e),
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Probe all hosts in parallel.
 * @param {readonly string[]} hosts
 * @param {Parameters<typeof probeHost>[1]} [opts]
 * @returns {Promise<ProbeResult[]>}
 */
export async function probeHosts(hosts, opts) {
  return Promise.all(hosts.map((h) => probeHost(h, opts)));
}
