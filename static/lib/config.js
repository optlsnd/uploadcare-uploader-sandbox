export const DEFAULT_PUBKEY = "demopublickey";

export function toKebabCase(key) {
  return String(key).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

/**
 * Fill in defaults for forwarded uploader attributes. User-supplied
 * values always win; only missing keys get the default.
 * @param {Record<string, string>} forwarded
 * @returns {Record<string, string>}
 */
export function applyDefaults(forwarded) {
  return { pubkey: DEFAULT_PUBKEY, ...forwarded };
}

/**
 * Split a URL search string into two buckets:
 *  - `forwarded`: keys destined for `<uc-config>` (kebab-cased)
 *  - `sandbox`: reserved sandbox-only keys (kept as-is)
 * `reservedKeys` is a Set of strings that identify sandbox-only params.
 * Accepts both a URLSearchParams and a raw search string (with or without `?`).
 */
export function parseQuery(search, reservedKeys) {
  const params = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(String(search ?? "").replace(/^\?/, ""));
  const forwarded = {};
  const sandbox = {};
  for (const [rawKey, value] of params.entries()) {
    if (reservedKeys.has(rawKey)) sandbox[rawKey] = value;
    else forwarded[toKebabCase(rawKey)] = value;
  }
  return { forwarded, sandbox };
}
