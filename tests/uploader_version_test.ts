import { assertEquals } from "jsr:@std/assert";
import { resolveUploaderVersion, uploaderCdnUrl } from "../static/lib/uploader_version.js";

Deno.test("resolveUploaderVersion: missing → latest", () => {
  assertEquals(resolveUploaderVersion(undefined), {
    version: "latest",
    requested: null,
    ok: true,
  });
  assertEquals(resolveUploaderVersion(null), { version: "latest", requested: null, ok: true });
  assertEquals(resolveUploaderVersion(""), { version: "latest", requested: null, ok: true });
});

Deno.test("resolveUploaderVersion: explicit `latest` is accepted", () => {
  assertEquals(resolveUploaderVersion("latest"), {
    version: "latest",
    requested: "latest",
    ok: true,
  });
});

Deno.test("resolveUploaderVersion: bare semver is accepted", () => {
  assertEquals(resolveUploaderVersion("1.31.2"), {
    version: "1.31.2",
    requested: "1.31.2",
    ok: true,
  });
  assertEquals(resolveUploaderVersion("2.0.0"), {
    version: "2.0.0",
    requested: "2.0.0",
    ok: true,
  });
});

Deno.test("resolveUploaderVersion: pre-release semver is accepted", () => {
  const r = resolveUploaderVersion("1.32.0-beta.1");
  assertEquals(r.ok, true);
  assertEquals(r.version, "1.32.0-beta.1");
});

Deno.test("resolveUploaderVersion: trims whitespace", () => {
  assertEquals(resolveUploaderVersion("  1.31.2  ").version, "1.31.2");
});

Deno.test("resolveUploaderVersion: garbage falls back to latest with ok=false", () => {
  const cases = [
    "1.31",
    "1",
    "v1.31.2",
    "latest/../etc",
    "1.31.2; rm -rf /",
    "../../../evil",
    "1.31.2/../file",
    "^1.31.2",
    "~1.31.2",
  ];
  for (const c of cases) {
    const r = resolveUploaderVersion(c);
    assertEquals(r.version, "latest", `expected fallback for ${c}`);
    assertEquals(r.ok, false, `expected ok=false for ${c}`);
    assertEquals(r.requested, c);
  }
});

Deno.test("uploaderCdnUrl: builds jsDelivr URL", () => {
  assertEquals(
    uploaderCdnUrl("1.31.2"),
    "https://cdn.jsdelivr.net/npm/@uploadcare/file-uploader@1.31.2/web/file-uploader.min.js",
  );
  assertEquals(
    uploaderCdnUrl("latest"),
    "https://cdn.jsdelivr.net/npm/@uploadcare/file-uploader@latest/web/file-uploader.min.js",
  );
});
