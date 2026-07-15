import { assert, assertEquals } from "jsr:@std/assert";
import { DEFAULT_HOSTS, probeHost, probeHosts } from "../static/lib/probes.js";

function fakeNow() {
  let t = 0;
  return {
    now: () => {
      const cur = t;
      t += 25; // each call advances 25ms
      return cur;
    },
  };
}

Deno.test("DEFAULT_HOSTS: covers the four Uploadcare hosts", () => {
  assertEquals([...DEFAULT_HOSTS], [
    "upload.uploadcare.com",
    "api.uploadcare.com",
    "ucarecdn.com",
    "ucarecd.net",
  ]);
});

Deno.test("probeHost: successful HEAD returns ok result with timing", async () => {
  const { now } = fakeNow();
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchStub = (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const r = await probeHost("api.uploadcare.com", { fetch: fetchStub, now });
  assertEquals(r.host, "api.uploadcare.com");
  assertEquals(r.url, "https://api.uploadcare.com/");
  assertEquals(r.ok, true);
  assertEquals(typeof r.ms, "number");
  assert(r.ms! >= 25); // now advanced by at least 25ms between calls
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.init?.method, "HEAD");
  assertEquals(calls[0]!.init?.mode, "no-cors");
  assertEquals(calls[0]!.init?.cache, "no-store");
});

Deno.test("probeHost: fetch rejection becomes ok=false with error name", async () => {
  const { now } = fakeNow();
  const err = new TypeError("Failed to fetch");
  const fetchStub = () => Promise.reject(err);
  const r = await probeHost("ucarecd.net", { fetch: fetchStub, now });
  assertEquals(r.ok, false);
  assertEquals(r.error, "TypeError");
  assert(r.message?.includes("Failed to fetch"));
});

Deno.test("probeHost: AbortError maps to error='timeout'", async () => {
  const { now } = fakeNow();
  const err = new DOMException("aborted", "AbortError");
  const fetchStub = () => Promise.reject(err);
  const r = await probeHost("ucarecdn.com", { fetch: fetchStub, now });
  assertEquals(r.ok, false);
  assertEquals(r.error, "timeout");
});

Deno.test("probeHost: honors custom path", async () => {
  const { now } = fakeNow();
  let seenUrl = "";
  const fetchStub = (input: string) => {
    seenUrl = input;
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  await probeHost("upload.uploadcare.com", {
    fetch: fetchStub,
    now,
    path: "/ping",
  });
  assertEquals(seenUrl, "https://upload.uploadcare.com/ping");
});

Deno.test("probeHost: aborts when timeoutMs elapses", async () => {
  const { now } = fakeNow();
  class ImmediateCtrl {
    signal = { aborted: false };
    abort() {
      this.signal.aborted = true;
    }
  }
  let received: { aborted: boolean } | undefined;
  const fetchStub = (_input: string, init?: RequestInit) => {
    // Capture the signal then never resolve — we rely on the abort timer
    // firing via microtask/setTimeout.
    received = init?.signal as unknown as { aborted: boolean };
    return new Promise<Response>((_res, rej) => {
      const check = () => {
        if (received?.aborted) {
          rej(new DOMException("aborted", "AbortError"));
        } else setTimeout(check, 0);
      };
      check();
    });
  };
  const r = await probeHost("slow.example", {
    fetch: fetchStub,
    now,
    timeoutMs: 5,
    AbortCtrl: ImmediateCtrl as unknown as typeof AbortController,
  });
  assertEquals(r.ok, false);
  assertEquals(r.error, "timeout");
});

Deno.test("probeHosts: probes in parallel and preserves order", async () => {
  const { now } = fakeNow();
  const fetchStub = (input: string) => {
    if (input.includes("api.")) return Promise.resolve(new Response(null, { status: 200 }));
    return Promise.reject(new TypeError("nope"));
  };
  const results = await probeHosts(["api.uploadcare.com", "ucarecdn.com"], {
    fetch: fetchStub,
    now,
  });
  assertEquals(results.length, 2);
  assertEquals(results[0]!.host, "api.uploadcare.com");
  assertEquals(results[0]!.ok, true);
  assertEquals(results[1]!.host, "ucarecdn.com");
  assertEquals(results[1]!.ok, false);
});
