import { assert, assertEquals } from "jsr:@std/assert";
import {
  classifyEvent,
  correlatePerf,
  countByCategory,
  filterEvents,
  relativeTimestamp,
  sessionDurationMs,
  summarizeEvent,
} from "../static/lib/session.js";
import { createHandler, handleEventPost, handleSessionGet, handleSessionPost } from "../main.ts";

async function withKv<T>(fn: (kv: Deno.Kv) => Promise<T>): Promise<T> {
  const kv = await Deno.openKv(":memory:");
  try {
    return await fn(kv);
  } finally {
    kv.close();
  }
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* -------- classifyEvent -------- */

Deno.test("classifyEvent: network kinds", () => {
  assertEquals(classifyEvent({ kind: "fetch" }), "network");
  assertEquals(classifyEvent({ kind: "fetch-error" }), "network");
  assertEquals(classifyEvent({ kind: "xhr" }), "network");
  assertEquals(classifyEvent({ kind: "xhr-error" }), "network");
});

Deno.test("classifyEvent: error kinds and console.error", () => {
  assertEquals(classifyEvent({ kind: "js-error" }), "error");
  assertEquals(classifyEvent({ kind: "unhandled-rejection" }), "error");
  assertEquals(classifyEvent({ kind: "console", level: "error" }), "error");
});

Deno.test("classifyEvent: console.warn is other, not error", () => {
  assertEquals(classifyEvent({ kind: "console", level: "warn" }), "other");
});

Deno.test("classifyEvent: uploader and perf", () => {
  assertEquals(classifyEvent({ kind: "uploader-event" }), "uploader");
  assertEquals(classifyEvent({ kind: "perf-resource" }), "perf");
});

Deno.test("classifyEvent: fallback to other", () => {
  assertEquals(classifyEvent({ kind: "some-future-kind" }), "other");
  assertEquals(classifyEvent({}), "other");
});

/* -------- summarizeEvent -------- */

Deno.test("summarizeEvent: fetch with status and duration", () => {
  const s = summarizeEvent({
    kind: "fetch",
    method: "POST",
    url: "https://upload.uploadcare.com/base/",
    status: 200,
    durationMs: 123,
  });
  assertEquals(s, "POST https://upload.uploadcare.com/base/ → 200 (123ms)");
});

Deno.test("summarizeEvent: xhr-error with error object", () => {
  const s = summarizeEvent({
    kind: "xhr-error",
    method: "POST",
    url: "https://api/",
    error: "network",
  });
  assert(s.includes("✗ network"));
});

Deno.test("summarizeEvent: uploader-event uses name", () => {
  assertEquals(summarizeEvent({ kind: "uploader-event", name: "file-added" }), "file-added");
});

Deno.test("summarizeEvent: js-error composition", () => {
  const s = summarizeEvent({
    kind: "js-error",
    message: "boom",
    filename: "app.js",
    lineno: 12,
    colno: 3,
  });
  assertEquals(s, "boom @ app.js:12:3");
});

Deno.test("summarizeEvent: console renders args", () => {
  const s = summarizeEvent({
    kind: "console",
    level: "warn",
    args: ["hi", { n: 1 }],
  });
  assertEquals(s, `warn: hi {"n":1}`);
});

Deno.test("summarizeEvent: handles null/missing gracefully", () => {
  assertEquals(summarizeEvent(null as unknown as Record<string, unknown>), "(invalid event)");
  assert(summarizeEvent({ kind: "fetch" }).includes("?"));
});

/* -------- relativeTimestamp -------- */

Deno.test("relativeTimestamp: positive and negative offsets", () => {
  assertEquals(relativeTimestamp(1234, 1000), "+0.234s");
  assertEquals(relativeTimestamp(500, 1000), "-0.500s");
  assertEquals(relativeTimestamp(1000, 1000), "+0.000s");
});

Deno.test("relativeTimestamp: missing inputs", () => {
  assertEquals(relativeTimestamp(undefined, 1000), "");
  assertEquals(relativeTimestamp(1000, undefined), "");
});

/* -------- countByCategory -------- */

Deno.test("countByCategory: sums correctly", () => {
  const counts = countByCategory([
    { kind: "fetch" },
    { kind: "xhr-error" },
    { kind: "uploader-event" },
    { kind: "js-error" },
    { kind: "perf-resource" },
    { kind: "console", level: "warn" },
    { kind: "probe-host", host: "upload.uploadcare.com", ok: true },
    { kind: "env-network-change" },
  ]);
  assertEquals(counts, {
    all: 8,
    network: 2,
    error: 1,
    uploader: 1,
    perf: 1,
    env: 2,
    other: 1,
  });
});

Deno.test("classifyEvent: probe and env-change → env", () => {
  assertEquals(classifyEvent({ kind: "probe-host" }), "env");
  assertEquals(classifyEvent({ kind: "probe-summary" }), "env");
  assertEquals(classifyEvent({ kind: "env-network-change" }), "env");
});

Deno.test("summarizeEvent: probe-host reachable and error variants", () => {
  assertEquals(
    summarizeEvent({ kind: "probe-host", host: "upload.uploadcare.com", ok: true, ms: 42 }),
    "upload.uploadcare.com ✓ 42ms",
  );
  assertEquals(
    summarizeEvent({
      kind: "probe-host",
      host: "unreachable.example",
      ok: false,
      ms: 5000,
      error: "timeout",
    }),
    "unreachable.example ✗ timeout (5000ms)",
  );
});

Deno.test("summarizeEvent: probe-summary counts ok/total", () => {
  assertEquals(
    summarizeEvent({
      kind: "probe-summary",
      results: [{ ok: true }, { ok: true }, { ok: false }],
    }),
    "host probes: 2/3 reachable",
  );
});

Deno.test("summarizeEvent: env-network-change with and without connection", () => {
  const withConn = summarizeEvent({
    kind: "env-network-change",
    onLine: true,
    connection: { effectiveType: "4g", downlink: 10, rtt: 50 },
  });
  assertEquals(withConn, "online=true · 4g · 10Mbps · rtt 50ms");
  assertEquals(
    summarizeEvent({ kind: "env-network-change", onLine: false, connection: null }),
    "online=false",
  );
});

/* -------- filterEvents -------- */

Deno.test("filterEvents: category filter alone", () => {
  const events = [
    { kind: "fetch", url: "u1", method: "GET", status: 200, ts: 1 },
    { kind: "js-error", message: "x", ts: 2 },
    { kind: "uploader-event", name: "file-added", ts: 3 },
  ];
  const network = filterEvents(events, "network", "");
  assertEquals(network.length, 1);
  assertEquals(filterEvents(events, "all", "").length, 3);
});

Deno.test("filterEvents: text search matches url/kind/summary case-insensitively", () => {
  const events = [
    {
      kind: "fetch",
      url: "https://upload.uploadcare.com/base/",
      method: "POST",
      status: 200,
      ts: 1,
    },
    { kind: "js-error", message: "Boom", ts: 2 },
    { kind: "uploader-event", name: "file-added", ts: 3 },
  ];
  assertEquals(filterEvents(events, "all", "uploadcare").length, 1);
  assertEquals(filterEvents(events, "all", "BOOM").length, 1);
  assertEquals(filterEvents(events, "all", "file-added").length, 1);
});

Deno.test("filterEvents: category + search combine", () => {
  const events = [
    { kind: "fetch", url: "https://a", method: "GET", status: 200, ts: 1 },
    { kind: "fetch", url: "https://b", method: "GET", status: 200, ts: 2 },
    { kind: "js-error", message: "https://a broke", ts: 3 },
  ];
  const out = filterEvents(events, "network", "https://a");
  assertEquals(out.length, 1);
  assertEquals((out[0] as { url: string }).url, "https://a");
});

Deno.test("filterEvents: empty search is a no-op", () => {
  const events = [{ kind: "fetch", url: "u", method: "G", status: 200, ts: 1 }];
  assertEquals(filterEvents(events, "all", "   ").length, 1);
});

/* -------- correlatePerf -------- */

Deno.test("correlatePerf: attaches _perf to fetch event when URL + ts match", () => {
  const events = [
    { seq: 0, kind: "fetch", url: "https://x/", method: "GET", status: 200, ts: 1000 },
    { seq: 1, kind: "perf-resource", name: "https://x/", ts: 1050, transferSize: 512 },
  ];
  const enriched = correlatePerf(events);
  const fetchEv = enriched.find((e) => e.kind === "fetch") as { _perf?: { transferSize: number } };
  assertEquals(fetchEv._perf?.transferSize, 512);
});

Deno.test("correlatePerf: leaves non-network events untouched", () => {
  const events = [
    { seq: 0, kind: "uploader-event", ts: 1000 },
    { seq: 1, kind: "perf-resource", name: "https://x/", ts: 1050 },
  ];
  const enriched = correlatePerf(events);
  const uploader = enriched.find((e) => e.kind === "uploader-event") as { _perf?: unknown };
  assertEquals(uploader._perf, undefined);
});

Deno.test("correlatePerf: no match when URL differs", () => {
  const events = [
    { seq: 0, kind: "fetch", url: "https://a/", method: "GET", ts: 1000 },
    { seq: 1, kind: "perf-resource", name: "https://b/", ts: 1050 },
  ];
  const enriched = correlatePerf(events);
  const fetchEv = enriched.find((e) => e.kind === "fetch") as { _perf?: unknown };
  assertEquals(fetchEv._perf, undefined);
});

Deno.test("correlatePerf: skips matches beyond 5s window", () => {
  const events = [
    { seq: 0, kind: "fetch", url: "https://x/", method: "GET", ts: 1000 },
    { seq: 1, kind: "perf-resource", name: "https://x/", ts: 10_000 },
  ];
  const enriched = correlatePerf(events);
  const fetchEv = enriched.find((e) => e.kind === "fetch") as { _perf?: unknown };
  assertEquals(fetchEv._perf, undefined);
});

Deno.test("correlatePerf: picks closest perf entry among many with same URL", () => {
  const events = [
    { seq: 0, kind: "fetch", url: "https://x/", method: "GET", ts: 1000 },
    { seq: 1, kind: "perf-resource", name: "https://x/", ts: 500, transferSize: 100 },
    { seq: 2, kind: "perf-resource", name: "https://x/", ts: 950, transferSize: 200 },
    { seq: 3, kind: "perf-resource", name: "https://x/", ts: 3000, transferSize: 300 },
  ];
  const enriched = correlatePerf(events);
  const fetchEv = enriched.find((e) => e.kind === "fetch") as { _perf?: { transferSize: number } };
  assertEquals(fetchEv._perf?.transferSize, 200);
});

Deno.test("correlatePerf: returns original array when no perf entries", () => {
  const events = [{ seq: 0, kind: "fetch", url: "https://x/", method: "GET", ts: 1000 }];
  assertEquals(correlatePerf(events), events);
});

/* -------- sessionDurationMs -------- */

Deno.test("sessionDurationMs: max ts − min ts", () => {
  assertEquals(sessionDurationMs([{ ts: 100 }, { ts: 400 }, { ts: 250 }]), 300);
});

Deno.test("sessionDurationMs: empty or invalid inputs", () => {
  assertEquals(sessionDurationMs([]), null);
  assertEquals(sessionDurationMs([{ ts: NaN }] as unknown as Array<{ ts: number }>), null);
});

Deno.test("sessionDurationMs: single event → 0", () => {
  assertEquals(sessionDurationMs([{ ts: 500 }]), 0);
});

/* -------- handleSessionGet -------- */

Deno.test("handleSessionGet: 404 when session missing", async () => {
  await withKv(async (kv) => {
    const res = await handleSessionGet(kv, "does-not-exist");
    assertEquals(res.status, 404);
  });
});

Deno.test("handleSessionGet: returns session + ordered events", async () => {
  await withKv(async (kv) => {
    await handleSessionPost(
      kv,
      post("/api/session", {
        userId: "u1",
        sessionId: "s1",
        env: { url: "http://x/?pubkey=pk" },
      }),
    );
    await handleEventPost(
      kv,
      post("/api/event", {
        userId: "u1",
        sessionId: "s1",
        events: [
          { seq: 2, ts: 30, kind: "fetch" },
          { seq: 0, ts: 10, kind: "js-error" },
          { seq: 1, ts: 20, kind: "uploader-event" },
        ],
      }),
    );
    const res = await handleSessionGet(kv, "s1");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.session.sessionId, "s1");
    assertEquals(body.session.pubkey, "pk");
    assertEquals(body.events.length, 3);
    assertEquals(body.events.map((e: { seq: number }) => e.seq), [0, 1, 2]);
  });
});

Deno.test("handleSessionGet: session with no events returns empty array", async () => {
  await withKv(async (kv) => {
    await handleSessionPost(
      kv,
      post("/api/session", { userId: "u1", sessionId: "s1", env: {} }),
    );
    const res = await handleSessionGet(kv, "s1");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.events, []);
  });
});

/* -------- createHandler routing for session view -------- */

Deno.test("createHandler: GET /api/session/:id dispatches to handleSessionGet", async () => {
  await withKv(async (kv) => {
    await handleSessionPost(
      kv,
      post("/api/session", { userId: "u1", sessionId: "s1", env: {} }),
    );
    const handler = createHandler(kv);
    const res = await handler(new Request("http://x/api/session/s1"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.session.sessionId, "s1");
  });
});

Deno.test("createHandler: GET /api/session/missing => 404", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(kv);
    const res = await handler(new Request("http://x/api/session/nope"));
    assertEquals(res.status, 404);
  });
});
