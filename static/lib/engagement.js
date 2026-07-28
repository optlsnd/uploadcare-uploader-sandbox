/**
 * Predicate for the "did the user actually use this session?" gate on
 * the client. If any event that flows through the buffer is deemed an
 * engagement, we promote the session (POST /api/session then flush).
 * Sessions that never engage never touch the server.
 *
 * Engagement = the user picked/dropped a file OR upload attempts began
 * OR anything errored (so we still catch mount failures / early bugs).
 */

export const ENGAGEMENT_UPLOADER_NAMES = new Set([
  "file-added",
  "file-upload-start",
  "common-upload-start",
]);

/**
 * @param {Record<string, unknown> | null | undefined} ev
 * @returns {boolean}
 */
export function isEngagementEvent(ev) {
  if (!ev || typeof ev !== "object") return false;
  const kind = ev.kind;
  if (kind === "js-error" || kind === "unhandled-rejection") return true;
  if (kind === "fetch-error" || kind === "xhr-error") return true;
  if (kind === "console" && ev.level === "error") return true;
  if (kind === "uploader-event") {
    const name = /** @type {{ name?: unknown }} */ (ev).name;
    return typeof name === "string" && ENGAGEMENT_UPLOADER_NAMES.has(name);
  }
  return false;
}
