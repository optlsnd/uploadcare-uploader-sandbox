export const CATEGORIES = ["all", "network", "error", "uploader", "perf", "env", "other"];

/**
 * Classify an event into one of the filter categories.
 * @param {Record<string, unknown>} ev
 * @returns {"network"|"error"|"uploader"|"perf"|"env"|"other"}
 */
export function classifyEvent(ev) {
  const kind = ev?.kind;
  if (kind === "fetch" || kind === "fetch-error" || kind === "xhr" || kind === "xhr-error") {
    return "network";
  }
  if (kind === "js-error" || kind === "unhandled-rejection") return "error";
  if (kind === "console" && ev.level === "error") return "error";
  if (kind === "uploader-event") return "uploader";
  if (kind === "perf-resource") return "perf";
  if (kind === "probe-host" || kind === "probe-summary" || kind === "env-network-change") {
    return "env";
  }
  return "other";
}

/**
 * Return a one-line human summary of an event.
 * @param {Record<string, any>} ev
 * @returns {string}
 */
export function summarizeEvent(ev) {
  if (!ev || typeof ev !== "object") return "(invalid event)";
  const kind = ev.kind;
  switch (kind) {
    case "fetch":
    case "xhr":
      return `${ev.method ?? "?"} ${ev.url ?? "?"} → ${ev.status ?? "?"} (${
        ev.durationMs ?? "?"
      }ms)`;
    case "fetch-error":
    case "xhr-error": {
      const msg = ev.error && typeof ev.error === "object"
        ? (ev.error.message ?? ev.error.name ?? "error")
        : (ev.error ?? "error");
      return `${ev.method ?? "?"} ${ev.url ?? "?"} ✗ ${msg}`;
    }
    case "uploader-event":
      return ev.name ?? "(unnamed)";
    case "js-error":
      return `${ev.message ?? "error"} @ ${ev.filename ?? "?"}:${ev.lineno ?? "?"}:${
        ev.colno ?? "?"
      }`;
    case "unhandled-rejection":
      return String(ev.reason ?? "(no reason)");
    case "console": {
      const args = Array.isArray(ev.args) ? ev.args : [];
      const rendered = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      return `${ev.level ?? "log"}: ${rendered}`;
    }
    case "perf-resource":
      return `${ev.name ?? "?"} (${ev.durationMs ?? "?"}ms, ${ev.transferSize ?? "?"}B)`;
    case "probe-host": {
      const host = ev.host ?? "?";
      const ms = typeof ev.ms === "number" ? `${ev.ms}ms` : "?ms";
      if (ev.ok) return `${host} ✓ ${ms}`;
      return `${host} ✗ ${ev.error ?? "network"} (${ms})`;
    }
    case "probe-summary": {
      const results = Array.isArray(ev.results) ? ev.results : [];
      const ok = results.filter((r) => r?.ok).length;
      return `host probes: ${ok}/${results.length} reachable`;
    }
    case "env-network-change": {
      const c = ev.connection;
      if (!c) return `online=${ev.onLine}`;
      return `online=${ev.onLine} · ${c.effectiveType ?? "?"} · ${c.downlink ?? "?"}Mbps · rtt ${
        c.rtt ?? "?"
      }ms`;
    }
    default:
      return String(kind ?? "unknown");
  }
}

/**
 * Format an event's timestamp as offset from session start.
 * @param {number|undefined} ts
 * @param {number|undefined} createdAt
 * @returns {string}
 */
export function relativeTimestamp(ts, createdAt) {
  if (typeof ts !== "number" || typeof createdAt !== "number") return "";
  const delta = ts - createdAt;
  if (delta < 0) return `-${(-delta / 1000).toFixed(3)}s`;
  return `+${(delta / 1000).toFixed(3)}s`;
}

/**
 * Count events by category.
 * @param {Array<Record<string, unknown>>} events
 * @returns {Record<string, number>}
 */
export function countByCategory(events) {
  /** @type {Record<string, number>} */
  const counts = {
    all: events.length,
    network: 0,
    error: 0,
    uploader: 0,
    perf: 0,
    env: 0,
    other: 0,
  };
  for (const ev of events) counts[classifyEvent(ev)]++;
  return counts;
}

const NETWORK_KINDS = new Set(["fetch", "fetch-error", "xhr", "xhr-error"]);
const PERF_CORRELATION_WINDOW_MS = 5000;

/**
 * Enrich network events (fetch / xhr / their -error variants) with the
 * closest matching `perf-resource` entry, attaching it as `_perf` on a
 * cloned event. Match rule: exact URL, and `perf.ts` within
 * `PERF_CORRELATION_WINDOW_MS` of the network event's `ts`.
 * @param {Array<Record<string, any>>} events
 * @returns {Array<Record<string, any>>}
 */
export function correlatePerf(events) {
  /** @type {Map<string, Array<Record<string, any>>>} */
  const perfByUrl = new Map();
  for (const ev of events) {
    if (ev?.kind !== "perf-resource" || typeof ev.name !== "string") continue;
    const arr = perfByUrl.get(ev.name);
    if (arr) arr.push(ev);
    else perfByUrl.set(ev.name, [ev]);
  }
  if (perfByUrl.size === 0) return events;
  return events.map((ev) => {
    if (!ev || !NETWORK_KINDS.has(ev.kind) || typeof ev.url !== "string") return ev;
    const candidates = perfByUrl.get(ev.url);
    if (!candidates?.length) return ev;
    const networkTs = Number(ev.ts) || 0;
    let best = null;
    let bestDelta = Infinity;
    for (const p of candidates) {
      const delta = Math.abs((Number(p.ts) || 0) - networkTs);
      if (delta < bestDelta) {
        best = p;
        bestDelta = delta;
      }
    }
    if (!best || bestDelta > PERF_CORRELATION_WINDOW_MS) return ev;
    return { ...ev, _perf: best };
  });
}

/**
 * Filter events for the session view. Returns events matching both the
 * category tab and (if provided) a case-insensitive substring against
 * the event's kind, URL/name, and summarized text.
 * @param {Array<Record<string, unknown>>} events
 * @param {string} category  "all" | one of the classifyEvent outputs
 * @param {string} search    case-insensitive substring; empty = no filter
 * @returns {Array<Record<string, unknown>>}
 */
export function filterEvents(events, category, search) {
  const q = typeof search === "string" ? search.trim().toLowerCase() : "";
  return events.filter((ev) => {
    if (category !== "all" && classifyEvent(ev) !== category) return false;
    if (!q) return true;
    const hay = [
      String(ev?.kind ?? ""),
      String(ev?.url ?? ""),
      String(ev?.name ?? ""),
      summarizeEvent(ev),
    ].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

/**
 * Compute duration between the first and last event in a session, in ms.
 * @param {Array<{ ts?: number }>} events
 * @returns {number|null}
 */
export function sessionDurationMs(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const ev of events) {
    const t = Number(ev?.ts);
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return max - min;
}
