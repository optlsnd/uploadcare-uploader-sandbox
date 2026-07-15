import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import {
  createHandler,
  handleEventPost,
  handleSessionPost,
  type SessionRecord,
  upsertSession,
} from "../main.ts";

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

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return await res.json();
}

Deno.test("handleSessionPost: creates user + session, extracts pubkey/label", async () => {
  await withKv(async (kv) => {
    const res = await handleSessionPost(
      kv,
      post("/api/session", {
        userId: "u1",
        sessionId: "s1",
        env: { url: "http://x/?pubkey=pk1&label=lbl1" },
      }),
    );
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    assertEquals(body.ok, true);
    const session = body.session as SessionRecord;
    assertEquals(session.pubkey, "pk1");
    assertEquals(session.label, "lbl1");
    assertEquals(session.eventCount, 0);
    assert(session.indexed);

    const user = await kv.get(["user", "u1"]);
    assert(user.value);
    const userIdx = await kv.get([
      "user_index",
      (user.value as { createdAt: number }).createdAt,
      "u1",
    ]);
    assertEquals(userIdx.value, "u1");
    const sessionIdx = await kv.get(["session_index", session.createdAt, "s1"]);
    assertEquals(sessionIdx.value, "s1");
    const byUser = await kv.get(["session_by_user", "u1", session.createdAt, "s1"]);
    assertEquals(byUser.value, "s1");
  });
});

Deno.test("handleSessionPost: idempotent re-post preserves createdAt / pubkey / label", async () => {
  await withKv(async (kv) => {
    const res1 = await handleSessionPost(
      kv,
      post("/api/session", {
        userId: "u1",
        sessionId: "s1",
        startedAt: 1000,
        env: { url: "http://x/?pubkey=p1&label=l1" },
      }),
    );
    const first = (await jsonBody(res1)).session as SessionRecord;

    const res2 = await handleSessionPost(
      kv,
      post("/api/session", {
        userId: "u1",
        sessionId: "s1",
        startedAt: 9999,
        env: { url: "http://x/?pubkey=p2&label=l2" },
      }),
    );
    const second = (await jsonBody(res2)).session as SessionRecord;

    assertEquals(second.createdAt, first.createdAt);
    assertEquals(second.pubkey, "p1");
    assertEquals(second.label, "l1");

    // No duplicate indexes: exactly one session_index entry
    const entries: unknown[] = [];
    for await (const e of kv.list({ prefix: ["session_index"] })) entries.push(e.value);
    assertEquals(entries.length, 1);
  });
});

Deno.test("handleSessionPost: rejects missing userId/sessionId", async () => {
  await withKv(async (kv) => {
    const res = await handleSessionPost(kv, post("/api/session", { userId: "u1" }));
    assertEquals(res.status, 400);
    const body = await jsonBody(res);
    assert(String(body.error).includes("required"));
  });
});

Deno.test("handleEventPost: stores events and bumps eventCount", async () => {
  await withKv(async (kv) => {
    await handleSessionPost(
      kv,
      post("/api/session", { userId: "u1", sessionId: "s1", env: {} }),
    );
    const res = await handleEventPost(
      kv,
      post("/api/event", {
        userId: "u1",
        sessionId: "s1",
        events: [
          { seq: 0, ts: 1, kind: "fetch" },
          { seq: 1, ts: 2, kind: "js-error" },
          { seq: 2, ts: 3, kind: "uploader-event", name: "file-added" },
        ],
      }),
    );
    assertEquals(res.status, 200);
    assertEquals((await jsonBody(res)).stored, 3);

    const session = await kv.get<SessionRecord>(["session", "s1"]);
    assertEquals(session.value?.eventCount, 3);

    const events: unknown[] = [];
    for await (const e of kv.list({ prefix: ["event", "s1"] })) events.push(e.value);
    assertEquals(events.length, 3);
  });
});

Deno.test("handleEventPost: event before session synthesizes session with indexes", async () => {
  await withKv(async (kv) => {
    const res = await handleEventPost(
      kv,
      post("/api/event", {
        userId: "u1",
        sessionId: "s1",
        events: [{ seq: 0, ts: 1, kind: "perf-resource" }],
      }),
    );
    assertEquals(res.status, 200);

    const session = await kv.get<SessionRecord>(["session", "s1"]);
    assert(session.value);
    assert(session.value.indexed);
    assertEquals(session.value.env, null);

    const sessionIdxCount = await countPrefix(kv, ["session_index"]);
    assertEquals(sessionIdxCount, 1);
  });
});

Deno.test("handleEventPost: subsequent handleSessionPost merges into synthetic", async () => {
  await withKv(async (kv) => {
    await handleEventPost(
      kv,
      post("/api/event", {
        userId: "u1",
        sessionId: "s1",
        events: [{ seq: 0, ts: 1, kind: "perf-resource" }],
      }),
    );
    const syntheticSession = (await kv.get<SessionRecord>(["session", "s1"])).value!;

    await handleSessionPost(
      kv,
      post("/api/session", {
        userId: "u1",
        sessionId: "s1",
        startedAt: 42,
        env: { url: "http://x/?pubkey=pk&label=lbl" },
      }),
    );
    const merged = (await kv.get<SessionRecord>(["session", "s1"])).value!;

    assertEquals(merged.createdAt, syntheticSession.createdAt);
    assertEquals(merged.pubkey, "pk");
    assertEquals(merged.label, "lbl");
    assertEquals(merged.eventCount, 1);
    assertEquals(await countPrefix(kv, ["session_index"]), 1);
  });
});

Deno.test("handleEventPost: rejects malformed body", async () => {
  await withKv(async (kv) => {
    const res = await handleEventPost(kv, post("/api/event", { userId: "u1" }));
    assertEquals(res.status, 400);
  });
});

Deno.test("handleEventPost: empty events => stored 0, no writes", async () => {
  await withKv(async (kv) => {
    const res = await handleEventPost(
      kv,
      post("/api/event", { userId: "u1", sessionId: "s1", events: [] }),
    );
    assertEquals(res.status, 200);
    assertEquals((await jsonBody(res)).stored, 0);
    const session = await kv.get(["session", "s1"]);
    assertFalse(session.value);
  });
});

Deno.test("upsertSession: records clientIp on first sight only", async () => {
  await withKv(async (kv) => {
    const s1 = await upsertSession(kv, {
      userId: "u1",
      sessionId: "s1",
      clientIp: "1.2.3.4",
    });
    assertEquals(s1.clientIp, "1.2.3.4");
    const s2 = await upsertSession(kv, {
      userId: "u1",
      sessionId: "s1",
      clientIp: "5.6.7.8",
    });
    assertEquals(s2.clientIp, "1.2.3.4");
  });
});

Deno.test("createHandler: dispatches routes", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(kv);

    // /admin without an admin config → 503 (see admin_test.ts for the 401/200 paths).
    const admin = await handler(new Request("http://x/admin"));
    assertEquals(admin.status, 503);
    await admin.body?.cancel();

    // /session/:id now serves the session.html shell (200) regardless of id.
    const sess = await handler(new Request("http://x/session/anything"));
    assertEquals(sess.status, 200);
    assert((sess.headers.get("content-type") ?? "").includes("text/html"));
    await sess.body?.cancel();

    const apiUnknown = await handler(new Request("http://x/api/nope"));
    assertEquals(apiUnknown.status, 501);

    const okBody = { userId: "u1", sessionId: "s1", env: {} };
    const apiSession = await handler(post("/api/session", okBody));
    assertEquals(apiSession.status, 200);

    const beacon = await handler(
      post("/api/event-beacon", {
        userId: "u1",
        sessionId: "s1",
        events: [{ seq: 0, ts: 1, kind: "x" }],
      }),
    );
    assertEquals(beacon.status, 200);
    assertEquals((await jsonBody(beacon)).stored, 1);
  });
});

async function countPrefix(kv: Deno.Kv, prefix: Deno.KvKey): Promise<number> {
  let n = 0;
  for await (const _ of kv.list({ prefix })) n++;
  return n;
}
