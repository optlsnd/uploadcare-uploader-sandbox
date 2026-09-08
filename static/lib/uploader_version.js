/**
 * Validate and normalize an Uploadcare uploader version string coming
 * from the `?ucVersion=...` query param. jsDelivr accepts either an
 * explicit semver tag (`@1.31.2`, `@1.31.2-beta.1`) or the `latest`
 * moving tag. Anything else falls back to `latest` — we don't want a
 * malformed value to break the sandbox and we don't want to encode
 * arbitrary strings into a CDN path.
 *
 * @typedef {{ version: string, requested: string | null, ok: boolean }} ResolvedVersion
 */

const VERSION_RE = /^(?:latest|\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)$/;

/** @param {unknown} raw @returns {ResolvedVersion} */
export function resolveUploaderVersion(raw) {
  if (raw == null || raw === "") {
    return { version: "latest", requested: null, ok: true };
  }
  const requested = String(raw).trim();
  if (!VERSION_RE.test(requested)) {
    return { version: "latest", requested, ok: false };
  }
  return { version: requested, requested, ok: true };
}

/** @param {string} version @returns {string} */
export function uploaderCdnUrl(version) {
  return `https://cdn.jsdelivr.net/npm/@uploadcare/file-uploader@${version}/web/file-uploader.min.js`;
}
