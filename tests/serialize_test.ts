import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import {
  bodySize,
  filterHeaders,
  isUploadcareUrl,
  methodOf,
  parseRawHeaders,
  safeHeaderName,
  sanitize,
  urlOf,
} from "../static/lib/serialize.js";

Deno.test("safeHeaderName is case-insensitive and safelisted only", () => {
  assert(safeHeaderName("content-type"));
  assert(safeHeaderName("Content-Type"));
  assert(safeHeaderName("X-Uploadcare-Request-Id"));
  assertFalse(safeHeaderName("cookie"));
  assertFalse(safeHeaderName("authorization"));
  assertFalse(safeHeaderName("x-secret-token"));
});

Deno.test("filterHeaders: Headers object", () => {
  const h = new Headers({
    "Content-Type": "application/json",
    "Cookie": "session=x",
    "X-Uploadcare-Request-Id": "abc",
  });
  const out = filterHeaders(h);
  assertEquals(out["content-type"], "application/json");
  assertEquals(out["x-uploadcare-request-id"], "abc");
  assertFalse("cookie" in out);
});

Deno.test("filterHeaders: plain object", () => {
  const out = filterHeaders({
    "Content-Length": "42",
    "Authorization": "Bearer secret",
  });
  assertEquals(out, { "content-length": "42" });
});

Deno.test("filterHeaders: array of tuples", () => {
  const out = filterHeaders([
    ["content-type", "text/plain"],
    ["cookie", "leak"],
    ["x-request-id", "r1"],
  ]);
  assertEquals(out, { "content-type": "text/plain", "x-request-id": "r1" });
});

Deno.test("filterHeaders: null/undefined", () => {
  assertEquals(filterHeaders(null), {});
  assertEquals(filterHeaders(undefined), {});
});

Deno.test("parseRawHeaders: parses HTTP response header block", () => {
  const raw = [
    "Content-Type: application/json",
    "Cookie: nope",
    "X-Request-Id: r1",
    "Malformed line without colon",
  ].join("\r\n");
  assertEquals(parseRawHeaders(raw), {
    "content-type": "application/json",
    "x-request-id": "r1",
  });
});

Deno.test("parseRawHeaders: empty", () => {
  assertEquals(parseRawHeaders(""), {});
  assertEquals(parseRawHeaders(null), {});
});

Deno.test("bodySize: string counts characters", () => {
  assertEquals(bodySize("hello"), 5);
});

Deno.test("bodySize: null/undefined => 0", () => {
  assertEquals(bodySize(null), 0);
  assertEquals(bodySize(undefined), 0);
});

Deno.test("bodySize: Blob", () => {
  assertEquals(bodySize(new Blob(["hello world"])), 11);
});

Deno.test("bodySize: ArrayBuffer and TypedArray", () => {
  assertEquals(bodySize(new ArrayBuffer(16)), 16);
  assertEquals(bodySize(new Uint8Array(32)), 32);
});

Deno.test("bodySize: URLSearchParams", () => {
  assertEquals(bodySize(new URLSearchParams("a=1&b=2")), "a=1&b=2".length);
});

Deno.test("bodySize: FormData => -1 (unknown)", () => {
  assertEquals(bodySize(new FormData()), -1);
});

Deno.test("isUploadcareUrl matches known hosts", () => {
  assert(isUploadcareUrl("https://upload.uploadcare.com/base/"));
  assert(isUploadcareUrl("https://api.uploadcare.com/files/"));
  assert(isUploadcareUrl("https://abc123.ucarecdn.com/xxx-yyy/", "https://x/"));
  assertFalse(isUploadcareUrl("https://evil.com/upload"));
  assertFalse(isUploadcareUrl("not-a-url"));
});

Deno.test("isUploadcareUrl: base URL only used for relative", () => {
  assert(isUploadcareUrl("/upload", "https://api.uploadcare.com"));
  assertFalse(isUploadcareUrl("/upload", "https://example.com"));
});

Deno.test("urlOf: string vs Request-like", () => {
  assertEquals(urlOf("https://x/y"), "https://x/y");
  assertEquals(urlOf({ url: "https://x/y" }), "https://x/y");
});

Deno.test("methodOf: precedence of init over Request-like", () => {
  assertEquals(methodOf("x", { method: "post" }), "POST");
  assertEquals(methodOf({ method: "delete" }, undefined), "DELETE");
  assertEquals(methodOf("x", undefined), "GET");
});

Deno.test("sanitize: strips functions, keeps primitives", () => {
  const input = {
    a: 1,
    b: "s",
    c: null,
    d: [1, 2],
    e: () => 42,
  };
  const out = sanitize(input);
  assertEquals(out, { a: 1, b: "s", c: null, d: [1, 2] });
});

Deno.test("sanitize: converts BigInt to string", () => {
  assertEquals(sanitize({ n: 123n }), { n: "123" });
});

Deno.test("sanitize: File placeholder", () => {
  const f = new File(["hello"], "greeting.txt", { type: "text/plain" });
  assertEquals(sanitize({ file: f }), {
    file: { _kind: "File", name: "greeting.txt", size: 5, type: "text/plain" },
  });
});

Deno.test("sanitize: Blob placeholder", () => {
  const b = new Blob(["abc"], { type: "application/octet-stream" });
  assertEquals(sanitize({ blob: b }), {
    blob: { _kind: "Blob", size: 3, type: "application/octet-stream" },
  });
});

Deno.test("sanitize: Error placeholder", () => {
  const err = new Error("boom");
  const out = sanitize({ err });
  assertEquals(out.err._kind, "Error");
  assertEquals(out.err.name, "Error");
  assertEquals(out.err.message, "boom");
  assert(typeof out.err.stack === "string");
});

Deno.test("sanitize: cyclic input returns error marker", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const out = sanitize(cyclic);
  assert("_serializationError" in out);
});
