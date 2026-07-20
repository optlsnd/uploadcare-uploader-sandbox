import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import {
  type AdminConfig,
  checkAdminAuth,
  createAdminSession,
  createHandler,
  handleAdminLoginPost,
  handleAdminLogoutPost,
  handleAdminSessionNeighbors,
  handleAdminSessions,
  handleEventPost,
  handleSessionPost,
  matchesSessionFilter,
  readSessionFilters,
  type SessionFilters,
  type SessionRecord,
} from "../main.ts";

const ADMIN: AdminConfig = { user: "admin", pass: "s3cret" };

function cookieFor(token: string): string {
  return `admin-session=${token}`;
}

function parseSetCookie(res: Response): { name: string; value: string; attrs: string[] } | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const [pair, ...attrs] = raw.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

function form(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields).toString();
  return new Request("http://localhost/admin/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function withKv<T>(fn: (kv: Deno.Kv) => Promise<T>): Promise<T> {
  const kv = await Deno.openKv(":memory:");
  try {
    return await fn(kv);
  } finally {
    kv.close();
  }
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function basicAuth(user: string, pass: string): string {
  return "Basic " + btoa(`${user}:${pass}`);
}

/* -------- checkAdminAuth -------- */

Deno.test("checkAdminAuth: null admin config → 503", async () => {
  await withKv(async (kv) => {
    const res = await checkAdminAuth(kv, new Request("http://x/admin"), null);
    assert(res);
    assertEquals(res!.status, 503);
  });
});

Deno.test("checkAdminAuth: missing Authorization header → 401 with WWW-Authenticate", async () => {
  await withKv(async (kv) => {
    const res = await checkAdminAuth(kv, new Request("http://x/admin"), ADMIN);
    assert(res);
    assertEquals(res!.status, 401);
    assert(res!.headers.get("www-authenticate")?.startsWith("Basic "));
  });
});

Deno.test("checkAdminAuth: wrong password → 401", async () => {
  await withKv(async (kv) => {
    const res = await checkAdminAuth(
      kv,
      new Request("http://x/admin", {
        headers: { authorization: basicAuth("admin", "wrong") },
      }),
      ADMIN,
    );
    assertEquals(res?.status, 401);
  });
});

Deno.test("checkAdminAuth: wrong user → 401", async () => {
  await withKv(async (kv) => {
    const res = await checkAdminAuth(
      kv,
      new Request("http://x/admin", {
        headers: { authorization: basicAuth("root", "s3cret") },
      }),
      ADMIN,
    );
    assertEquals(res?.status, 401);
  });
});

Deno.test("checkAdminAuth: correct Basic creds → null (authorized)", async () => {
  await withKv(async (kv) => {
    const res = await checkAdminAuth(
      kv,
      new Request("http://x/admin", {
        headers: { authorization: basicAuth("admin", "s3cret") },
      }),
      ADMIN,
    );
    assertEquals(res, null);
  });
});

Deno.test("checkAdminAuth: valid session cookie → null (authorized)", async () => {
  await withKv(async (kv) => {
    const token = await createAdminSession(kv, "admin");
    const res = await checkAdminAuth(
      kv,
      new Request("http://x/admin", { headers: { cookie: cookieFor(token) } }),
      ADMIN,
    );
    assertEquals(res, null);
  });
});

Deno.test("checkAdminAuth: unknown session cookie → 401", async () => {
  await withKv(async (kv) => {
    const res = await checkAdminAuth(
      kv,
      new Request("http://x/admin", { headers: { cookie: cookieFor("bogus-token") } }),
      ADMIN,
    );
    assertEquals(res?.status, 401);
  });
});

Deno.test("checkAdminAuth: malformed Authorization (not Basic) → 401", async () => {
  await withKv(async (kv) => {
    const res = await checkAdminAuth(
      kv,
      new Request("http://x/admin", { headers: { authorization: "Bearer sometoken" } }),
      ADMIN,
    );
    assertEquals(res?.status, 401);
  });
});

Deno.test("checkAdminAuth: malformed base64 → 401", async () => {
  await withKv(async (kv) => {
    const res = await checkAdminAuth(
      kv,
      new Request("http://x/admin", { headers: { authorization: "Basic !!!not-base64!!!" } }),
      ADMIN,
    );
    assertEquals(res?.status, 401);
  });
});

/* -------- Login form flow -------- */

Deno.test("handleAdminLoginPost: correct creds → 303 + Set-Cookie", async () => {
  await withKv(async (kv) => {
    const res = await handleAdminLoginPost(
      kv,
      form({ user: "admin", pass: "s3cret", next: "/admin" }),
      ADMIN,
    );
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), "/admin");
    const cookie = parseSetCookie(res);
    assert(cookie);
    assertEquals(cookie!.name, "admin-session");
    assert(cookie!.value.length >= 32);
    assert(cookie!.attrs.includes("HttpOnly"));
    assert(cookie!.attrs.includes("SameSite=Lax"));
    assert(cookie!.attrs.includes("Path=/"));
    // The token from Set-Cookie must round-trip to an authorized session.
    const auth = await checkAdminAuth(
      kv,
      new Request("http://x/admin", { headers: { cookie: cookieFor(cookie!.value) } }),
      ADMIN,
    );
    assertEquals(auth, null);
  });
});

Deno.test("handleAdminLoginPost: wrong creds → 303 to /admin/login?error=1", async () => {
  await withKv(async (kv) => {
    const res = await handleAdminLoginPost(
      kv,
      form({ user: "admin", pass: "nope" }),
      ADMIN,
    );
    assertEquals(res.status, 303);
    const loc = res.headers.get("location") ?? "";
    assert(loc.includes("/admin/login"));
    assert(loc.includes("error=1"));
    assertEquals(parseSetCookie(res), null);
  });
});

Deno.test("handleAdminLoginPost: open-redirect protection on next=", async () => {
  await withKv(async (kv) => {
    const res = await handleAdminLoginPost(
      kv,
      form({ user: "admin", pass: "s3cret", next: "//evil.example.com/" }),
      ADMIN,
    );
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), "/admin");
  });
});

Deno.test("handleAdminLoginPost: relative next= is honored", async () => {
  await withKv(async (kv) => {
    const res = await handleAdminLoginPost(
      kv,
      form({ user: "admin", pass: "s3cret", next: "/admin?pubkey=abc" }),
      ADMIN,
    );
    assertEquals(res.headers.get("location"), "/admin?pubkey=abc");
  });
});

Deno.test("handleAdminLoginPost: no admin config → 503", async () => {
  await withKv(async (kv) => {
    const res = await handleAdminLoginPost(kv, form({ user: "x", pass: "y" }), null);
    assertEquals(res.status, 503);
    await res.body?.cancel();
  });
});

Deno.test("handleAdminLogoutPost: clears cookie and invalidates session", async () => {
  await withKv(async (kv) => {
    const token = await createAdminSession(kv, "admin");
    const req = new Request("http://x/admin/logout", {
      method: "POST",
      headers: { cookie: cookieFor(token) },
    });
    const res = await handleAdminLogoutPost(kv, req);
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), "/admin/login");
    const cookie = parseSetCookie(res);
    assert(cookie);
    assert(cookie!.attrs.includes("Max-Age=0"));
    // Session should be deleted from KV.
    const session = await kv.get(["admin_session", token]);
    assertEquals(session.value, null);
  });
});

/* -------- handleAdminSessions -------- */

async function seedSessions(kv: Deno.Kv) {
  await handleSessionPost(
    kv,
    post("/api/session", {
      userId: "u1",
      sessionId: "s1",
      env: { url: "http://x/?pubkey=pk1&label=lbl-a" },
    }),
  );
  await handleSessionPost(
    kv,
    post("/api/session", {
      userId: "u2",
      sessionId: "s2",
      env: { url: "http://x/?pubkey=pk2&label=lbl-b" },
    }),
  );
  await handleSessionPost(
    kv,
    post("/api/session", {
      userId: "u1",
      sessionId: "s3",
      env: { url: "http://x/?pubkey=pk1" },
    }),
  );
  // Give s2 an error event
  await handleEventPost(
    kv,
    post("/api/event", {
      userId: "u2",
      sessionId: "s2",
      events: [
        { seq: 0, ts: 1, kind: "fetch", status: 200 },
        { seq: 1, ts: 2, kind: "js-error", message: "boom" },
      ],
    }),
  );
  // Give s1 an xhr-error
  await handleEventPost(
    kv,
    post("/api/event", {
      userId: "u1",
      sessionId: "s1",
      events: [{ seq: 0, ts: 5, kind: "xhr-error", error: "network" }],
    }),
  );
}

Deno.test("handleAdminSessions: lists newest-first", async () => {
  await withKv(async (kv) => {
    await seedSessions(kv);
    const res = await handleAdminSessions(kv, new URL("http://x/api/admin/sessions"));
    assertEquals(res.status, 200);
    const body = await res.json();
    const ids = body.sessions.map((s: { sessionId: string }) => s.sessionId);
    // s3 was created last, so it should be first
    assertEquals(ids[0], "s3");
    assertEquals(ids.length, 3);
  });
});

Deno.test("handleAdminSessions: userId filter", async () => {
  await withKv(async (kv) => {
    await seedSessions(kv);
    const res = await handleAdminSessions(
      kv,
      new URL("http://x/api/admin/sessions?userId=u1"),
    );
    const body = await res.json();
    const ids = body.sessions.map((s: { sessionId: string }) => s.sessionId).sort();
    assertEquals(ids, ["s1", "s3"]);
  });
});

Deno.test("handleAdminSessions: pubkey filter", async () => {
  await withKv(async (kv) => {
    await seedSessions(kv);
    const res = await handleAdminSessions(
      kv,
      new URL("http://x/api/admin/sessions?pubkey=pk2"),
    );
    const body = await res.json();
    assertEquals(body.sessions.length, 1);
    assertEquals(body.sessions[0].sessionId, "s2");
  });
});

Deno.test("handleAdminSessions: label filter", async () => {
  await withKv(async (kv) => {
    await seedSessions(kv);
    const res = await handleAdminSessions(
      kv,
      new URL("http://x/api/admin/sessions?label=lbl-a"),
    );
    const body = await res.json();
    assertEquals(body.sessions.length, 1);
    assertEquals(body.sessions[0].sessionId, "s1");
  });
});

Deno.test("handleAdminSessions: hasError=true filter", async () => {
  await withKv(async (kv) => {
    await seedSessions(kv);
    const res = await handleAdminSessions(
      kv,
      new URL("http://x/api/admin/sessions?hasError=true"),
    );
    const body = await res.json();
    const ids = body.sessions.map((s: { sessionId: string }) => s.sessionId).sort();
    assertEquals(ids, ["s1", "s2"]);
    for (const s of body.sessions) assert(s.errorCount > 0);
  });
});

Deno.test("handleAdminSessions: session with no errors has errorCount 0", async () => {
  await withKv(async (kv) => {
    await seedSessions(kv);
    const res = await handleAdminSessions(kv, new URL("http://x/api/admin/sessions"));
    const body = await res.json();
    const s3 = body.sessions.find((s: { sessionId: string }) => s.sessionId === "s3");
    assertEquals(s3.errorCount, 0);
  });
});

Deno.test("handleAdminSessions: limit clamped to 500", async () => {
  await withKv(async (kv) => {
    await seedSessions(kv);
    const res = await handleAdminSessions(
      kv,
      new URL("http://x/api/admin/sessions?limit=9999"),
    );
    assertEquals(res.status, 200);
  });
});

/* -------- errorCount tracking -------- */

Deno.test("handleEventPost: bumps errorCount for error kinds", async () => {
  await withKv(async (kv) => {
    await handleSessionPost(kv, post("/api/session", { userId: "u", sessionId: "s", env: {} }));
    await handleEventPost(
      kv,
      post("/api/event", {
        userId: "u",
        sessionId: "s",
        events: [
          { seq: 0, ts: 1, kind: "fetch", status: 200 },
          { seq: 1, ts: 2, kind: "js-error", message: "x" },
          { seq: 2, ts: 3, kind: "console", level: "error", args: ["boom"] },
          { seq: 3, ts: 4, kind: "console", level: "warn", args: ["notice"] },
          { seq: 4, ts: 5, kind: "unhandled-rejection", reason: "y" },
        ],
      }),
    );
    const s = await kv.get(["session", "s"]);
    assertEquals((s.value as { errorCount: number }).errorCount, 3);
  });
});

/* -------- createHandler routing for admin -------- */

Deno.test("createHandler: /admin without config → 503", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(kv);
    const res = await handler(new Request("http://x/admin"));
    assertEquals(res.status, 503);
    await res.body?.cancel();
  });
});

Deno.test("createHandler: /admin without creds → 303 redirect to /admin/login", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(kv, ADMIN);
    const res = await handler(new Request("http://x/admin"));
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), "http://x/admin/login");
    await res.body?.cancel();
  });
});

Deno.test("createHandler: /api/admin/sessions without creds → 401 (still)", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(kv, ADMIN);
    const res = await handler(new Request("http://x/api/admin/sessions"));
    assertEquals(res.status, 401);
    await res.body?.cancel();
  });
});

Deno.test("createHandler: /admin with session cookie → 200 HTML", async () => {
  await withKv(async (kv) => {
    const token = await createAdminSession(kv, "admin");
    const handler = createHandler(kv, ADMIN);
    const res = await handler(
      new Request("http://x/admin", { headers: { cookie: cookieFor(token) } }),
    );
    assertEquals(res.status, 200);
    assert((res.headers.get("content-type") ?? "").includes("text/html"));
    await res.body?.cancel();
  });
});

Deno.test("createHandler: GET /admin/login serves login shell", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(kv, ADMIN);
    const res = await handler(new Request("http://x/admin/login"));
    assertEquals(res.status, 200);
    assert((res.headers.get("content-type") ?? "").includes("text/html"));
    await res.body?.cancel();
  });
});

Deno.test("createHandler: /admin with creds → 200 HTML", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(kv, ADMIN);
    const res = await handler(
      new Request("http://x/admin", {
        headers: { authorization: basicAuth("admin", "s3cret") },
      }),
    );
    assertEquals(res.status, 200);
    assert((res.headers.get("content-type") ?? "").includes("text/html"));
    await res.body?.cancel();
  });
});

Deno.test("createHandler: /api/admin/sessions gated by auth", async () => {
  await withKv(async (kv) => {
    await seedSessions(kv);
    const handler = createHandler(kv, ADMIN);
    const unauth = await handler(new Request("http://x/api/admin/sessions"));
    assertEquals(unauth.status, 401);
    await unauth.body?.cancel();
    const authed = await handler(
      new Request("http://x/api/admin/sessions", {
        headers: { authorization: basicAuth("admin", "s3cret") },
      }),
    );
    assertEquals(authed.status, 200);
    const body = await authed.json();
    assertEquals(body.sessions.length, 3);
  });
});

Deno.test("createHandler: /admin.js is public (no auth required)", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(kv, ADMIN);
    const res = await handler(new Request("http://x/admin.js"));
    assertEquals(res.status, 200);
    assertFalse(res.headers.get("content-type")?.includes("text/html"));
    await res.body?.cancel();
  });
});

/* -------- readSessionFilters / matchesSessionFilter -------- */

Deno.test("readSessionFilters: pulls every filter out of the query string", () => {
  const f = readSessionFilters(
    new URL("http://x/api/admin/sessions?userId=u&pubkey=p&label=l&hasError=true"),
  );
  assertEquals(f.userId, "u");
  assertEquals(f.pubkey, "p");
  assertEquals(f.label, "l");
  assertEquals(f.hasError, true);
});

Deno.test("readSessionFilters: hasError only true when literal 'true'", () => {
  assertEquals(
    readSessionFilters(new URL("http://x/?hasError=1")).hasError,
    false,
  );
  assertEquals(
    readSessionFilters(new URL("http://x/?hasError=false")).hasError,
    false,
  );
});

Deno.test("matchesSessionFilter: predicate honors each field", () => {
  const s: SessionRecord = {
    userId: "u1",
    sessionId: "s1",
    createdAt: 1,
    lastSeenAt: 1,
    env: null,
    pubkey: "pk",
    label: "lbl",
    clientIp: null,
    eventCount: 3,
    errorCount: 2,
    indexed: true,
  };
  const none: SessionFilters = { userId: null, pubkey: null, label: null, hasError: false };
  assertEquals(matchesSessionFilter(s, none), true);
  assertEquals(
    matchesSessionFilter(s, { ...none, userId: "u1" }),
    true,
  );
  assertEquals(
    matchesSessionFilter(s, { ...none, userId: "u2" }),
    false,
  );
  assertEquals(
    matchesSessionFilter({ ...s, errorCount: 0 }, { ...none, hasError: true }),
    false,
  );
  assertEquals(
    matchesSessionFilter(s, { ...none, hasError: true }),
    true,
  );
});

/* -------- handleAdminSessionNeighbors -------- */

async function seedNeighborsSessions(kv: Deno.Kv) {
  // Create three sessions with monotonic startedAt so ordering is deterministic.
  // Session A: oldest; B: middle; C: newest. Only B has errors.
  await handleSessionPost(
    kv,
    post("/api/session", {
      userId: "u1",
      sessionId: "sA",
      startedAt: 1000,
      env: { url: "http://x/?pubkey=pk" },
    }),
  );
  await handleSessionPost(
    kv,
    post("/api/session", {
      userId: "u2",
      sessionId: "sB",
      startedAt: 2000,
      env: { url: "http://x/?pubkey=pk" },
    }),
  );
  await handleEventPost(
    kv,
    post("/api/event", {
      userId: "u2",
      sessionId: "sB",
      events: [{ seq: 0, ts: 1, kind: "js-error" }],
    }),
  );
  await handleSessionPost(
    kv,
    post("/api/session", {
      userId: "u1",
      sessionId: "sC",
      startedAt: 3000,
      env: { url: "http://x/?pubkey=pk" },
    }),
  );
}

Deno.test("handleAdminSessionNeighbors: 404 for missing session", async () => {
  await withKv(async (kv) => {
    const res = await handleAdminSessionNeighbors(kv, "nope", {
      userId: null,
      pubkey: null,
      label: null,
      hasError: false,
    });
    assertEquals(res.status, 404);
  });
});

Deno.test("handleAdminSessionNeighbors: no filters — prev is newer, next is older", async () => {
  await withKv(async (kv) => {
    await seedNeighborsSessions(kv);
    const none: SessionFilters = { userId: null, pubkey: null, label: null, hasError: false };
    // sB is in the middle: prev (newer) = sC, next (older) = sA
    const middle = await (await handleAdminSessionNeighbors(kv, "sB", none)).json();
    assertEquals(middle.prev, "sC");
    assertEquals(middle.next, "sA");
    // sC is newest: no prev, next = sB
    const newest = await (await handleAdminSessionNeighbors(kv, "sC", none)).json();
    assertEquals(newest.prev, null);
    assertEquals(newest.next, "sB");
    // sA is oldest: prev = sB, no next
    const oldest = await (await handleAdminSessionNeighbors(kv, "sA", none)).json();
    assertEquals(oldest.prev, "sB");
    assertEquals(oldest.next, null);
  });
});

Deno.test("handleAdminSessionNeighbors: honors userId filter", async () => {
  await withKv(async (kv) => {
    await seedNeighborsSessions(kv);
    const f: SessionFilters = { userId: "u1", pubkey: null, label: null, hasError: false };
    // Filtered order: sC, sA (u1 only). sB is not in the set.
    const res = await (await handleAdminSessionNeighbors(kv, "sA", f)).json();
    assertEquals(res.prev, "sC");
    assertEquals(res.next, null);
  });
});

Deno.test("handleAdminSessionNeighbors: honors hasError filter", async () => {
  await withKv(async (kv) => {
    await seedNeighborsSessions(kv);
    const f: SessionFilters = { userId: null, pubkey: null, label: null, hasError: true };
    // Only sB matches. Viewed from sB: no neighbors.
    const res = await (await handleAdminSessionNeighbors(kv, "sB", f)).json();
    assertEquals(res.prev, null);
    assertEquals(res.next, null);
  });
});

Deno.test("handleAdminSessionNeighbors: target still navigable even if it doesn't match filter", async () => {
  await withKv(async (kv) => {
    await seedNeighborsSessions(kv);
    const f: SessionFilters = { userId: null, pubkey: null, label: null, hasError: true };
    // From sA (no errors) with hasError filter: only sB matches. sA
    // becomes the "current" and its prev is sB.
    const res = await (await handleAdminSessionNeighbors(kv, "sA", f)).json();
    assertEquals(res.prev, "sB");
    assertEquals(res.next, null);
  });
});

Deno.test("createHandler: GET /api/admin/session/:id/neighbors gated by auth", async () => {
  await withKv(async (kv) => {
    await seedNeighborsSessions(kv);
    const handler = createHandler(kv, ADMIN);
    const unauth = await handler(new Request("http://x/api/admin/session/sB/neighbors"));
    assertEquals(unauth.status, 401);
    await unauth.body?.cancel();
    const authed = await handler(
      new Request("http://x/api/admin/session/sB/neighbors", {
        headers: { authorization: basicAuth("admin", "s3cret") },
      }),
    );
    assertEquals(authed.status, 200);
    const body = await authed.json();
    assertEquals(body.prev, "sC");
    assertEquals(body.next, "sA");
  });
});

/* -------- DELETE /api/admin/session/:id -------- */

Deno.test("DELETE session removes record, events, and both indexes", async () => {
  await withKv(async (kv) => {
    await handleSessionPost(
      kv,
      post("/api/session", {
        userId: "u1",
        sessionId: "sX",
        env: { url: "http://x/?pubkey=pk" },
      }),
    );
    await handleEventPost(
      kv,
      post("/api/event", {
        userId: "u1",
        sessionId: "sX",
        events: [
          { seq: 0, ts: 1, kind: "fetch", status: 200 },
          { seq: 1, ts: 2, kind: "js-error", message: "x" },
        ],
      }),
    );

    const session = (await kv.get<SessionRecord>(["session", "sX"])).value;
    assert(session);
    const handler = createHandler(kv, ADMIN);
    const res = await handler(
      new Request("http://x/api/admin/session/sX", {
        method: "DELETE",
        headers: { authorization: basicAuth("admin", "s3cret") },
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(body.deletedEvents, 2);

    // Session gone
    const gone = await kv.get(["session", "sX"]);
    assertEquals(gone.value, null);
    // Events gone
    let leftover = 0;
    for await (const _ of kv.list({ prefix: ["event", "sX"] })) leftover++;
    assertEquals(leftover, 0);
    // Index rows gone
    const idx = await kv.get(["session_index", session!.createdAt, "sX"]);
    assertEquals(idx.value, null);
    const userIdx = await kv.get(["session_by_user", "u1", session!.createdAt, "sX"]);
    assertEquals(userIdx.value, null);
  });
});

Deno.test("DELETE session that doesn't exist → 404", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(kv, ADMIN);
    const res = await handler(
      new Request("http://x/api/admin/session/nope", {
        method: "DELETE",
        headers: { authorization: basicAuth("admin", "s3cret") },
      }),
    );
    assertEquals(res.status, 404);
    await res.body?.cancel();
  });
});

Deno.test("DELETE session without auth → 401", async () => {
  await withKv(async (kv) => {
    await handleSessionPost(
      kv,
      post("/api/session", { userId: "u1", sessionId: "sX", env: {} }),
    );
    const handler = createHandler(kv, ADMIN);
    const res = await handler(
      new Request("http://x/api/admin/session/sX", { method: "DELETE" }),
    );
    assertEquals(res.status, 401);
    await res.body?.cancel();
    // Session must still exist
    const s = await kv.get(["session", "sX"]);
    assert(s.value);
  });
});

Deno.test("DELETE session with admin not configured → 503", async () => {
  await withKv(async (kv) => {
    await handleSessionPost(
      kv,
      post("/api/session", { userId: "u1", sessionId: "sX", env: {} }),
    );
    const handler = createHandler(kv, null);
    const res = await handler(
      new Request("http://x/api/admin/session/sX", { method: "DELETE" }),
    );
    assertEquals(res.status, 503);
    await res.body?.cancel();
  });
});

Deno.test("DELETE one session doesn't touch a sibling", async () => {
  await withKv(async (kv) => {
    await handleSessionPost(
      kv,
      post("/api/session", { userId: "u1", sessionId: "sA", env: {} }),
    );
    await handleSessionPost(
      kv,
      post("/api/session", { userId: "u1", sessionId: "sB", env: {} }),
    );
    await handleEventPost(
      kv,
      post("/api/event", {
        userId: "u1",
        sessionId: "sB",
        events: [{ seq: 0, ts: 1, kind: "fetch", status: 200 }],
      }),
    );
    const handler = createHandler(kv, ADMIN);
    await handler(
      new Request("http://x/api/admin/session/sA", {
        method: "DELETE",
        headers: { authorization: basicAuth("admin", "s3cret") },
      }),
    );
    const sB = await kv.get<SessionRecord>(["session", "sB"]);
    assert(sB.value);
    let events = 0;
    for await (const _ of kv.list({ prefix: ["event", "sB"] })) events++;
    assertEquals(events, 1);
  });
});
