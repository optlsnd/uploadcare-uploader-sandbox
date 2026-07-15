import { assert, assertMatch } from "jsr:@std/assert";
import { randomUUID } from "../static/lib/id.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

Deno.test("randomUUID: shape is v4", () => {
  assertMatch(randomUUID(), UUID_V4);
});

Deno.test("randomUUID: many calls stay unique and v4-shaped", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const id = randomUUID();
    assertMatch(id, UUID_V4);
    ids.add(id);
  }
  assert(ids.size === 200);
});

Deno.test("randomUUID: fallback path works when crypto.randomUUID is missing", () => {
  const cryptoAny = crypto as unknown as { randomUUID?: () => string };
  const original = cryptoAny.randomUUID;
  try {
    delete cryptoAny.randomUUID;
    assertMatch(randomUUID(), UUID_V4);
  } finally {
    if (original) cryptoAny.randomUUID = original;
  }
});
