import { assertEquals } from "jsr:@std/assert";
import { ENGAGEMENT_UPLOADER_NAMES, isEngagementEvent } from "../static/lib/engagement.js";

Deno.test("isEngagementEvent: null/undefined/non-object → false", () => {
  assertEquals(isEngagementEvent(null), false);
  assertEquals(isEngagementEvent(undefined), false);
  assertEquals(
    isEngagementEvent("nope" as unknown as Record<string, unknown>),
    false,
  );
  assertEquals(isEngagementEvent({} as Record<string, unknown>), false);
});

Deno.test("isEngagementEvent: JS errors promote", () => {
  assertEquals(isEngagementEvent({ kind: "js-error" }), true);
  assertEquals(isEngagementEvent({ kind: "unhandled-rejection" }), true);
});

Deno.test("isEngagementEvent: fetch/xhr errors promote", () => {
  assertEquals(isEngagementEvent({ kind: "fetch-error" }), true);
  assertEquals(isEngagementEvent({ kind: "xhr-error" }), true);
});

Deno.test("isEngagementEvent: console.error promotes, other console levels don't", () => {
  assertEquals(isEngagementEvent({ kind: "console", level: "error" }), true);
  assertEquals(isEngagementEvent({ kind: "console", level: "warn" }), false);
  assertEquals(isEngagementEvent({ kind: "console" }), false);
});

Deno.test("isEngagementEvent: uploader lifecycle promotes only for engagement names", () => {
  for (const name of ENGAGEMENT_UPLOADER_NAMES) {
    assertEquals(isEngagementEvent({ kind: "uploader-event", name }), true);
  }
  assertEquals(isEngagementEvent({ kind: "uploader-event", name: "modal-open" }), false);
  assertEquals(isEngagementEvent({ kind: "uploader-event", name: "activity-change" }), false);
  assertEquals(isEngagementEvent({ kind: "uploader-event" }), false);
});

Deno.test("isEngagementEvent: env/perf/network events alone don't promote", () => {
  assertEquals(isEngagementEvent({ kind: "fetch", status: 200 }), false);
  assertEquals(isEngagementEvent({ kind: "xhr", status: 200 }), false);
  assertEquals(isEngagementEvent({ kind: "perf-resource" }), false);
  assertEquals(isEngagementEvent({ kind: "probe-host", ok: true }), false);
  assertEquals(isEngagementEvent({ kind: "probe-host", ok: false }), false);
  assertEquals(isEngagementEvent({ kind: "probe-summary" }), false);
  assertEquals(isEngagementEvent({ kind: "env-network-change" }), false);
  assertEquals(isEngagementEvent({ kind: "speedtest" }), false);
});
