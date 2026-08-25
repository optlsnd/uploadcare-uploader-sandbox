import { assert, assertEquals } from "jsr:@std/assert";
import {
  extractFromRawBody,
  extractUploadcareError,
  isJsonContentType,
} from "../static/lib/uploadcare_errors.js";

/* -------- isJsonContentType -------- */

Deno.test("isJsonContentType: matches application/json and json variants", () => {
  assertEquals(isJsonContentType("application/json"), true);
  assertEquals(isJsonContentType("application/json; charset=utf-8"), true);
  assertEquals(isJsonContentType("application/problem+json"), true);
  assertEquals(isJsonContentType("APPLICATION/JSON"), true);
});

Deno.test("isJsonContentType: rejects non-JSON and missing values", () => {
  assertEquals(isJsonContentType("text/html"), false);
  assertEquals(isJsonContentType("text/plain"), false);
  assertEquals(isJsonContentType(null), false);
  assertEquals(isJsonContentType(undefined), false);
  assertEquals(isJsonContentType(""), false);
});

/* -------- extractUploadcareError -------- */

Deno.test("extractUploadcareError: nested { error: { status_code, content } }", () => {
  const r = extractUploadcareError({
    error: { status_code: 400, content: "Invalid pub key" },
  });
  assertEquals(r?.code, "400");
  assertEquals(r?.message, "Invalid pub key");
});

Deno.test("extractUploadcareError: nested { error: { message } }", () => {
  const r = extractUploadcareError({ error: { message: "quota exceeded" } });
  assertEquals(r?.message, "quota exceeded");
  assertEquals(r?.code, undefined);
});

Deno.test("extractUploadcareError: string error with error_uuid", () => {
  const r = extractUploadcareError({
    error: "Signature is invalid",
    error_uuid: "abc-123",
  });
  assertEquals(r?.code, "abc-123");
  assertEquals(r?.message, "Signature is invalid");
});

Deno.test("extractUploadcareError: string error without error_uuid", () => {
  const r = extractUploadcareError({ error: "Bad request" });
  assertEquals(r?.message, "Bad request");
  assertEquals(r?.code, undefined);
});

Deno.test("extractUploadcareError: { status: 'error', detail }", () => {
  const r = extractUploadcareError({ status: "error", detail: "rate limited" });
  assertEquals(r?.message, "rate limited");
});

Deno.test("extractUploadcareError: happy Uploadcare responses return null", () => {
  assertEquals(extractUploadcareError({ uuid: "abc", filename: "photo.jpg" }), null);
  assertEquals(extractUploadcareError({ file_url: "https://ucarecdn.com/..." }), null);
  assertEquals(extractUploadcareError({ status: "ok" }), null);
});

Deno.test("extractUploadcareError: rejects non-object inputs", () => {
  assertEquals(extractUploadcareError(null), null);
  assertEquals(extractUploadcareError(undefined), null);
  assertEquals(extractUploadcareError("plain string"), null);
  assertEquals(extractUploadcareError(42), null);
});

Deno.test("extractUploadcareError: empty error string is not an error", () => {
  assertEquals(extractUploadcareError({ error: "" }), null);
});

/* -------- extractFromRawBody -------- */

Deno.test("extractFromRawBody: parses JSON strings", () => {
  const r = extractFromRawBody('{"error":"bad key"}');
  assertEquals(r?.message, "bad key");
});

Deno.test("extractFromRawBody: returns null for non-JSON garbage", () => {
  assertEquals(extractFromRawBody("<html>server error</html>"), null);
  assertEquals(extractFromRawBody(""), null);
});

Deno.test("extractFromRawBody: returns null for JSON without an error shape", () => {
  assertEquals(extractFromRawBody('{"uuid":"x","filename":"y"}'), null);
});

Deno.test("extractFromRawBody: real Upload API 200-with-error example", () => {
  // Real Uploadcare Upload API sometimes returns a 200 with an error nested like this.
  const raw = JSON.stringify({
    error: {
      status_code: 400,
      content: "invalid pub_key parameter",
    },
  });
  const r = extractFromRawBody(raw);
  assert(r);
  assertEquals(r!.code, "400");
  assert(r!.message.includes("pub_key"));
});
