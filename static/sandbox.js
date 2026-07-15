import { attachUploaderEvents, identity } from "/instrumentation.js";
import { applyDefaults, parseQuery } from "/lib/config.js";
import { applyPreset, PRESET_NAMES } from "/lib/presets.js";
import * as UC from "https://cdn.jsdelivr.net/npm/@uploadcare/file-uploader@1.31.2/web/file-uploader.min.js";

UC.defineComponents(UC);

const RESERVED_KEYS = new Set(["variant", "label", "scenario", "_debug"]);
const VALID_VARIANTS = new Set(["regular", "inline", "minimal"]);

function mountUploader(slot, variant, forwarded) {
  const ctxName = "sandbox-" + Math.random().toString(36).slice(2, 10);

  const config = document.createElement("uc-config");
  config.setAttribute("ctx-name", ctxName);
  for (const [attr, value] of Object.entries(forwarded)) {
    config.setAttribute(attr, value);
  }

  const uploader = document.createElement(`uc-file-uploader-${variant}`);
  uploader.setAttribute("ctx-name", ctxName);

  const ctxProvider = document.createElement("uc-upload-ctx-provider");
  ctxProvider.setAttribute("ctx-name", ctxName);

  slot.innerHTML = "";
  slot.append(config, uploader, ctxProvider);
  return { ctxName, ctxProvider };
}

function renderConfigPanel(panel, forwarded, sandbox, meta) {
  panel.innerHTML = "";
  const block = (title, obj) => {
    const wrap = document.createElement("div");
    wrap.className = "config-block";
    const h = document.createElement("h3");
    h.textContent = title;
    wrap.append(h);
    if (!obj || Object.keys(obj).length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "(none)";
      wrap.append(empty);
    } else {
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(obj, null, 2);
      wrap.append(pre);
    }
    panel.append(wrap);
  };
  block("Identity", { userId: identity.userId, sessionId: identity.sessionId });
  block("Meta", meta);
  block("Forwarded to uploader (uc-config attributes)", forwarded);
  block("Sandbox-only", sandbox);
}

function renderInsecureBanner() {
  if (window.isSecureContext) return;
  const banner = document.createElement("div");
  banner.className = "insecure-banner";
  banner.innerHTML = "<strong>Not a secure context.</strong> " +
    "The uploader uses <code>crypto.subtle</code> which is only available on " +
    "HTTPS, <code>localhost</code>, or <code>127.0.0.1</code>. " +
    "You appear to be on <code>" + location.host + "</code> — some uploader " +
    "features will fail. Open the page via <code>http://localhost:8000/</code> " +
    "(or over HTTPS on Deno Deploy).";
  document.body.prepend(banner);
}

function main() {
  renderInsecureBanner();
  const slot = document.getElementById("uploader-slot");
  const panel = document.getElementById("config-panel");
  const { forwarded: rawForwarded, sandbox } = parseQuery(location.search, RESERVED_KEYS);
  const withPreset = applyPreset(sandbox.scenario, rawForwarded);
  const forwarded = applyDefaults(withPreset);

  const variant = VALID_VARIANTS.has(sandbox.variant) ? sandbox.variant : "regular";
  const scenarioApplied = sandbox.scenario && PRESET_NAMES.includes(sandbox.scenario)
    ? sandbox.scenario
    : null;
  const { ctxName, ctxProvider } = mountUploader(slot, variant, forwarded);
  attachUploaderEvents(ctxProvider);
  renderConfigPanel(panel, forwarded, sandbox, {
    variant,
    ctxName,
    mounted: true,
    scenarioApplied,
    availableScenarios: PRESET_NAMES,
  });
}

main();
