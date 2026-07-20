const FILTER_IDS = ["userId", "pubkey", "label"];
const ALL_FILTER_KEYS = [...FILTER_IDS, "hasError"];

function fmtAbsolute(ts) {
  if (typeof ts !== "number") return "—";
  return new Date(ts).toISOString().replace("T", " ").replace("Z", "");
}

function shortId(id) {
  if (typeof id !== "string" || id.length <= 12) return id ?? "";
  return id.slice(0, 8) + "…";
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (v === true) node.setAttribute(k, "");
    else if (v === false || v == null) { /* skip */ }
    else node.setAttribute(k, String(v));
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c != null) node.append(c);
  }
  return node;
}

/**
 * Read filter state from the current URL. If the URL contains NO filter
 * params at all, default `hasError` to true so the admin lands on error
 * sessions by default. Any explicit filter in the URL (even just
 * `?userId=x`) turns off that default.
 */
function readInitialFilters() {
  const params = new URLSearchParams(location.search);
  const hasAny = ALL_FILTER_KEYS.some((k) => params.has(k));
  return {
    userId: params.get("userId") ?? "",
    pubkey: params.get("pubkey") ?? "",
    label: params.get("label") ?? "",
    hasError: hasAny ? params.get("hasError") === "true" : true,
  };
}

function writeFormFromFilters(f) {
  for (const id of FILTER_IDS) {
    document.getElementById(`filter-${id}`).value = f[id];
  }
  document.getElementById("filter-hasError").checked = !!f.hasError;
}

function readFormFilters() {
  const out = { hasError: document.getElementById("filter-hasError").checked };
  for (const id of FILTER_IDS) {
    const v = document.getElementById(`filter-${id}`).value.trim();
    out[id] = v;
  }
  return out;
}

function filtersToParams(f) {
  const params = new URLSearchParams();
  for (const id of FILTER_IDS) if (f[id]) params.set(id, f[id]);
  if (f.hasError) params.set("hasError", "true");
  return params;
}

function pushFiltersToUrl(f) {
  const qs = filtersToParams(f).toString();
  const url = qs ? `?${qs}` : location.pathname;
  history.replaceState(null, "", url);
}

async function deleteSession(sessionId, onSuccess) {
  const label = shortId(sessionId);
  if (!confirm(`Delete session ${label}? This is permanent.`)) return;
  try {
    const res = await fetch(`/api/admin/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      alert(`Delete failed: HTTP ${res.status}`);
      return;
    }
    onSuccess();
  } catch (err) {
    alert(`Delete failed: ${err}`);
  }
}

function renderTable(sessions, filters, onDeleted) {
  const results = document.getElementById("results");
  results.innerHTML = "";
  if (sessions.length === 0) {
    results.append(el("div", { class: "empty", text: "No sessions match these filters." }));
    return;
  }
  const suffix = filtersToParams(filters).toString();
  const viewHref = (id) => `/session/${id}${suffix ? `?${suffix}` : ""}`;

  const table = el("table", { class: "sessions-table" });
  const thead = el("thead", {}, [
    el("tr", {}, [
      el("th", { text: "created" }),
      el("th", { text: "session" }),
      el("th", { text: "pubkey" }),
      el("th", { text: "label" }),
      el("th", { text: "user" }),
      el("th", { class: "num", text: "events" }),
      el("th", { class: "num", text: "errors" }),
      el("th", {}),
      el("th", {}),
    ]),
  ]);
  const tbody = el("tbody");
  for (const s of sessions) {
    const deleteBtn = el("button", {
      type: "button",
      class: "row-delete",
      title: `Delete session ${s.sessionId}`,
      text: "×",
    });
    deleteBtn.addEventListener("click", () => {
      deleteSession(s.sessionId, onDeleted);
    });
    const tr = el("tr", { class: s.errorCount > 0 ? "has-errors" : "" }, [
      el("td", { text: fmtAbsolute(s.createdAt), title: String(s.createdAt) }),
      el(
        "td",
        { class: "mono", title: s.sessionId },
        [el("a", { href: viewHref(s.sessionId), text: shortId(s.sessionId) })],
      ),
      el("td", { text: s.pubkey ?? "—" }),
      el("td", { text: s.label ?? "—" }),
      el("td", { class: "mono", title: s.userId, text: shortId(s.userId) }),
      el("td", { class: "num", text: String(s.eventCount ?? 0) }),
      el(
        "td",
        { class: "num" + (s.errorCount > 0 ? " err" : ""), text: String(s.errorCount ?? 0) },
      ),
      el("td", {}, [el("a", { href: viewHref(s.sessionId), text: "view →" })]),
      el("td", { class: "row-actions" }, [deleteBtn]),
    ]);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  results.append(table);
}

async function fetchAndRender() {
  const filters = readFormFilters();
  pushFiltersToUrl(filters);
  const meta = document.getElementById("admin-meta");
  meta.textContent = "Loading…";
  const url = "/api/admin/sessions" +
    (filtersToParams(filters).toString() ? "?" + filtersToParams(filters).toString() : "");
  try {
    const res = await fetch(url);
    if (!res.ok) {
      meta.textContent = `Failed to load sessions (HTTP ${res.status}).`;
      return;
    }
    const { sessions } = await res.json();
    meta.textContent = `${sessions.length} session${
      sessions.length === 1 ? "" : "s"
    } · newest first`;
    renderTable(sessions, filters, fetchAndRender);
  } catch (err) {
    meta.textContent = `Failed to load sessions: ${err}`;
  }
}

function init() {
  writeFormFromFilters(readInitialFilters());
  const form = document.getElementById("filter-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    fetchAndRender();
  });
  form.addEventListener("reset", () => {
    setTimeout(fetchAndRender, 0);
  });
  fetchAndRender();
}

init();
