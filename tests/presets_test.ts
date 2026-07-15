import { assertEquals } from "jsr:@std/assert";
import { applyPreset, PRESET_NAMES, PRESETS } from "../static/lib/presets.js";

Deno.test("applyPreset: unknown name is a no-op", () => {
  const input = { pubkey: "k" };
  assertEquals(applyPreset("does-not-exist", input), input);
});

Deno.test("applyPreset: nullish name is a no-op", () => {
  const input = { pubkey: "k" };
  assertEquals(applyPreset(null, input), input);
  assertEquals(applyPreset(undefined, input), input);
  assertEquals(applyPreset("", input), input);
});

Deno.test("applyPreset: adds preset keys to empty forwarded map", () => {
  const out = applyPreset("multipart", {});
  assertEquals(out["multipart-min-file-size"], "5242880");
  assertEquals(out["multipart-chunk-size"], "1048576");
  assertEquals(out.multiple, "true");
});

Deno.test("applyPreset: explicit forwarded params override preset values", () => {
  const out = applyPreset("multipart", {
    "multipart-min-file-size": "999",
    "pubkey": "user-key",
  });
  assertEquals(out["multipart-min-file-size"], "999");
  assertEquals(out.pubkey, "user-key");
  // Non-overridden preset key still present.
  assertEquals(out["multipart-chunk-size"], "1048576");
});

Deno.test("applyPreset: every declared preset appears in PRESET_NAMES", () => {
  for (const name of PRESET_NAMES) {
    assertEquals(typeof PRESETS[name as keyof typeof PRESETS], "object");
  }
  assertEquals(PRESET_NAMES.length, Object.keys(PRESETS).length);
});

Deno.test("applyPreset: preset values are all strings (kebab-case keys)", () => {
  for (const preset of Object.values(PRESETS)) {
    for (const [k, v] of Object.entries(preset)) {
      assertEquals(typeof v, "string", `${k} should be a string`);
      // No camelCase keys — presets use the same kebab-case shape as the DOM.
      assertEquals(k, k.toLowerCase());
    }
  }
});
