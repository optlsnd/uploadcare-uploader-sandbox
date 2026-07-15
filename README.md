# Uploadcare Uploader Sandbox

A hosted sandbox for the [Uploadcare File Uploader](https://uploadcare.com/docs/file-uploader/) that
captures rich debugging data (network requests, uploader events, JS errors, environment context) so
support and engineering can diagnose customer upload issues without having to reproduce them
locally.

**Status:** in development. See [Roadmap](#roadmap) for what's built and what's next.

## How it works

1. A user opens a sandbox URL (either an open link or a support-provided one with pre-filled
   config).
2. The uploader mounts using config read from the URL query string — no code change needed to
   reconfigure.
3. The page instruments `fetch` / `XMLHttpRequest`, uploader lifecycle events, `window.onerror`,
   unhandled promise rejections, and browser environment details.
4. Events stream to the server and land in Deno KV, keyed by an anonymous user ID (persistent) and a
   session ID (per page load).
5. Support views the captured data via a protected admin dashboard or a per-session shareable URL.

## Stack

- Runtime: [Deno](https://deno.com/) (server) + native browser (client)
- Hosting: [Deno Deploy](https://deno.com/deploy)
- Storage: Deno KV (indefinite retention)
- Server: plain `Deno.serve` + `@std/http` static file serving (no framework)
- Uploader: `@uploadcare/file-uploader@1.31.2` loaded from jsDelivr

## Getting started

Prerequisites: Deno ≥ 2.7.

```sh
deno task start     # runs on http://localhost:8000
deno task dev       # same, with --watch
deno task test      # runs the full test suite
```

Open `http://localhost:8000/?pubkey=YOUR_PUBLIC_KEY` and upload a file.

> **Use `localhost` (or `127.0.0.1`), not `0.0.0.0` or a LAN IP.** The uploader relies on
> `crypto.subtle` and `crypto.randomUUID`, both of which browsers only expose in secure contexts
> (HTTPS, `localhost`, `127.0.0.1`). The sandbox page shows a red warning banner if the page is
> loaded from a non-secure origin.

## Testing

Tests run with Deno's built-in runner against an in-memory KV (`Deno.openKv(":memory:")`) — no port
binding, no shared state between tests. Suites:

| File                      | Covers                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tests/config_test.ts`    | Query-string parsing, kebab-case conversion, reserved-key split.                                          |
| `tests/serialize_test.ts` | Header safelist, HTTP header parsing, body sizing, URL classification, `sanitize`.                        |
| `tests/server_test.ts`    | `handleSessionPost` / `handleEventPost` / `createHandler`; race handling; indexing.                       |
| `tests/session_test.ts`   | `classifyEvent`, `summarizeEvent`, `relativeTimestamp`, `countByCategory`, and `handleSessionGet`.        |
| `tests/admin_test.ts`     | `checkAdminAuth` (503/401/200 paths), `handleAdminSessions` filters, `errorCount` tracking, admin gating. |
| `tests/presets_test.ts`   | Scenario preset registry + `applyPreset` precedence (unknown / nullish name / override rules).            |
| `tests/id_test.ts`        | `randomUUID` shape, uniqueness, and `crypto.randomUUID` fallback path.                                    |
| `tests/env_test.ts`       | `captureBaseline` / `captureNetwork` shape + null-safety; `onNetworkChange` subscribe / unsubscribe.      |
| `tests/probes_test.ts`    | `probeHost` (success, network error, abort/timeout, custom path) + `probeHosts` ordering.                 |

Every future milestone ships with matching tests as part of the same step.

## Configuration via query string

Every query param becomes an attribute on the uploader's `<uc-config>` element. Both camelCase and
kebab-case are accepted; camelCase is normalized to kebab-case before being applied.

```
/?pubkey=demopublickey                             # minimal
/?pubkey=demopublickey&sourceList=local,url        # limit sources
/?pubkey=demopublickey&multiple=true&variant=inline
/?pubkey=demopublickey&cdnCname=https://cdn.example.com/
```

Reserved sandbox-only params (never forwarded to the uploader):

| Param      | Purpose                                                    |
| ---------- | ---------------------------------------------------------- |
| `variant`  | Uploader variant: `regular` (default), `inline`, `minimal` |
| `label`    | Free-form tag attached to the session                      |
| `scenario` | Apply a named preset (see below)                           |
| `_debug`   | Enable extra debug UI                                      |

If `pubkey` is missing, the sandbox falls back to `demopublickey` (Uploadcare's public demo key) so
the uploader always mounts. Any user-supplied `pubkey` overrides the default. All other params fall
through with no server-side validation; the uploader itself decides what's valid.

### Scenario presets

`?scenario=<name>` applies a named bundle of `<uc-config>` attributes before your explicit URL
params are merged in. Precedence: **defaults < preset < your URL params**.

| Scenario     | What it sets                                                                     |
| ------------ | -------------------------------------------------------------------------------- |
| `multipart`  | Force multipart uploads with small chunks (5 MiB threshold, 1 MiB chunk, multi). |
| `image-crop` | `imgOnly` + `cropPreset=1:1,4:3,16:9` + cloud image editor.                      |
| `low-limits` | `multipleMax=1`, `maxLocalFileSizeBytes=1048576` — tight limits for validation.  |
| `camera`     | Camera-only source, photo+video modes, mirrored preview.                         |
| `url-only`   | URL source only, multiple uploads.                                               |

Example: `/?scenario=multipart&pubkey=your-key` uses your key + the multipart preset. Explicit
values still win — `/?scenario=multipart&multipartMinFileSize=100` overrides the preset's threshold.

## Admin dashboard

`/admin` shows a table of the most recent sessions (newest first) with columns for created-at,
session id, pubkey, label, user, event count, and error count. Sessions with any error events are
highlighted; rows link out to `/session/:id` in a new tab.

Server-side filters supported on `GET /api/admin/sessions`:

| Query param     | Behavior                                           |
| --------------- | -------------------------------------------------- |
| `userId=…`      | Exact match on the anonymous user id.              |
| `pubkey=…`      | Exact match on the pubkey parsed from `env.url`.   |
| `label=…`       | Exact match on the label parsed from `env.url`.    |
| `hasError=true` | Only sessions whose `errorCount > 0`.              |
| `limit=N`       | Max sessions to return (default 200, clamped 500). |

The dashboard defaults to `?hasError=true` when opened with no filters — the common support-workflow
entry point. Adding any explicit filter (even just `?userId=x`) turns off that default so links like
`/admin?userId=…` show all of a user's sessions. Filter state is mirrored to the URL as you edit the
form, so it's bookmarkable and shareable.

**Session-to-session navigation.** On `/session/:id`, admins see a Back / Previous / Next bar. The
"Previous" and "Next" targets come from `GET /api/admin/session/:id/neighbors?<filters>`, which
respects the same filter set as the dashboard — so if you filtered `hasError=true` on `/admin` and
clicked into a session, "Next" walks through the next error session. The Back link returns to
`/admin` with the same filters preserved. The whole nav bar stays hidden for public viewers (401
response from the neighbors endpoint). The `userId` line in the session meta is a link to
`/admin?userId=…` for admins; plain text otherwise.

**Auth.** Credentials from `ADMIN_USER` / `ADMIN_PASS` env vars. Constant-time compare. Two ways in
— both accepted anywhere on `/admin*` and `/api/admin/*`:

- **Login form + cookie session** — top-level nav to `/admin` when unauthenticated 303-redirects to
  `/admin/login`. Submitting the form issues a random 32-byte token stored in KV under
  `["admin_session", token]` and sets
  `admin-session=<token>; HttpOnly; SameSite=Lax; Path=/;
  Max-Age=30d`. Works in every browser
  (including Brave, which suppresses native Basic Auth prompts).
- **HTTP Basic Auth** — still supported for `curl` / scripts and for browsers that do prompt. On
  `/api/admin/*`, unauthenticated requests get **401** with a
  `WWW-Authenticate: Basic realm="Uploader Sandbox Admin"` header (no redirect, so clients don't
  land on HTML).

If either env var is unset, `/admin` and `/api/admin/*` return **503** with a "not configured"
message — no login prompt or redirect.

```sh
ADMIN_USER=admin ADMIN_PASS=super-secret deno task start
# then open http://localhost:8000/admin — you'll land on the login form
```

`POST /admin/logout` clears the cookie and deletes the KV session entry.

## Deployment

Personal Deno Deploy project, deployed via `deployctl`:

```sh
deno task deploy    # deployctl deploy --project=uploader-sandbox --entrypoint=main.ts --include=main.ts,static
```

First deploy: run `deployctl login` if you haven't signed in.

Set the admin credentials as Deno Deploy env vars (`ADMIN_USER`, `ADMIN_PASS`) via the Deploy
dashboard so `/admin` is protected on the deployed instance.

## Project layout

```
main.ts                   # Deno server: routing dispatch, session/event handlers, KV
deno.json                 # tasks, imports, fmt
static/
  index.html              # sandbox page shell
  sandbox.js              # query-string → uploader wiring, resolved-config panel
  instrumentation.js      # fetch/XHR/error/perf/uploader capture, buffer, flush
  sandbox.css             # styling (light/dark)
  session.html            # per-session view shell (served for /session/:id)
  session.js              # fetches /api/session/:id, renders timeline
  admin.html              # admin dashboard shell (served for /admin, gated)
  admin.js                # fetches /api/admin/sessions, renders session table
  admin-login.html        # login form (served for /admin/login)
    config.js             # pure query-string parsing (shared with tests)
    serialize.js          # pure header/body/sanitize helpers (shared with tests)
    session.js            # event classification / summary / timing / correlation / filter
    id.js                 # crypto.randomUUID with a getRandomValues fallback
    presets.js            # named scenario bundles for ?scenario=<name>
    env.js                # browser env snapshot + navigator.connection subscriber
    probes.js             # parallel host-reachability HEAD probes
tests/
  server_test.ts          # session/event handlers against :memory: KV
  config_test.ts          # config.js unit tests
  serialize_test.ts       # serialize.js unit tests
  session_test.ts         # session view helpers + GET /api/session/:id handler
```

Pure client logic lives in `static/lib/*.js` so Deno tests can import it directly. The DOM-glue
files (`sandbox.js`, `instrumentation.js`) stay browser-only.

## What the instrumentation captures

Loaded before the uploader module so patches are in place first. Runs entirely client-side; no
bodies are ever recorded — only metadata.

| Event kind            | When                                                 | Fields                                                                     |
| --------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `fetch`               | Any `window.fetch` completes (2xx or non-2xx)        | url, method, status, ok, durationMs, req/res header safelist, body sizes   |
| `fetch-error`         | `fetch` rejects (network / CORS / abort)             | url, method, error {name,message}, durationMs, req headers                 |
| `xhr`                 | `XMLHttpRequest` completes with a status             | same shape as `fetch`                                                      |
| `xhr-error`           | XHR errors, aborts, or times out                     | url, method, error (`network`/`abort`/`timeout`), status                   |
| `perf-resource`       | `PerformanceObserver` `resource` entry for a UC host | name, initiatorType, timings, transfer/encoded/decoded sizes, nextHopProto |
| `uploader-event`      | Any `<uc-upload-ctx-provider>` DOM event             | name (e.g. `file-upload-failed`), sanitized `detail`                       |
| `js-error`            | `window.error`                                       | message, filename, lineno, colno, stack                                    |
| `unhandled-rejection` | Unhandled promise rejection                          | reason, stack                                                              |
| `console`             | `console.warn` / `console.error` invoked             | level, sanitized args                                                      |
| `probe-host`          | Uploadcare host reachability check (one per host)    | host, url, ok, ms, status, type / error, message                           |
| `probe-summary`       | Emitted once after all probes finish                 | startedAt, finishedAt, results[]                                           |
| `env-network-change`  | `navigator.connection.change` fires during session   | onLine, connection {effectiveType, downlink, rtt, saveData, type}          |

**Header safelist.** Anything not on the safelist (auth tokens, cookies, signatures, etc.) is
dropped. Current list lives in `instrumentation.js` and covers content headers, caching,
request/response IDs, and standard CORS/timing headers.

**Uploader events subscribed.** `file-added`, `file-removed`,
`file-upload-{start,progress,success,failed}`, `common-upload-{start,progress,success,failed}`,
`done-flow`, `change`, `modal-open`, `modal-close`, `activity-change`. Payloads pass through a
sanitizer that turns `File` / `Blob` / DOM nodes / functions into safe placeholders.

**Buffer / flush.** In-memory buffer flushes when it hits 20 events or after 3 s of quiet. On
`visibilitychange: hidden` and `pagehide`, flushes via `navigator.sendBeacon` to
`/api/event-beacon`. Beacon requests carry `X-Sandbox-Beacon: 1` and are not self-instrumented.

**DevTools helper.** `window.__sandbox` exposes `{ userId, sessionId, buffer, flush() }` for
inspection during a session.

## Storage schema (Deno KV)

Keys are arrays; values are JSON. Locally, KV is a SQLite file at `./data/kv.db` (gitignored). On
Deno Deploy, KV is managed and no file lives with the repo.

| Key                                               | Value           | Purpose                                |
| ------------------------------------------------- | --------------- | -------------------------------------- |
| `["user", userId]`                                | `UserRecord`    | Anonymous user; created lazily         |
| `["user_index", createdAt, userId]`               | `userId`        | Time-ordered scan of users             |
| `["session", sessionId]`                          | `SessionRecord` | Per-page-load session envelope         |
| `["session_index", createdAt, sessionId]`         | `sessionId`     | Time-ordered scan of all sessions      |
| `["session_by_user", userId, createdAt, session]` | `sessionId`     | Time-ordered scan of a user's sessions |
| `["event", sessionId, seq]`                       | `EventRecord`   | One instrumentation event              |

`SessionRecord` includes: `userId`, `sessionId`, `createdAt`, `lastSeenAt`, `lastEventAt`, `env`,
`pubkey`, `label`, `clientIp`, `eventCount`, `indexed`. `pubkey` and `label` are extracted from
`env.url`'s query string on first sight and never overwritten.

**Race handling.** If `/api/event` arrives before `/api/session` (e.g., due to network reordering),
the event handler creates a minimal session record and its index entries. A later `/api/session`
merges into that record and preserves the original `createdAt` — so index keys stay stable and no
duplicates are created.

**Bodies are never stored.** The client strips request/response bodies at the source; the server
just persists what it receives.

## Local KV inspection

Ad-hoc dump of the local KV file:

```sh
deno run --allow-read --allow-write --allow-env --unstable-kv - <<'EOF'
const kv = await Deno.openKv("./data/kv.db");
for await (const entry of kv.list({ prefix: [] })) {
  console.log(JSON.stringify({ key: entry.key, value: entry.value }));
}
EOF
```

## Roadmap

- [x] **1. Skeleton.** `Deno.serve` dispatcher; static files at `/`; 501 stubs for `/api/*`,
      `/admin`, `/session/:id`.
- [x] **2. Sandbox page.** Loads `uc-file-uploader` from CDN; config from query string;
      resolved-config JSON panel; variant switcher.
- [x] **3. Client instrumentation.** Monkey-patch `fetch` + XHR (metadata only — bodies stripped);
      subscribe to uploader lifecycle events; capture `window.onerror`, `unhandledrejection`,
      `console.warn/error`; `PerformanceObserver` for Uploadcare resource timings; in-memory
      buffer + periodic flush + `sendBeacon` on `pagehide`.
- [x] **4. Session/event API + KV storage.** `POST /api/session`, `POST /api/event`,
      `POST /api/event-beacon`. Persistent anonymous user ID (cookie + localStorage) + per-load
      session ID. KV schema: `user`, `user_index`, `session`, `session_by_user`, `session_index`,
      `event`.
- [x] **5. Public per-session view.** `/session/:id` — event timeline, filter tabs (All / Network /
      Errors / Uploader / Perf / Other), expandable rows, copy/download JSON. Backed by
      `GET /api/session/:id`.
- [x] **6. Admin dashboard.** `/admin` behind HTTP Basic Auth (`ADMIN_USER` / `ADMIN_PASS` env
      vars); session list with filters (userId, pubkey, label, hasError) and drill-down. A cookie
      session (KV-backed) also works for browsers that suppress the native Basic Auth prompt.
- [x] **7. Polish.** `sendBeacon` on unload wired through; resource-timing correlation on the
      session view (fetch/XHR rows get a `perf` badge and inline `_perf` timing); scenario presets
      via `?scenario=`; text search on the session timeline; session duration in the meta line;
      no-cache headers on static files in local dev.
- [x] **8. Environment + host reachability.** `static/lib/env.js` (baseline browser env + network
      conditions snapshot with a `navigator.connection.change` subscriber) and
      `static/lib/probes.js` (parallel HEAD reachability probes for `upload.uploadcare.com`,
      `api.uploadcare.com`, `ucarecdn.com`, `ucarecd.net`). Session view grows an "Environment"
      panel above the timeline that summarizes the snapshot and lists per-host reachability. New
      `env` category on the filter tab collects `probe-host`, `probe-summary`, and
      `env-network-change` events.
- [ ] **9. Deploy from GitHub.** Link the repo to Deno Deploy so pushes to `main` auto-deploy
      (removing the manual `deployctl deploy` step). Deferred until the repo is pushed.

## Design decisions

Small notes on choices that aren't obvious from the code:

- **Bodies are never stored.** Only request/response metadata — URL, method, status, headers
  (safelist), sizes, timings. Multipart chunks are file bytes we don't want; other bodies are
  stripped for simplicity and privacy.
- **HTTP Basic Auth for `/admin`.** Simpler than a login form and good enough for a
  support-team-only view. Credentials come from env vars.
- **Indefinite retention.** No auto-expiry — support cases can span months and disk is cheap. Manual
  purge is a future admin feature.
- **Persistent user ID + per-visit session.** Lets us group repeat-visit sessions from the same
  anonymous customer.
- **Single-file `main.ts`.** Kept flat until it hurts.
