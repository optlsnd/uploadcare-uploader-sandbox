import { serveDir } from "@std/http/file-server";

type Env = Record<string, unknown> | null;

export type SessionRecord = {
  userId: string;
  sessionId: string;
  createdAt: number;
  lastSeenAt: number;
  lastEventAt?: number;
  env: Env;
  pubkey: string | null;
  label: string | null;
  clientIp: string | null;
  eventCount: number;
  errorCount?: number;
  indexed: boolean;
};

export type AdminConfig = { user: string; pass: string } | null;

export type SessionListItem = {
  sessionId: string;
  userId: string;
  createdAt: number;
  lastEventAt: number | null;
  pubkey: string | null;
  label: string | null;
  eventCount: number;
  errorCount: number;
};

export type UserRecord = {
  userId: string;
  createdAt: number;
  lastSeenAt: number;
};

export type EventRecord = {
  ts: number;
  seq: number;
  kind: string;
  userId: string;
  sessionId: string;
  [key: string]: unknown;
};

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function readJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    const raw = await req.text();
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function clientIpOf(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? null;
}

function tryParseUrl(input: unknown): URL | null {
  if (typeof input !== "string") return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export async function upsertSession(
  kv: Deno.Kv,
  opts: {
    userId: string;
    sessionId: string;
    clientIp: string | null;
    env?: Env;
    providedCreatedAt?: number;
  },
): Promise<SessionRecord> {
  const { userId, sessionId, clientIp } = opts;
  const now = Date.now();

  const sessionKey = ["session", sessionId] as const;
  const userKey = ["user", userId] as const;

  const [existingSessionEntry, existingUserEntry] = await kv.getMany<
    [SessionRecord, UserRecord]
  >([sessionKey, userKey]);

  const existingSession = existingSessionEntry.value;
  const existingUser = existingUserEntry.value;

  const user: UserRecord = existingUser ?? {
    userId,
    createdAt: now,
    lastSeenAt: now,
  };
  user.lastSeenAt = now;

  let session: SessionRecord;
  if (existingSession) {
    session = existingSession;
    session.lastSeenAt = now;
    if (opts.env && !session.env) {
      session.env = opts.env;
      const url = tryParseUrl((opts.env as { url?: string })?.url);
      session.pubkey = url?.searchParams.get("pubkey") ?? session.pubkey;
      session.label = url?.searchParams.get("label") ?? session.label;
    }
    if (clientIp && !session.clientIp) session.clientIp = clientIp;
  } else {
    const createdAt = Number(opts.providedCreatedAt) || now;
    const url = tryParseUrl((opts.env as { url?: string })?.url);
    session = {
      userId,
      sessionId,
      createdAt,
      lastSeenAt: now,
      env: opts.env ?? null,
      pubkey: url?.searchParams.get("pubkey") ?? null,
      label: url?.searchParams.get("label") ?? null,
      clientIp,
      eventCount: 0,
      indexed: false,
    };
  }

  const tx = kv.atomic();
  tx.set(userKey, user);
  tx.set(sessionKey, session);
  if (!existingUser) {
    tx.set(["user_index", user.createdAt, userId], userId);
  }
  if (!session.indexed) {
    tx.set(["session_index", session.createdAt, sessionId], sessionId);
    tx.set(["session_by_user", userId, session.createdAt, sessionId], sessionId);
    session.indexed = true;
    tx.set(sessionKey, session);
  }
  const res = await tx.commit();
  if (!res.ok) throw new Error("kv atomic commit failed");
  return session;
}

export async function handleSessionPost(
  kv: Deno.Kv,
  req: Request,
): Promise<Response> {
  const body = await readJson<{
    userId?: string;
    sessionId?: string;
    startedAt?: number;
    env?: Env;
  }>(req);
  if (!body?.userId || !body?.sessionId) {
    return json({ error: "userId and sessionId required" }, { status: 400 });
  }
  const session = await upsertSession(kv, {
    userId: body.userId,
    sessionId: body.sessionId,
    clientIp: clientIpOf(req),
    env: body.env ?? null,
    providedCreatedAt: body.startedAt,
  });
  return json({ ok: true, session });
}

function isErrorEvent(ev: EventRecord): boolean {
  const kind = ev.kind;
  if (kind === "js-error" || kind === "unhandled-rejection") return true;
  if (kind === "fetch-error" || kind === "xhr-error") return true;
  if (kind === "console" && (ev as { level?: unknown }).level === "error") return true;
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": 'Basic realm="Uploader Sandbox Admin"',
    },
  });
}

function adminNotConfigured(): Response {
  return new Response(
    "Admin not configured — set ADMIN_USER and ADMIN_PASS env vars.\n",
    { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

const ADMIN_SESSION_COOKIE = "admin-session";
const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type AdminSessionRecord = { user: string; createdAt: number; expiresAt: number };

function getCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function createAdminSession(kv: Deno.Kv, user: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await kv.set(
    ["admin_session", token],
    {
      user,
      createdAt: now,
      expiresAt: now + ADMIN_SESSION_TTL_MS,
    } satisfies AdminSessionRecord,
  );
  return token;
}

async function readAdminSession(
  kv: Deno.Kv,
  token: string,
): Promise<AdminSessionRecord | null> {
  const entry = await kv.get<AdminSessionRecord>(["admin_session", token]);
  if (!entry.value) return null;
  if (entry.value.expiresAt < Date.now()) {
    await kv.delete(["admin_session", token]);
    return null;
  }
  return entry.value;
}

export async function deleteAdminSession(kv: Deno.Kv, token: string): Promise<void> {
  await kv.delete(["admin_session", token]);
}

function sessionCookieAttrs(token: string, req: Request, maxAgeSec: number): string {
  const secure = new URL(req.url).protocol === "https:";
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Returns null when the request is authorized, or a Response to return
 * to the client (401 for missing/wrong creds, 503 when admin isn't
 * configured on this server). Accepts either a valid session cookie or
 * HTTP Basic Auth credentials.
 */
export async function checkAdminAuth(
  kv: Deno.Kv,
  req: Request,
  admin: AdminConfig,
): Promise<Response | null> {
  if (!admin) return adminNotConfigured();

  const token = getCookie(req, ADMIN_SESSION_COOKIE);
  if (token) {
    const session = await readAdminSession(kv, token);
    if (session) return null;
  }

  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(auth.slice(6).trim());
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        const user = decoded.slice(0, idx);
        const pass = decoded.slice(idx + 1);
        if (timingSafeEqual(user, admin.user) && timingSafeEqual(pass, admin.pass)) {
          return null;
        }
      }
    } catch {
      /* fall through to 401 */
    }
  }

  return unauthorized();
}

function safeNextPath(next: unknown): string {
  if (typeof next !== "string") return "/admin";
  if (!next.startsWith("/") || next.startsWith("//")) return "/admin";
  return next;
}

export async function handleAdminLoginPost(
  kv: Deno.Kv,
  req: Request,
  admin: AdminConfig,
): Promise<Response> {
  if (!admin) return adminNotConfigured();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const user = String(form.get("user") ?? "");
  const pass = String(form.get("pass") ?? "");
  const next = safeNextPath(form.get("next"));
  const okUser = timingSafeEqual(user, admin.user);
  const okPass = timingSafeEqual(pass, admin.pass);
  if (!okUser || !okPass) {
    const dest = new URL("/admin/login", req.url);
    dest.searchParams.set("error", "1");
    dest.searchParams.set("next", next);
    return Response.redirect(dest, 303);
  }
  const token = await createAdminSession(kv, user);
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      "set-cookie": sessionCookieAttrs(
        token,
        req,
        Math.floor(ADMIN_SESSION_TTL_MS / 1000),
      ),
    },
  });
}

export async function handleAdminLogoutPost(
  kv: Deno.Kv,
  req: Request,
): Promise<Response> {
  const token = getCookie(req, ADMIN_SESSION_COOKIE);
  if (token) await deleteAdminSession(kv, token);
  return new Response(null, {
    status: 303,
    headers: {
      location: "/admin/login",
      "set-cookie": sessionCookieAttrs("", req, 0),
    },
  });
}

export type SessionFilters = {
  userId: string | null;
  pubkey: string | null;
  label: string | null;
  hasError: boolean;
};

export function readSessionFilters(url: URL): SessionFilters {
  return {
    userId: url.searchParams.get("userId"),
    pubkey: url.searchParams.get("pubkey"),
    label: url.searchParams.get("label"),
    hasError: url.searchParams.get("hasError") === "true",
  };
}

export function matchesSessionFilter(s: SessionRecord, f: SessionFilters): boolean {
  if (f.userId && s.userId !== f.userId) return false;
  if (f.pubkey && s.pubkey !== f.pubkey) return false;
  if (f.label && s.label !== f.label) return false;
  if (f.hasError && (s.errorCount ?? 0) === 0) return false;
  return true;
}

export async function handleAdminSessions(
  kv: Deno.Kv,
  url: URL,
): Promise<Response> {
  const limit = Math.min(
    500,
    Math.max(1, Number(url.searchParams.get("limit") ?? 200)),
  );
  const filters = readSessionFilters(url);

  const sessions: SessionListItem[] = [];
  for await (
    const idxEntry of kv.list<string>({ prefix: ["session_index"] }, {
      reverse: true,
      limit,
    })
  ) {
    const s = await kv.get<SessionRecord>(["session", idxEntry.value]);
    if (!s.value) continue;
    const session = s.value;
    if (!matchesSessionFilter(session, filters)) continue;
    sessions.push({
      sessionId: session.sessionId,
      userId: session.userId,
      createdAt: session.createdAt,
      lastEventAt: session.lastEventAt ?? null,
      pubkey: session.pubkey,
      label: session.label,
      eventCount: session.eventCount,
      errorCount: session.errorCount ?? 0,
    });
  }
  return json({ sessions });
}

/**
 * For a given session, return the sessionIds that appear immediately
 * before and after it in the newest-first admin listing under the
 * supplied filters. "prev" = one row up in the table (newer),
 * "next" = one row down (older).
 *
 * The target session is always considered a member of the list even if
 * it doesn't itself match the filters — otherwise viewing a session
 * that has been filtered out would have no navigation context.
 */
export async function handleAdminSessionNeighbors(
  kv: Deno.Kv,
  sessionId: string,
  filters: SessionFilters,
): Promise<Response> {
  const target = await kv.get<SessionRecord>(["session", sessionId]);
  if (!target.value) return json({ error: "session not found" }, { status: 404 });

  let prev: string | null = null;
  let next: string | null = null;
  let foundTarget = false;
  let lastMatch: string | null = null;

  for await (
    const idxEntry of kv.list<string>({ prefix: ["session_index"] }, {
      reverse: true,
      limit: 1000,
    })
  ) {
    const sid = idxEntry.value;
    const isTarget = sid === sessionId;
    if (!isTarget) {
      const s = await kv.get<SessionRecord>(["session", sid]);
      if (!s.value) continue;
      if (!matchesSessionFilter(s.value, filters)) continue;
    }
    if (foundTarget) {
      next = sid;
      break;
    }
    if (isTarget) {
      foundTarget = true;
      prev = lastMatch;
    } else {
      lastMatch = sid;
    }
  }

  return json({ prev, next });
}

export async function handleSessionGet(
  kv: Deno.Kv,
  sessionId: string,
): Promise<Response> {
  const entry = await kv.get<SessionRecord>(["session", sessionId]);
  if (!entry.value) return json({ error: "session not found" }, { status: 404 });
  const events: EventRecord[] = [];
  for await (const e of kv.list<EventRecord>({ prefix: ["event", sessionId] })) {
    events.push(e.value);
  }
  return json({ session: entry.value, events });
}

export async function handleEventPost(
  kv: Deno.Kv,
  req: Request,
): Promise<Response> {
  const body = await readJson<{
    userId?: string;
    sessionId?: string;
    events?: EventRecord[];
  }>(req);
  if (!body?.userId || !body?.sessionId) {
    return json({ error: "userId and sessionId required" }, { status: 400 });
  }
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) return json({ ok: true, stored: 0 });

  const session = await upsertSession(kv, {
    userId: body.userId,
    sessionId: body.sessionId,
    clientIp: clientIpOf(req),
  });

  let maxSeq = session.eventCount - 1;
  let stored = 0;
  let errorsInBatch = 0;
  const tx = kv.atomic();
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const seq = Number((ev as { seq?: unknown }).seq);
    if (!Number.isFinite(seq)) continue;
    tx.set(["event", body.sessionId, seq], ev);
    if (seq > maxSeq) maxSeq = seq;
    if (isErrorEvent(ev)) errorsInBatch++;
    stored++;
  }
  if (stored > 0) {
    session.eventCount = Math.max(session.eventCount, maxSeq + 1);
    session.errorCount = (session.errorCount ?? 0) + errorsInBatch;
    session.lastEventAt = Date.now();
    tx.set(["session", body.sessionId], session);
    const res = await tx.commit();
    if (!res.ok) {
      return json({ error: "kv atomic commit failed" }, { status: 500 });
    }
  }
  return json({ ok: true, stored });
}

/**
 * Prevent aggressive browser caching of static assets. On Deno Deploy
 * this only fires for local dev — on Deploy, its CDN adds its own
 * caching layer that overrides no-cache when appropriate.
 */
function withNoCache(res: Response): Response {
  if (Deno.env.get("DENO_DEPLOYMENT_ID")) return res;
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store, must-revalidate");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function notImplemented(label: string): Response {
  return new Response(`${label} — not implemented yet\n`, {
    status: 501,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

const SESSION_API_RE = /^\/api\/session\/([^/]+)$/;
const ADMIN_NEIGHBORS_RE = /^\/api\/admin\/session\/([^/]+)\/neighbors$/;
const SESSION_VIEW_RE = /^\/session\/([^/]+)$/;

export function createHandler(
  kv: Deno.Kv,
  admin: AdminConfig = null,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "POST" && pathname === "/api/session") {
      return handleSessionPost(kv, req);
    }
    if (
      req.method === "POST" &&
      (pathname === "/api/event" || pathname === "/api/event-beacon")
    ) {
      return handleEventPost(kv, req);
    }
    const apiSessionMatch = pathname.match(SESSION_API_RE);
    if (req.method === "GET" && apiSessionMatch) {
      return handleSessionGet(kv, apiSessionMatch[1]!);
    }
    if (req.method === "GET" && pathname === "/api/admin/sessions") {
      const denied = await checkAdminAuth(kv, req, admin);
      if (denied) return denied;
      return handleAdminSessions(kv, url);
    }
    const neighborsMatch = pathname.match(ADMIN_NEIGHBORS_RE);
    if (req.method === "GET" && neighborsMatch) {
      const denied = await checkAdminAuth(kv, req, admin);
      if (denied) return denied;
      return handleAdminSessionNeighbors(
        kv,
        neighborsMatch[1]!,
        readSessionFilters(url),
      );
    }
    if (pathname.startsWith("/api/")) return notImplemented(`API ${pathname}`);
    if (pathname === "/admin/login") {
      if (req.method === "POST") return handleAdminLoginPost(kv, req, admin);
      const rewritten = new Request(new URL("/admin-login.html", req.url), req);
      return withNoCache(await serveDir(rewritten, { fsRoot: "static", urlRoot: "", quiet: true }));
    }
    if (pathname === "/admin/logout" && req.method === "POST") {
      return handleAdminLogoutPost(kv, req);
    }
    if (pathname === "/admin" || pathname === "/admin/") {
      const denied = await checkAdminAuth(kv, req, admin);
      if (denied) {
        if (denied.status === 401) {
          return Response.redirect(new URL("/admin/login", req.url), 303);
        }
        return denied;
      }
      const rewritten = new Request(new URL("/admin.html", req.url), req);
      return withNoCache(await serveDir(rewritten, { fsRoot: "static", urlRoot: "", quiet: true }));
    }
    if (pathname.match(SESSION_VIEW_RE)) {
      const rewritten = new Request(new URL("/session.html", req.url), req);
      return withNoCache(await serveDir(rewritten, { fsRoot: "static", urlRoot: "", quiet: true }));
    }

    return withNoCache(await serveDir(req, { fsRoot: "static", urlRoot: "", quiet: true }));
  };
}

if (import.meta.main) {
  const PORT = Number(Deno.env.get("PORT") ?? 8000);
  const KV_PATH = Deno.env.get("DENO_DEPLOYMENT_ID")
    ? undefined
    : (Deno.env.get("KV_PATH") ?? "./data/kv.db");
  if (KV_PATH) {
    const slash = KV_PATH.lastIndexOf("/");
    if (slash > 0) await Deno.mkdir(KV_PATH.slice(0, slash), { recursive: true });
  }
  const kv = await Deno.openKv(KV_PATH);
  const adminUser = Deno.env.get("ADMIN_USER");
  const adminPass = Deno.env.get("ADMIN_PASS");
  const admin: AdminConfig = adminUser && adminPass ? { user: adminUser, pass: adminPass } : null;
  if (!admin) {
    console.warn("ADMIN_USER / ADMIN_PASS not set — /admin is disabled");
  }
  Deno.serve({ port: PORT }, createHandler(kv, admin));
}
