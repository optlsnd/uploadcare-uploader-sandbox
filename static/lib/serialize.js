export const HEADER_SAFELIST = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "age",
  "cache-control",
  "content-encoding",
  "content-length",
  "content-type",
  "date",
  "etag",
  "location",
  "retry-after",
  "server",
  "user-agent",
  "vary",
  "x-ratelimit-remaining",
  "x-request-id",
  "x-uc-request-id",
  "x-uploadcare-request-id",
]);

export const UPLOADCARE_HOST = /(^|\.)(uploadcare\.com|ucarecdn\.com|ucarecdn\.io)$/i;

/** @param {unknown} name */
export function safeHeaderName(name) {
  return HEADER_SAFELIST.has(String(name).toLowerCase());
}

/**
 * @param {Headers|Record<string,unknown>|Array<[string,unknown]>|null|undefined} headers
 * @returns {Record<string, string>}
 */
export function filterHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!headers) return out;
  let entries;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    entries = Array.from(headers.entries());
  } else if (Array.isArray(headers)) {
    entries = headers;
  } else {
    entries = Object.entries(headers);
  }
  for (const [k, v] of entries) {
    if (safeHeaderName(k)) out[String(k).toLowerCase()] = String(v);
  }
  return out;
}

/**
 * @param {string|null|undefined} raw
 * @returns {Record<string, string>}
 */
export function parseRawHeaders(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!raw) return out;
  for (const line of raw.trim().split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (safeHeaderName(k)) out[k] = v;
  }
  return out;
}

export function bodySize(body) {
  if (body == null) return 0;
  if (typeof body === "string") return body.length;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return body.toString().length;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) return -1;
  return -1;
}

export function isUploadcareUrl(url, base) {
  try {
    const u = new URL(url, base);
    return UPLOADCARE_HOST.test(u.host);
  } catch {
    return false;
  }
}

export function urlOf(input) {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "url" in input) return input.url;
  return String(input);
}

export function methodOf(input, init) {
  if (init?.method) return String(init.method).toUpperCase();
  if (input && typeof input === "object" && "method" in input && input.method) {
    return String(input.method).toUpperCase();
  }
  return "GET";
}

/**
 * JSON-safe deep clone that strips non-serializable / privacy-sensitive
 * values. Files/Blobs are turned into small stand-ins; functions are
 * dropped; DOM references are replaced with a marker.
 * @param {unknown} value
 * @returns {any}
 */
export function sanitize(value) {
  const hasHTMLElement = typeof HTMLElement !== "undefined";
  try {
    return JSON.parse(JSON.stringify(value, (_key, v) => {
      if (typeof File !== "undefined" && v instanceof File) {
        return { _kind: "File", name: v.name, size: v.size, type: v.type };
      }
      if (typeof Blob !== "undefined" && v instanceof Blob) {
        return { _kind: "Blob", size: v.size, type: v.type };
      }
      if (hasHTMLElement && v instanceof HTMLElement) {
        return `[HTMLElement ${v.tagName.toLowerCase()}]`;
      }
      if (v instanceof Error) {
        return { _kind: "Error", name: v.name, message: v.message, stack: v.stack };
      }
      if (typeof v === "function") return undefined;
      if (typeof v === "bigint") return String(v);
      return v;
    }));
  } catch (err) {
    return { _serializationError: String(err) };
  }
}
