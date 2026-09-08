# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`?ucVersion=<semver | latest>`** — pin the Uploadcare File Uploader version loaded from
  jsDelivr. Accepts explicit semver (`1.31.2`, `1.32.0-beta.1`) or the moving `latest` tag. Missing
  or malformed values silently fall back to `latest`. The resolved uploader URL, requested value,
  and validity flag appear in the sandbox page's Meta panel. Sandbox is no longer pinned to a single
  uploader version — reproducing an old bug is now `?ucVersion=1.28.0`. New
  `static/lib/uploader_version.js` + 7 dedicated tests.

### Changed

- **Uploader import is now dynamic.** The static jsDelivr import was replaced with a dynamic
  `import()` after the version is resolved. If the CDN load fails (unknown version, network block),
  the sandbox now shows an inline placeholder + surfaces the error in the Meta panel instead of
  crashing the page.

## [0.4.0] — 2026-07-16

### Added

- **Uploadcare API errors returned as HTTP 2xx are now detected.** The fetch/XHR wrapper sniffs JSON
  responses from `upload.uploadcare.com` and `api.uploadcare.com`, and if the body carries an
  Uploadcare error shape (`{error: "..."}`, `{error: {status_code, content}}`,
  `{status: "error", detail}`), it attaches a small `apiError: {code?, message}` summary to the
  event and counts it toward `errorCount`. Body content is still never persisted. Session view shows
  the message inline in the row summary and marks the row red. New `static/lib/uploadcare_errors.js`
  with 14 dedicated tests covering all known shapes.
- **Telemetry filter.** Requests to `tlm.uploadcare.com` are tagged `isTelemetry: true` and filtered
  out of `GET /api/session/:id` by default so the timeline isn't drowned in analytics pings. Pass
  `?includeTelemetry=1` (or tick the new "show telemetry" checkbox in session view) to see them.
  Data is always stored, only hidden on read.

### Removed

- **`user` entity.** The persistent anonymous user record and its KV artifacts (`["user", …]`,
  `["user_index", …]`, `["session_by_user", …]`) are gone. The `sandbox-user-id` cookie /
  localStorage entry is no longer set. Admin dashboard drops the `userId` filter column and the
  "user" table column; session view drops the `userId` line from the meta. The API tolerates legacy
  `userId` fields on request bodies for backward compatibility — they're ignored. Existing KV
  records with `userId` on them still work; only the fields aren't consulted or displayed anymore.

## [0.3.0] — 2026-07-16

### Added

- **`?speedtest=1`** — opt-in Cloudflare-backed network speed probe. Runs on page load, measures
  real download + upload throughput against `speed.cloudflare.com`, emits a `speedtest` event with
  `{download, upload, startedAt, finishedAt}`. Bundled at the top of the session view's Environment
  panel. Uses ~15 MB and 10–20 s of the customer's bandwidth, hence opt-in via a query flag so
  support triage adds it deliberately. Off by default. A fixed-position banner with a spinner is
  shown for the duration of the test ("Measuring download speed…" → "Measuring upload speed…" →
  result summary that self-clears after a few seconds) so users don't close the tab mid-test.
- **Delete session from admin.** Every row in `/admin` grew a `×` button. Click, confirm, and the
  session record, all its events, and both index entries are deleted. Backed by
  `DELETE /api/admin/session/:id` — admin-gated, returns 404 for unknown ids.
- **`static/lib/engagement.js`** and **`static/lib/speedtest.js`** — new libs, both DI-injectable
  and covered by dedicated test files.

### Changed

- **Engagement gating.** The client now only calls `/api/session` (and starts flushing events) once
  the user has actually engaged with the uploader OR something errored. Engagement = `file-added` /
  `file-upload-start` / `common-upload-start` / any `js-error` / `unhandled-rejection` /
  `fetch-error` / `xhr-error` / `console.error`. Sessions where a visitor lands and leaves without
  touching anything never reach the server. Mount failures and early errors still get captured
  because errors themselves count as engagement.

## [0.2.0] — 2026-07-15

### Changed

- **Deployment.** Deno Deploy is now linked directly to the GitHub repo — pushes to `main`
  auto-deploy to production and PRs get preview URLs. `deployctl` stays as a manual fallback. See
  [Deployment](./README.md#deployment) for the one-time dashboard setup.

## [0.1.0] — 2026-07-15

Initial release. Everything below shipped together as the first cut of the sandbox.

### Added

- **Sandbox page** (`/`) — loads `@uploadcare/file-uploader@1.31.2` from jsDelivr, configures it
  from the URL query string (both camelCase and kebab-case accepted), falls back to Uploadcare's
  `demopublickey` when no `pubkey` is supplied. Variant switcher (`regular` / `inline` / `minimal`).
  Resolved-config JSON panel for verification. Red warning banner when the page is loaded from a
  non-secure origin.
- **Client instrumentation** (`static/instrumentation.js`) — metadata-only monkey-patches of
  `window.fetch` and `XMLHttpRequest`; subscribes to uploader lifecycle events (`file-added`,
  `file-upload-{start,progress,success,failed}`, `common-upload-{start,progress,success,failed}`,
  `done-flow`, `modal-*`, `activity-change`, `change`, `file-removed`); captures `window.onerror`,
  `unhandledrejection`, `console.warn`/`console.error`; `PerformanceObserver` for Uploadcare
  resource timings; in-memory buffer flushes every 20 events or 3 s, plus `navigator.sendBeacon` on
  `pagehide` / `visibilitychange:hidden`. Header safelist strips auth/cookie/signature headers.
  `window.__sandbox` DevTools helper.
- **Session/event API + KV storage** — `POST /api/session`, `POST /api/event`,
  `POST /api/event-beacon`. Persistent anonymous user id (`localStorage` + cookie) + per-load
  session id. KV keys: `user`, `user_index`, `session`, `session_by_user`, `session_index`, `event`.
  Race-safe: an event that lands before its session synthesizes a minimal session record; a later
  `POST /api/session` merges into it and preserves the original `createdAt`.
- **Public per-session view** (`/session/:id`) — event timeline with category tabs (All / Network /
  Errors / Uploader / Perf / Env / Other), text search, expandable JSON rows, copy/download-as-JSON.
  Resource-timing correlation attaches a `perf` badge and inline `_perf` entry to matching fetch/XHR
  rows.
- **Admin dashboard** (`/admin`) — session table with filters (`userId`, `pubkey`, `label`,
  `hasError`); defaults to `?hasError=true` when opened cold. Filter state mirrored to the URL for
  bookmarking. Session-to-session navigation (Back / Previous / Next) on `/session/:id` respects the
  same filters via `GET /api/admin/session/:id/neighbors`.
- **Admin auth** — `ADMIN_USER` / `ADMIN_PASS` env vars. Cookie session (32-byte token in KV, 30-day
  TTL, `HttpOnly`, `SameSite=Lax`) issued from a login form, plus HTTP Basic Auth still accepted for
  `curl`. Constant-time credential comparison. Unconfigured `/admin*` returns 503.
- **Scenario presets** (`?scenario=<name>`) — `multipart`, `image-crop`, `low-limits`, `camera`,
  `url-only`. Precedence: defaults < preset < explicit URL params.
- **Environment snapshot + host reachability probes** — `static/lib/env.js` captures baseline
  browser env (UA, language, platform, screen, viewport, timezone, `matchMedia`, secure-context,
  cookies-enabled, DNT) plus `navigator.connection` and subscribes to `navigator.connection.change`;
  `static/lib/probes.js` fires parallel HEAD probes for `upload.uploadcare.com`,
  `api.uploadcare.com`, `ucarecdn.com`, `ucarecd.net` on session start. Results shown as timeline
  events (`probe-host`, `probe-summary`, `env-network-change`) and in a new Environment panel above
  the timeline.
- **Testing** — 149 tests across nine files, all running against `Deno.openKv(":memory:")`
  (`config_test.ts`, `serialize_test.ts`, `server_test.ts`, `session_test.ts`, `admin_test.ts`,
  `presets_test.ts`, `id_test.ts`, `env_test.ts`, `probes_test.ts`).
- **Docs** — `README.md` with roadmap, testing table, storage schema, admin auth, scenario presets,
  session navigation, and captured-event reference.

### Notes

- Bodies are never captured — request/response payloads are stripped at the source; only metadata
  (URL, method, status, safelisted headers, sizes, timings) is persisted.
- Local dev serves static files with `Cache-Control: no-store` (bypassed on Deno Deploy).
- Deployment is currently manual via `deployctl` — GitHub-linked auto-deploy is planned for the next
  version.

[Unreleased]: https://github.com/optlsnd/uploadcare-uploader-sandbox/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/optlsnd/uploadcare-uploader-sandbox/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/optlsnd/uploadcare-uploader-sandbox/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/optlsnd/uploadcare-uploader-sandbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/optlsnd/uploadcare-uploader-sandbox/releases/tag/v0.1.0
