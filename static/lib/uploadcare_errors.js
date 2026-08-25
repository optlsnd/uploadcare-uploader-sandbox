/**
 * Detect Uploadcare API errors that arrive as HTTP 2xx with an error
 * payload in the JSON body. Both the Upload API and the REST API do
 * this — a 200 with `{ error: "…" }` (or nested variants) is a common
 * shape for validation failures and rate limits.
 *
 * We do NOT persist the body, only a small structured summary. Kept
 * pure and DI-friendly so tests don't need the DOM.
 *
 * Known Uploadcare error shapes we've seen in the wild:
 *  - Upload API: `{ error: { status_code: 400, content: "..." } }` or `{ error: "..." }`
 *  - REST API:   `{ error: "...", error_uuid: "..." }`
 *  - Some rate-limit paths: `{ status: "error", detail: "..." }`
 */

const JSON_CONTENT_TYPE_RE = /application\/(json|.+\+json)/i;

/** @param {string | null | undefined} contentType */
export function isJsonContentType(contentType) {
  return typeof contentType === "string" && JSON_CONTENT_TYPE_RE.test(contentType);
}

/**
 * Extract an error summary from a parsed JSON body, or `null` if the
 * body doesn't look like an Uploadcare API error.
 * @param {unknown} body
 * @returns {{ code?: string, message: string } | null}
 */
export function extractUploadcareError(body) {
  if (!body || typeof body !== "object") return null;
  const obj = /** @type {Record<string, unknown>} */ (body);

  // Shape: { error: { status_code, content } }
  const err = obj.error;
  if (err && typeof err === "object") {
    const e = /** @type {Record<string, unknown>} */ (err);
    const message = typeof e.content === "string"
      ? e.content
      : (typeof e.message === "string" ? e.message : "unknown Uploadcare error");
    const code = typeof e.status_code === "number"
      ? String(e.status_code)
      : (typeof e.code === "string" ? e.code : undefined);
    return code ? { code, message } : { message };
  }

  // Shape: { error: "..." } and typically { error_uuid: "..." }
  if (typeof err === "string" && err.length > 0) {
    const code = typeof obj.error_uuid === "string" ? obj.error_uuid : undefined;
    return code ? { code, message: err } : { message: err };
  }

  // Shape: { status: "error", detail: "..." }
  if (obj.status === "error") {
    const message = typeof obj.detail === "string"
      ? obj.detail
      : (typeof obj.message === "string" ? obj.message : "Uploadcare error status");
    return { message };
  }

  return null;
}

/**
 * Try to parse a raw JSON body string and extract an Uploadcare error.
 * Returns `null` if the string isn't JSON or doesn't match a known
 * error shape.
 * @param {string} raw
 * @returns {{ code?: string, message: string } | null}
 */
export function extractFromRawBody(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return extractUploadcareError(JSON.parse(raw));
  } catch {
    return null;
  }
}
