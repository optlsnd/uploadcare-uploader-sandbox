/**
 * Environment snapshot helpers. Everything is defensive against missing
 * globals so the same code can run in a Deno test with an injected
 * `ctx`.
 *
 * @typedef {{ navigator?: any, document?: any, screen?: any, Intl?: any, isSecureContext?: any, innerWidth?: any, innerHeight?: any, devicePixelRatio?: any, matchMedia?: any, location?: any }} EnvCtx
 */

/** @param {unknown} v @returns {number|null} */
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** @param {unknown} v @returns {boolean|null} */
function boolOrNull(v) {
  return typeof v === "boolean" ? v : null;
}

/** @param {unknown} v @returns {string|null} */
function strOrNull(v) {
  return typeof v === "string" ? v : null;
}

/** @returns {EnvCtx} */
function defaultCtx() {
  const g = /** @type {any} */ (globalThis);
  return {
    navigator: g.navigator,
    document: g.document,
    screen: g.screen,
    Intl: g.Intl,
    isSecureContext: g.isSecureContext,
    innerWidth: g.innerWidth,
    innerHeight: g.innerHeight,
    devicePixelRatio: g.devicePixelRatio,
    matchMedia: typeof g.matchMedia === "function" ? g.matchMedia.bind(g) : null,
    location: g.location,
  };
}

/**
 * Capture the static browser environment. Same shape every time.
 * @param {EnvCtx} [ctx]
 */
export function captureBaseline(ctx = defaultCtx()) {
  const nav = ctx.navigator ?? {};
  const doc = ctx.document ?? {};
  const screen = ctx.screen ?? {};
  const loc = ctx.location ?? {};

  const matches = (/** @type {string} */ q) => {
    try {
      const mm = ctx.matchMedia;
      if (typeof mm !== "function") return null;
      const r = mm(q);
      return typeof r?.matches === "boolean" ? r.matches : null;
    } catch {
      return null;
    }
  };

  let timezone = null;
  let timezoneOffset = null;
  try {
    timezone = ctx.Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone ?? null;
  } catch { /* ignore */ }
  try {
    timezoneOffset = new Date().getTimezoneOffset();
  } catch { /* ignore */ }

  return {
    userAgent: strOrNull(nav.userAgent),
    language: strOrNull(nav.language),
    languages: Array.isArray(nav.languages) ? [...nav.languages] : null,
    platform: strOrNull(nav.platform),
    hardwareConcurrency: numOrNull(nav.hardwareConcurrency),
    cookieEnabled: boolOrNull(nav.cookieEnabled),
    doNotTrack: strOrNull(nav.doNotTrack),
    onLine: boolOrNull(nav.onLine),
    isSecureContext: boolOrNull(ctx.isSecureContext),
    screen: {
      width: numOrNull(screen.width),
      height: numOrNull(screen.height),
      availWidth: numOrNull(screen.availWidth),
      availHeight: numOrNull(screen.availHeight),
      colorDepth: numOrNull(screen.colorDepth),
    },
    viewport: {
      width: numOrNull(ctx.innerWidth),
      height: numOrNull(ctx.innerHeight),
      devicePixelRatio: numOrNull(ctx.devicePixelRatio),
    },
    matchMedia: {
      dark: matches("(prefers-color-scheme: dark)"),
      reducedMotion: matches("(prefers-reduced-motion: reduce)"),
      hoverable: matches("(hover: hover)"),
      finePointer: matches("(pointer: fine)"),
    },
    timezone,
    timezoneOffset,
    characterSet: strOrNull(doc.characterSet),
    referrer: strOrNull(doc.referrer),
    url: strOrNull(loc.href),
    origin: strOrNull(loc.origin),
    protocol: strOrNull(loc.protocol),
    search: strOrNull(loc.search),
  };
}

/**
 * Snapshot `navigator.connection` + `onLine`. Safe on browsers that
 * don't expose Network Information API (Safari, Firefox).
 * @param {EnvCtx} [ctx]
 */
export function captureNetwork(ctx = defaultCtx()) {
  const nav = ctx.navigator ?? {};
  const c = nav.connection;
  if (!c) return { onLine: boolOrNull(nav.onLine), connection: null };
  return {
    onLine: boolOrNull(nav.onLine),
    connection: {
      effectiveType: strOrNull(c.effectiveType),
      downlink: numOrNull(c.downlink),
      rtt: numOrNull(c.rtt),
      saveData: boolOrNull(c.saveData),
      type: strOrNull(c.type),
    },
  };
}

/**
 * Subscribe to `navigator.connection.change`. Returns an unsubscribe
 * function or `null` if the API is unavailable.
 * @param {(snapshot: ReturnType<typeof captureNetwork>) => void} onChange
 * @param {EnvCtx} [ctx]
 */
export function onNetworkChange(onChange, ctx = defaultCtx()) {
  const c = ctx.navigator?.connection;
  if (!c || typeof c.addEventListener !== "function") return null;
  const handler = () => {
    try {
      onChange(captureNetwork(ctx));
    } catch { /* swallow */ }
  };
  c.addEventListener("change", handler);
  return () => {
    try {
      c.removeEventListener("change", handler);
    } catch { /* swallow */ }
  };
}
