import { assert, assertEquals } from "jsr:@std/assert";
import { captureBaseline, captureNetwork, onNetworkChange } from "../static/lib/env.js";

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    navigator: {
      userAgent: "Mozilla/5.0 (Test)",
      language: "en-US",
      languages: ["en-US", "en"],
      platform: "MacIntel",
      hardwareConcurrency: 8,
      cookieEnabled: true,
      doNotTrack: "1",
      onLine: true,
      connection: null,
    },
    document: { characterSet: "UTF-8", referrer: "https://ref/" },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 },
    Intl: {
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "America/New_York" }) }),
    },
    isSecureContext: true,
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 2,
    matchMedia: (q: string) => ({
      matches: q === "(prefers-color-scheme: dark)" || q === "(hover: hover)",
    }),
    location: {
      href: "https://sandbox.example/?pubkey=pk",
      origin: "https://sandbox.example",
      protocol: "https:",
      search: "?pubkey=pk",
    },
  };
  return { ...base, ...overrides };
}

/* -------- captureBaseline -------- */

Deno.test("captureBaseline: reads all top-level scalar fields", () => {
  const env = captureBaseline(makeCtx() as never);
  assertEquals(env.userAgent, "Mozilla/5.0 (Test)");
  assertEquals(env.language, "en-US");
  assertEquals(env.languages, ["en-US", "en"]);
  assertEquals(env.platform, "MacIntel");
  assertEquals(env.hardwareConcurrency, 8);
  assertEquals(env.cookieEnabled, true);
  assertEquals(env.doNotTrack, "1");
  assertEquals(env.onLine, true);
  assertEquals(env.isSecureContext, true);
  assertEquals(env.timezone, "America/New_York");
});

Deno.test("captureBaseline: nested screen / viewport / matchMedia shapes", () => {
  const env = captureBaseline(makeCtx() as never);
  assertEquals(env.screen, {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
  });
  assertEquals(env.viewport, { width: 1440, height: 900, devicePixelRatio: 2 });
  assertEquals(env.matchMedia.dark, true);
  assertEquals(env.matchMedia.reducedMotion, false);
  assertEquals(env.matchMedia.hoverable, true);
  assertEquals(env.matchMedia.finePointer, false);
});

Deno.test("captureBaseline: location + document fields", () => {
  const env = captureBaseline(makeCtx() as never);
  assertEquals(env.url, "https://sandbox.example/?pubkey=pk");
  assertEquals(env.origin, "https://sandbox.example");
  assertEquals(env.protocol, "https:");
  assertEquals(env.search, "?pubkey=pk");
  assertEquals(env.characterSet, "UTF-8");
  assertEquals(env.referrer, "https://ref/");
});

Deno.test("captureBaseline: missing globals return nulls, not throws", () => {
  const env = captureBaseline({} as never);
  assertEquals(env.userAgent, null);
  assertEquals(env.language, null);
  assertEquals(env.hardwareConcurrency, null);
  assertEquals(env.matchMedia.dark, null);
  assertEquals(env.screen.width, null);
  assertEquals(env.viewport.width, null);
  assertEquals(env.url, null);
});

Deno.test("captureBaseline: non-finite/non-string values coerce to null", () => {
  const env = captureBaseline(
    makeCtx({
      navigator: { userAgent: 42, language: null, hardwareConcurrency: Number.NaN },
      screen: { width: Infinity },
    }) as never,
  );
  assertEquals(env.userAgent, null);
  assertEquals(env.language, null);
  assertEquals(env.hardwareConcurrency, null);
  assertEquals(env.screen.width, null);
});

Deno.test("captureBaseline: matchMedia throwing does not propagate", () => {
  const env = captureBaseline(
    makeCtx({
      matchMedia: () => {
        throw new Error("blocked");
      },
    }) as never,
  );
  assertEquals(env.matchMedia.dark, null);
  assertEquals(env.matchMedia.reducedMotion, null);
});

Deno.test("captureBaseline: Intl throwing does not propagate", () => {
  const env = captureBaseline(
    makeCtx({
      Intl: {
        DateTimeFormat: () => {
          throw new Error("nope");
        },
      },
    }) as never,
  );
  assertEquals(env.timezone, null);
  // real Date is still available so offset stays a number
  assert(typeof env.timezoneOffset === "number");
});

/* -------- captureNetwork -------- */

Deno.test("captureNetwork: null connection when API absent", () => {
  const snap = captureNetwork(makeCtx() as never);
  assertEquals(snap.onLine, true);
  assertEquals(snap.connection, null);
});

Deno.test("captureNetwork: reads connection fields when present", () => {
  const ctx = makeCtx({
    navigator: {
      onLine: true,
      connection: {
        effectiveType: "4g",
        downlink: 12.5,
        rtt: 40,
        saveData: false,
        type: "wifi",
      },
    },
  });
  const snap = captureNetwork(ctx as never);
  assertEquals(snap.connection, {
    effectiveType: "4g",
    downlink: 12.5,
    rtt: 40,
    saveData: false,
    type: "wifi",
  });
});

Deno.test("captureNetwork: coerces unexpected shapes to null", () => {
  const ctx = makeCtx({
    navigator: {
      onLine: "sure" as unknown as boolean,
      connection: { effectiveType: 5, downlink: "fast", rtt: Number.NaN, saveData: 0, type: null },
    },
  });
  const snap = captureNetwork(ctx as never);
  assertEquals(snap.onLine, null);
  assertEquals(snap.connection, {
    effectiveType: null,
    downlink: null,
    rtt: null,
    saveData: null,
    type: null,
  });
});

/* -------- onNetworkChange -------- */

Deno.test("onNetworkChange: subscribes, fires, and returns an unsubscriber", () => {
  const listeners: Array<() => void> = [];
  let removed = 0;
  const conn = {
    effectiveType: "4g",
    downlink: 5,
    rtt: 100,
    saveData: false,
    type: "cellular",
    addEventListener: (name: string, fn: () => void) => {
      if (name === "change") listeners.push(fn);
    },
    removeEventListener: (name: string, fn: () => void) => {
      if (name === "change" && listeners.includes(fn)) removed++;
    },
  };
  const ctx = { navigator: { connection: conn, onLine: true } };
  const captured: unknown[] = [];
  const unsub = onNetworkChange((snap) => captured.push(snap), ctx as never);
  assert(unsub !== null);
  assertEquals(listeners.length, 1);

  // simulate a change: mutate then fire
  conn.effectiveType = "3g";
  listeners[0]!();
  assertEquals(captured.length, 1);
  assertEquals(
    (captured[0] as { connection: { effectiveType: string } }).connection.effectiveType,
    "3g",
  );

  unsub!();
  assertEquals(removed, 1);
});

Deno.test("onNetworkChange: returns null when connection API is absent", () => {
  const unsub = onNetworkChange(() => {}, { navigator: {} } as never);
  assertEquals(unsub, null);
});
