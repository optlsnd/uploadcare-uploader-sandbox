import {
  CATEGORIES,
  classifyEvent,
  correlatePerf,
  countByCategory,
  filterEvents,
  relativeTimestamp,
  sessionDurationMs,
  summarizeEvent,
} from "/lib/session.js";

const CATEGORY_LABELS = {
  all: "All",
  network: "Network",
  error: "Errors",
  uploader: "Uploader",
  perf: "Perf",
  env: "Env",
  other: "Other",
};

function sessionIdFromPath() {
  const m = location.pathname.match(/^\/session\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

const FILTER_KEYS = ["userId", "pubkey", "label", "hasError"];

function readFilterParams() {
  const src = new URLSearchParams(location.search);
  const out = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = src.get(k);
    if (v !== null && v !== "") out.set(k, v);
  }
  return out;
}

function withParams(path, params) {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function fmtAbsolute(ts) {
  if (typeof ts !== "number") return "";
  return new Date(ts).toISOString().replace("T", " ").replace("Z", " UTC");
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "on") {
      for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    } else if (v === true) node.setAttribute(k, "");
    else if (v === false || v == null) { /* skip */ }
    else node.setAttribute(k, String(v));
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c != null) node.append(c);
  }
  return node;
}

function fmtDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(1);
  return `${m}m ${s}s`;
}

function renderMeta(container, session, durationMs, adminMode) {
  container.innerHTML = "";
  const add = (text) => container.append(document.createTextNode(text));
  const sep = () => container.append(document.createTextNode(" · "));
  let first = true;
  const push = (fn) => {
    if (!first) sep();
    fn();
    first = false;
  };
  if (session.pubkey) push(() => add(`pubkey: ${session.pubkey}`));
  if (session.label) push(() => add(`label: ${session.label}`));
  push(() => {
    add("user: ");
    if (adminMode) {
      const link = document.createElement("a");
      link.href = `/admin?userId=${encodeURIComponent(session.userId)}`;
      link.textContent = session.userId;
      container.append(link);
    } else {
      add(session.userId);
    }
  });
  push(() => add(`events: ${session.eventCount ?? 0}`));
  push(() => add(`created: ${fmtAbsolute(session.createdAt)}`));
  const d = fmtDuration(durationMs);
  if (d) push(() => add(`duration: ${d}`));
}

function renderEnvKV(entries) {
  const dl = el("dl", { class: "env-kv" });
  for (const [k, v] of entries) {
    dl.append(el("dt", { text: k }));
    dl.append(el("dd", { text: v == null || v === "" ? "—" : String(v) }));
  }
  return dl;
}

function envSummaryEntries(env) {
  if (!env || typeof env !== "object") return [];
  const conn = env.connection;
  const scr = env.screen ?? {};
  const vp = env.viewport ?? {};
  const mm = env.matchMedia ?? {};
  const langs = Array.isArray(env.languages) ? env.languages.join(", ") : env.language;
  return [
    ["User-Agent", env.userAgent],
    ["Platform", env.platform],
    ["Language(s)", langs],
    ["Timezone", `${env.timezone ?? "?"} (offset ${env.timezoneOffset ?? "?"})`],
    ["Cores", env.hardwareConcurrency],
    ["Screen", `${scr.width ?? "?"}×${scr.height ?? "?"} @${scr.colorDepth ?? "?"}bit`],
    ["Viewport", `${vp.width ?? "?"}×${vp.height ?? "?"} @${vp.devicePixelRatio ?? "?"}x`],
    [
      "Prefers",
      `dark=${mm.dark} reducedMotion=${mm.reducedMotion} hover=${mm.hoverable} finePointer=${mm.finePointer}`,
    ],
    ["Secure context", env.isSecureContext],
    ["Online", env.onLine],
    ["Cookies enabled", env.cookieEnabled],
    ["DNT", env.doNotTrack],
    [
      "Connection",
      conn
        ? `${conn.effectiveType ?? "?"} · ${conn.downlink ?? "?"}Mbps · rtt ${
          conn.rtt ?? "?"
        }ms · saveData=${conn.saveData} · type=${conn.type ?? "?"}`
        : "unavailable",
    ],
    ["Referrer", env.referrer],
    ["URL", env.url],
  ];
}

function renderProbeTable(latestByHost) {
  const table = el("table", { class: "probe-table" });
  const thead = el("thead", {}, [
    el("tr", {}, [
      el("th", { text: "host" }),
      el("th", { text: "status" }),
      el("th", { class: "num", text: "ms" }),
      el("th", { text: "detail" }),
    ]),
  ]);
  const tbody = el("tbody");
  const rows = Array.from(latestByHost.entries());
  rows.sort(([a], [b]) => a.localeCompare(b));
  for (const [host, r] of rows) {
    const okClass = r.ok ? "probe-ok" : "probe-fail";
    tbody.append(
      el("tr", { class: okClass }, [
        el("td", { class: "mono", text: host }),
        el("td", { text: r.ok ? "reachable" : "unreachable" }),
        el("td", { class: "num", text: String(r.ms ?? "?") }),
        el("td", { text: r.ok ? (r.type ?? "") : (r.error ?? r.message ?? "") }),
      ]),
    );
  }
  table.append(thead, tbody);
  return table;
}

function renderSpeedtest(ev) {
  const dl = el("dl", { class: "env-kv" });
  if (ev.error) {
    dl.append(el("dt", { text: "Speedtest" }));
    dl.append(el("dd", { text: `failed: ${ev.error}` }));
    return dl;
  }
  const fmt = (r) => {
    if (!r) return "—";
    if (r.error) return `error: ${r.error}`;
    return `${r.mbps} Mbps (${r.bytes ?? "?"} B in ${r.ms ?? "?"} ms)`;
  };
  dl.append(el("dt", { text: "Download" }));
  dl.append(el("dd", { text: fmt(ev.download) }));
  dl.append(el("dt", { text: "Upload" }));
  dl.append(el("dd", { text: fmt(ev.upload) }));
  return dl;
}

function renderEnvPanel(section, session, events) {
  section.innerHTML = "";
  const probesByHost = new Map();
  let latestSpeedtest = null;
  for (const ev of events) {
    if (ev?.kind === "probe-host" && typeof ev.host === "string") {
      probesByHost.set(ev.host, ev);
    } else if (ev?.kind === "speedtest") {
      latestSpeedtest = ev;
    }
  }

  const wrap = el("details", { class: "env-details", open: true });
  wrap.append(el("summary", { text: "Environment" }));

  const envEntries = envSummaryEntries(session?.env);
  if (envEntries.length) wrap.append(renderEnvKV(envEntries));

  if (latestSpeedtest) {
    wrap.append(el("h3", { class: "env-subheader", text: "Measured network speed" }));
    wrap.append(renderSpeedtest(latestSpeedtest));
  }

  if (probesByHost.size) {
    wrap.append(el("h3", { class: "env-subheader", text: "Uploadcare host reachability" }));
    wrap.append(renderProbeTable(probesByHost));
  }

  section.append(wrap);
  section.hidden = false;
}

function renderFilters(counts, active, onChange) {
  const wrap = document.createDocumentFragment();
  for (const cat of CATEGORIES) {
    const btn = el("button", {
      type: "button",
      class: "filter" + (cat === active ? " active" : ""),
      "data-cat": cat,
      on: { click: () => onChange(cat) },
    }, [`${CATEGORY_LABELS[cat]} (${counts[cat] ?? 0})`]);
    wrap.append(btn);
  }
  return wrap;
}

function renderRow(ev, createdAt) {
  const cat = classifyEvent(ev);
  const summary = summarizeEvent(ev);
  const rel = relativeTimestamp(ev.ts, createdAt);
  const abs = fmtAbsolute(ev.ts);
  const status = typeof ev.status === "number" ? ev.status : null;
  const errored = cat === "error" ||
    ev.kind === "fetch-error" ||
    ev.kind === "xhr-error" ||
    (status !== null && status >= 400);

  const row = el("details", {
    class: "row row-" + cat + (errored ? " row-error" : ""),
    "data-cat": cat,
  });
  const summaryChildren = [
    el("span", { class: "row-time", title: abs, text: rel }),
    el("span", { class: "row-kind", text: ev.kind }),
    el("span", { class: "row-summary", text: summary }),
  ];
  if (ev._perf) {
    const transfer = typeof ev._perf.transferSize === "number" ? `${ev._perf.transferSize}B` : "?B";
    summaryChildren.push(
      el("span", {
        class: "row-badge",
        title: "Correlated resource-timing entry",
        text: `perf ${transfer}`,
      }),
    );
  }
  const summaryEl = el("summary", {}, summaryChildren);
  const pre = el("pre", { class: "row-json", text: JSON.stringify(ev, null, 2) });
  row.append(summaryEl, pre);
  return row;
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function showError(message) {
  document.getElementById("timeline").append(
    el("div", { class: "empty", text: message }),
  );
}

async function main() {
  const sessionId = sessionIdFromPath();
  if (!sessionId) {
    showError("No session id in URL.");
    return;
  }
  document.getElementById("session-title").textContent = `Session ${sessionId}`;

  let payload;
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`);
    if (res.status === 404) {
      showError("Session not found.");
      return;
    }
    if (!res.ok) {
      showError(`Failed to load session (HTTP ${res.status}).`);
      return;
    }
    payload = await res.json();
  } catch (err) {
    showError(`Failed to load session: ${err}`);
    return;
  }

  const { session, events: rawEvents } = payload;

  const controls = document.getElementById("session-controls");
  const filters = document.getElementById("filters");
  const timeline = document.getElementById("timeline");
  const searchInput = document.getElementById("search");

  rawEvents.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const events = correlatePerf(rawEvents);

  // Try admin-only neighbors endpoint. If it succeeds, viewer is an
  // admin — show Back/Prev/Next nav and make the userId clickable.
  // Public viewers get a plain read-only session view.
  const filterParams = readFilterParams();
  let adminMode = false;
  try {
    const nurl = withParams(
      `/api/admin/session/${encodeURIComponent(sessionId)}/neighbors`,
      filterParams,
    );
    const nres = await fetch(nurl);
    if (nres.ok) {
      adminMode = true;
      const { prev, next } = await nres.json();
      document.getElementById("nav-back").href = withParams("/admin", filterParams);
      if (prev) {
        const p = document.getElementById("nav-prev");
        p.href = withParams(`/session/${prev}`, filterParams);
        p.hidden = false;
      }
      if (next) {
        const n = document.getElementById("nav-next");
        n.href = withParams(`/session/${next}`, filterParams);
        n.hidden = false;
      }
      document.getElementById("session-nav").hidden = false;
    }
  } catch { /* public viewer — leave nav hidden */ }

  renderMeta(
    document.getElementById("session-meta"),
    session,
    sessionDurationMs(events),
    adminMode,
  );

  const counts = countByCategory(events);
  let active = "all";
  let query = "";

  const rerenderFilters = () => {
    filters.innerHTML = "";
    filters.append(renderFilters(counts, active, (cat) => {
      active = cat;
      rerenderFilters();
      rerenderRows();
    }));
  };
  const rerenderRows = () => {
    timeline.innerHTML = "";
    const rows = filterEvents(events, active, query);
    if (rows.length === 0) {
      timeline.append(el("div", { class: "empty", text: "No events match." }));
      return;
    }
    for (const ev of rows) timeline.append(renderRow(ev, session.createdAt));
  };

  controls.hidden = false;
  renderEnvPanel(document.getElementById("env-panel"), session, events);
  rerenderFilters();
  rerenderRows();

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    rerenderRows();
  });

  document.getElementById("copy-json").addEventListener("click", async () => {
    await copyText(JSON.stringify(payload, null, 2));
  });
  document.getElementById("download-json").addEventListener("click", () => {
    downloadText(`session-${sessionId}.json`, JSON.stringify(payload, null, 2));
  });
}

main();
