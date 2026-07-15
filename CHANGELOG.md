# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/optlsnd/uploadcare-uploader-sandbox/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/optlsnd/uploadcare-uploader-sandbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/optlsnd/uploadcare-uploader-sandbox/releases/tag/v0.1.0
