import {
  bodySize,
  filterHeaders,
  isUploadcareUrl,
  methodOf,
  parseRawHeaders,
  safeHeaderName,
  sanitize,
  urlOf,
} from "/lib/serialize.js";
import { randomUUID } from "/lib/id.js";
import { captureBaseline, captureNetwork, onNetworkChange } from "/lib/env.js";
import { DEFAULT_HOSTS, probeHost } from "/lib/probes.js";

const SESSION_ENDPOINT = "/api/session";
const EVENT_ENDPOINT = "/api/event";
const BEACON_ENDPOINT = "/api/event-beacon";
const BEACON_HEADER = "X-Sandbox-Beacon";
const USER_ID_KEY = "sandbox-user-id";
const FLUSH_INTERVAL_MS = 3000;
const FLUSH_BATCH_SIZE = 20;

const originalFetch = globalThis.fetch.bind(globalThis);
const OriginalXHR = globalThis.XMLHttpRequest;
const originalConsole = {
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function ensureUserId() {
  let id;
  try {
    id = localStorage.getItem(USER_ID_KEY);
  } catch {
    /* private mode etc. */
  }
  if (!id) id = randomUUID();
  try {
    localStorage.setItem(USER_ID_KEY, id);
  } catch {
    /* ignore */
  }
  document.cookie = `${USER_ID_KEY}=${id}; path=/; max-age=31536000; SameSite=Lax`;
  return id;
}

const userId = ensureUserId();
const sessionId = randomUUID();
let seq = 0;
const buffer = [];
let flushTimer = null;

function isOwnBeacon(url, headers) {
  if (
    url.endsWith(EVENT_ENDPOINT) ||
    url.endsWith(BEACON_ENDPOINT) ||
    url.endsWith(SESSION_ENDPOINT)
  ) return true;
  if (headers && (headers[BEACON_HEADER] || headers[BEACON_HEADER.toLowerCase()])) return true;
  return false;
}

function emit(kind, data) {
  buffer.push({
    ts: Date.now(),
    seq: seq++,
    userId,
    sessionId,
    kind,
    ...data,
  });
  if (buffer.length >= FLUSH_BATCH_SIZE) {
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
}

function flush(useBeacon = false) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  const payload = JSON.stringify({ userId, sessionId, events: batch });
  if (useBeacon && navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });
    navigator.sendBeacon(BEACON_ENDPOINT, blob);
  } else {
    originalFetch(EVENT_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [BEACON_HEADER]: "1",
      },
      body: payload,
      keepalive: true,
    }).catch(() => {/* tolerate */});
  }
}

// ---------- fetch wrapper ----------
globalThis.fetch = async function instrumentedFetch(input, init) {
  const url = urlOf(input);
  const initHeaders = init?.headers;
  const method = methodOf(input, init);
  if (isOwnBeacon(url, initHeaders && Object.fromEntries(new Headers(initHeaders).entries()))) {
    return originalFetch(input, init);
  }
  const startedAt = performance.now();
  const record = {
    url,
    method,
    requestHeaders: filterHeaders(initHeaders),
    requestBodySize: bodySize(init?.body),
    isUploadcare: isUploadcareUrl(url, location.href),
  };
  try {
    const response = await originalFetch(input, init);
    emit("fetch", {
      ...record,
      status: response.status,
      ok: response.ok,
      durationMs: Math.round(performance.now() - startedAt),
      responseHeaders: filterHeaders(response.headers),
    });
    return response;
  } catch (err) {
    emit("fetch-error", {
      ...record,
      error: { name: err?.name, message: String(err?.message ?? err) },
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw err;
  }
};

// ---------- XHR wrapper ----------
globalThis.XMLHttpRequest = class InstrumentedXHR extends OriginalXHR {
  constructor() {
    super();
    this._sb = {
      method: "GET",
      url: "",
      requestHeaders: {},
      requestBodySize: 0,
      startedAt: 0,
      errorType: null,
    };
    this.addEventListener("loadend", () => {
      if (isOwnBeacon(this._sb.url, null)) return;
      const durationMs = Math.round(performance.now() - this._sb.startedAt);
      const base = {
        url: this._sb.url,
        method: this._sb.method,
        requestHeaders: this._sb.requestHeaders,
        requestBodySize: this._sb.requestBodySize,
        durationMs,
        isUploadcare: isUploadcareUrl(this._sb.url, location.href),
      };
      if (this.readyState === 4 && this.status > 0 && !this._sb.errorType) {
        emit("xhr", {
          ...base,
          status: this.status,
          ok: this.status >= 200 && this.status < 300,
          responseHeaders: parseRawHeaders(this.getAllResponseHeaders()),
        });
      } else {
        emit("xhr-error", {
          ...base,
          error: this._sb.errorType || "unknown",
          status: this.status || null,
        });
      }
    });
    this.addEventListener("error", () => {
      this._sb.errorType = "network";
    });
    this.addEventListener("abort", () => {
      this._sb.errorType = "abort";
    });
    this.addEventListener("timeout", () => {
      this._sb.errorType = "timeout";
    });
  }
  open(method, url, ...rest) {
    this._sb.method = String(method).toUpperCase();
    this._sb.url = String(url);
    return super.open(method, url, ...rest);
  }
  setRequestHeader(name, value) {
    if (safeHeaderName(name)) {
      this._sb.requestHeaders[String(name).toLowerCase()] = String(value);
    }
    return super.setRequestHeader(name, value);
  }
  send(body) {
    this._sb.startedAt = performance.now();
    this._sb.requestBodySize = bodySize(body);
    return super.send(body);
  }
};

// ---------- errors ----------
addEventListener("error", (e) => {
  emit("js-error", {
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    stack: e.error?.stack,
  });
});

addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  emit("unhandled-rejection", {
    reason: typeof r === "string" ? r : r?.message ?? String(r),
    stack: r?.stack,
  });
});

for (const level of ["warn", "error"]) {
  const original = originalConsole[level];
  console[level] = function (...args) {
    emit("console", { level, args: sanitize(args) });
    return original(...args);
  };
}

// ---------- perf ----------
if ("PerformanceObserver" in globalThis) {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!isUploadcareUrl(entry.name, location.href)) continue;
        emit("perf-resource", {
          name: entry.name,
          initiatorType: entry.initiatorType,
          durationMs: Math.round(entry.duration),
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          startTime: Math.round(entry.startTime),
          responseEnd: Math.round(entry.responseEnd),
          nextHopProtocol: entry.nextHopProtocol,
        });
      }
    });
    obs.observe({ type: "resource", buffered: true });
  } catch { /* older browsers */ }
}

// ---------- session registration ----------
function collectEnv() {
  const baseline = captureBaseline();
  const network = captureNetwork();
  return { ...baseline, ...network };
}

originalFetch(SESSION_ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json", [BEACON_HEADER]: "1" },
  body: JSON.stringify({
    userId,
    sessionId,
    startedAt: Date.now(),
    env: collectEnv(),
  }),
  keepalive: true,
}).catch(() => {/* tolerate 501 stub */});

// Follow up on network condition changes during the session.
onNetworkChange((snapshot) => {
  emit("env-network-change", snapshot);
});

// Fire host reachability probes in parallel. Each result is emitted as
// an event so the timeline shows them in order; a single summary event
// gathers them for the environment panel.
(async () => {
  const started = Date.now();
  /** @type {any[]} */
  const results = [];
  await Promise.all(DEFAULT_HOSTS.map(async (host) => {
    try {
      const r = await probeHost(host, { fetch: originalFetch });
      results.push(r);
      emit("probe-host", r);
    } catch (err) {
      const r = {
        host,
        ok: false,
        ms: 0,
        error: "unexpected",
        message: String(err),
      };
      results.push(r);
      emit("probe-host", r);
    }
  }));
  emit("probe-summary", {
    startedAt: started,
    finishedAt: Date.now(),
    results,
  });
})();

// ---------- flush triggers ----------
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush(true);
});
addEventListener("pagehide", () => flush(true));

// ---------- uploader lifecycle events ----------
const UPLOADER_EVENTS = [
  "file-added",
  "file-removed",
  "file-upload-start",
  "file-upload-progress",
  "file-upload-success",
  "file-upload-failed",
  "common-upload-start",
  "common-upload-progress",
  "common-upload-success",
  "common-upload-failed",
  "done-flow",
  "change",
  "modal-open",
  "modal-close",
  "activity-change",
];

export function attachUploaderEvents(target) {
  for (const name of UPLOADER_EVENTS) {
    target.addEventListener(name, (event) => {
      emit("uploader-event", { name, detail: sanitize(event.detail) });
    });
  }
}

export const identity = { userId, sessionId };
export { flush };

globalThis.__sandbox = {
  userId,
  sessionId,
  get buffer() {
    return buffer.slice();
  },
  flush: () => flush(),
};
