import { assertEquals } from "jsr:@std/assert";
import { applyDefaults, DEFAULT_PUBKEY, parseQuery, toKebabCase } from "../static/lib/config.js";

Deno.test("toKebabCase: leaves lowercase alone", () => {
  assertEquals(toKebabCase("pubkey"), "pubkey");
  assertEquals(toKebabCase("already-kebab"), "already-kebab");
});

Deno.test("toKebabCase: converts camelCase", () => {
  assertEquals(toKebabCase("sourceList"), "source-list");
  assertEquals(toKebabCase("cdnCnamePrefixed"), "cdn-cname-prefixed");
  assertEquals(toKebabCase("multipartMinFileSize"), "multipart-min-file-size");
});

Deno.test("toKebabCase: handles PascalCase and consecutive caps", () => {
  assertEquals(toKebabCase("CDNCname"), "-c-d-n-cname");
});

Deno.test("parseQuery: splits reserved vs forwarded", () => {
  const reserved = new Set(["variant", "label", "scenario", "_debug"]);
  const { forwarded, sandbox } = parseQuery(
    "?pubkey=k&sourceList=local,url&variant=inline&label=lbl&multiple=true",
    reserved,
  );
  assertEquals(forwarded, {
    "pubkey": "k",
    "source-list": "local,url",
    "multiple": "true",
  });
  assertEquals(sandbox, { variant: "inline", label: "lbl" });
});

Deno.test("parseQuery: tolerates missing leading '?'", () => {
  const { forwarded } = parseQuery("pubkey=k", new Set());
  assertEquals(forwarded, { pubkey: "k" });
});

Deno.test("parseQuery: empty inputs", () => {
  const empty = parseQuery("", new Set());
  assertEquals(empty.forwarded, {});
  assertEquals(empty.sandbox, {});
  const nullish = parseQuery(undefined, new Set());
  assertEquals(nullish.forwarded, {});
  assertEquals(nullish.sandbox, {});
});

Deno.test("parseQuery: accepts URLSearchParams", () => {
  const params = new URLSearchParams("pubkey=k&variant=inline");
  const { forwarded, sandbox } = parseQuery(params, new Set(["variant"]));
  assertEquals(forwarded, { pubkey: "k" });
  assertEquals(sandbox, { variant: "inline" });
});

Deno.test("parseQuery: repeated keys keep last value", () => {
  const { forwarded } = parseQuery("pubkey=a&pubkey=b", new Set());
  assertEquals(forwarded, { pubkey: "b" });
});

Deno.test("applyDefaults: adds default pubkey when missing", () => {
  assertEquals(applyDefaults({}), { pubkey: DEFAULT_PUBKEY });
});

Deno.test("applyDefaults: user pubkey wins over default", () => {
  assertEquals(applyDefaults({ pubkey: "my-key" }), { pubkey: "my-key" });
});

Deno.test("applyDefaults: preserves other keys", () => {
  assertEquals(
    applyDefaults({ "source-list": "local,url", "multiple": "true" }),
    { pubkey: DEFAULT_PUBKEY, "source-list": "local,url", "multiple": "true" },
  );
});

Deno.test("applyDefaults: DEFAULT_PUBKEY is 'demopublickey'", () => {
  assertEquals(DEFAULT_PUBKEY, "demopublickey");
});
