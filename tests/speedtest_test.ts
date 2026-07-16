import { assert, assertEquals } from "jsr:@std/assert";
import { downloadSpeed, runSpeedtest, uploadSpeed } from "../static/lib/speedtest.js";

function fixedNow(steps: number[]): () => number {
  let i = 0;
  return () => steps[Math.min(i++, steps.length - 1)]!;
}

Deno.test("downloadSpeed: happy path with fixed timing → correct mbps", async () => {
  // Called twice: before request, after arrayBuffer resolves. 1_000_000 bytes
  // in 1000ms = 8 Mbps.
  const now = fixedNow([0, 1000]);
  const fetchStub = () => Promise.resolve(new Response(new Uint8Array(1_000_000), { status: 200 }));
  const r = await downloadSpeed({ bytes: 1_000_000, fetch: fetchStub, now });
  assertEquals("mbps" in r, true);
  const okR = r as { mbps: number; bytes: number; ms: number };
  assertEquals(okR.bytes, 1_000_000);
  assertEquals(okR.ms, 1000);
  assertEquals(okR.mbps, 8);
});

Deno.test("downloadSpeed: hits real Cloudflare endpoint URL with ?bytes", async () => {
  let seenUrl = "";
  const fetchStub = (input: string) => {
    seenUrl = input;
    return Promise.resolve(new Response(new Uint8Array(100), { status: 200 }));
  };
  await downloadSpeed({ bytes: 100, fetch: fetchStub, now: fixedNow([0, 100]) });
  assertEquals(seenUrl, "https://speed.cloudflare.com/__down?bytes=100");
});

Deno.test("downloadSpeed: non-2xx becomes { error, bytes }", async () => {
  const fetchStub = () => Promise.resolve(new Response("", { status: 503 }));
  const r = await downloadSpeed({
    bytes: 500,
    fetch: fetchStub,
    now: fixedNow([0, 5]),
  });
  const errR = r as { error: string; bytes: number };
  assertEquals(errR.error, "HTTP 503");
  assertEquals(errR.bytes, 500);
});

Deno.test("downloadSpeed: fetch rejection becomes { error, bytes }", async () => {
  const fetchStub = () => Promise.reject(new TypeError("network down"));
  const r = await downloadSpeed({
    bytes: 500,
    fetch: fetchStub,
    now: fixedNow([0, 5]),
  });
  const errR = r as { error: string; bytes: number };
  assert(errR.error.includes("network down"));
  assertEquals(errR.bytes, 500);
});

Deno.test("uploadSpeed: sends POST with N-byte body, times it", async () => {
  let seenBodySize = -1;
  let seenMethod = "";
  const fetchStub = (_url: string, init?: RequestInit) => {
    seenMethod = init?.method ?? "";
    const body = init?.body as Uint8Array | undefined;
    seenBodySize = body?.byteLength ?? -1;
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  const now = fixedNow([0, 2000]);
  const r = await uploadSpeed({ bytes: 500_000, fetch: fetchStub, now });
  assertEquals(seenMethod, "POST");
  assertEquals(seenBodySize, 500_000);
  const okR = r as { mbps: number };
  // 500_000 bytes * 8 / (2000 * 1000) = 2 Mbps
  assertEquals(okR.mbps, 2);
});

Deno.test("runSpeedtest: returns both halves + startedAt/finishedAt", async () => {
  const fetchStub = () => Promise.resolve(new Response(new Uint8Array(10), { status: 200 }));
  let t = 0;
  const clock = () => {
    t += 500;
    return t;
  };
  const result = await runSpeedtest({
    downloadBytes: 10,
    uploadBytes: 10,
    fetch: fetchStub,
    now: fixedNow([0, 1, 2, 3, 4]),
    clock,
  });
  assert("mbps" in result.download || "error" in result.download);
  assert("mbps" in result.upload || "error" in result.upload);
  assertEquals(typeof result.startedAt, "number");
  assertEquals(typeof result.finishedAt, "number");
  assert(result.finishedAt >= result.startedAt);
});

Deno.test("runSpeedtest: onPhaseStart/onPhaseEnd fire in download-then-upload order", async () => {
  const fetchStub = () => Promise.resolve(new Response(new Uint8Array(10), { status: 200 }));
  const events: string[] = [];
  await runSpeedtest({
    downloadBytes: 10,
    uploadBytes: 10,
    fetch: fetchStub,
    now: fixedNow([0, 1, 2, 3]),
    onPhaseStart: (phase) => events.push(`start:${phase}`),
    onPhaseEnd: (phase) => events.push(`end:${phase}`),
  });
  assertEquals(events, ["start:download", "end:download", "start:upload", "end:upload"]);
});

Deno.test("runSpeedtest: phase callbacks fire even when a half errors", async () => {
  const fetchStub = (url: string) => {
    if (url.includes("__down")) return Promise.reject(new Error("nope"));
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  const events: string[] = [];
  await runSpeedtest({
    downloadBytes: 10,
    uploadBytes: 10,
    fetch: fetchStub,
    now: fixedNow([0, 1, 2, 3]),
    onPhaseStart: (phase) => events.push(`start:${phase}`),
    onPhaseEnd: (phase) => events.push(`end:${phase}`),
  });
  // download errored but callbacks still fire; upload succeeded.
  assertEquals(events, ["start:download", "end:download", "start:upload", "end:upload"]);
});

Deno.test("runSpeedtest: partial failure — download errors, upload ok", async () => {
  const fetchStub = (url: string) => {
    if (url.includes("__down")) return Promise.reject(new Error("down blocked"));
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  const result = await runSpeedtest({
    downloadBytes: 10,
    uploadBytes: 10,
    fetch: fetchStub,
    now: fixedNow([0, 1, 2, 3]),
  });
  assert("error" in result.download);
  assert("mbps" in result.upload);
});
