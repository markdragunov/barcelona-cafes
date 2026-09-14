import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const $ = (sel) => document.querySelector(sel);

const loginGate = $("#login-gate");
const adminApp = $("#admin-app");
const loginForm = $("#login-form");
const loginEmail = $("#login-email");
const loginBtn = $("#login-btn");
const loginStatus = $("#login-status");
const adminUserEl = $("#admin-user");
const signOutBtn = $("#sign-out-btn");

const neighborhoodSelect = $("#neighborhood");
const apiKeyStatus = $("#api-key-status");
const parallelKeyStatus = $("#parallel-key-status");
const openaiKeyStatus = $("#openai-key-status");
const indexCafesBtn = $("#index-cafes-btn");
const indexStatus = $("#index-status");
const ragIndexMeta = $("#rag-index-meta");
const ragSearchForm = $("#rag-search-form");
const ragQuery = $("#rag-query");
const ragTopN = $("#rag-top-n");
const ragSearchBtn = $("#rag-search-btn");
const ragSearchStatus = $("#rag-search-status");
const ragAnswer = $("#rag-answer");
const ragAnswerText = $("#rag-answer-text");
const collectForm = $("#collect-form");
const collectBtn = $("#collect-btn");
const cancelBtn = $("#cancel-btn");
const collectStatus = $("#collect-status");
const collectLog = $("#collect-log");
const queryMeta = $("#query-meta");
const exportLink = $("#export-link");
const refreshSummaryBtn = $("#refresh-summary");
const coffeeFetchBtn = $("#coffee-fetch-btn");
const coffeeCancelBtn = $("#coffee-cancel-btn");
const coffeeStatus = $("#coffee-status");
const coffeeLog = $("#coffee-log");
const coffeeTotal = $("#coffee-total");
const coffeeCompleted = $("#coffee-completed");
const coffeeSkipped = $("#coffee-skipped");

let pollTimer = null;
let coffeePollTimer = null;
let indexPollTimer = null;
let supabase = null;
let accessToken = null;
let authMode = "open";

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(data.error || "Admin authentication required");
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function setStatus(el, message, kind = "") {
  if (!el) return;
  el.textContent = message || "";
  el.className = `status${kind ? ` ${kind}` : ""}`;
}

function selectedNeighborhood() {
  return neighborhoodSelect.value || "all-barcelona";
}

function updateExportLink() {
  const id = selectedNeighborhood();
  exportLink.dataset.neighborhood = id;
  exportLink.href = `#export-${encodeURIComponent(id)}`;
}

async function downloadExport(ev) {
  ev.preventDefault();
  const id = exportLink.dataset.neighborhood || selectedNeighborhood();
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(
    `/api/export.csv?neighborhood=${encodeURIComponent(id)}`,
    { headers, credentials: "same-origin" }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cafes-${id}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function showLogin() {
  loginGate.hidden = false;
  adminApp.hidden = true;
}

function showAdmin(email) {
  loginGate.hidden = true;
  adminApp.hidden = false;
  adminUserEl.textContent = email ? `Signed in as ${email}` : "";
  signOutBtn.hidden = authMode !== "magic_link";
}

async function loadNeighborhoods() {
  const data = await api("/api/neighborhoods");
  neighborhoodSelect.innerHTML = data.neighborhoods
    .map((n) => `<option value="${n.id}">${n.name}</option>`)
    .join("");
  neighborhoodSelect.value = "all-barcelona";
  queryMeta.textContent = `${data.queryCount} search queries × selected neighborhood viewport(s)`;
  updateExportLink();
}

async function loadApiKeyStatus() {
  const data = await api("/api/settings/api-key");
  if (data.configured) {
    setStatus(apiKeyStatus, ` — loaded from .env (${data.masked})`, "ok");
  } else {
    setStatus(apiKeyStatus, " — missing in .env", "warn");
  }
}

async function loadParallelKeyStatus() {
  const data = await api("/api/settings/parallel-api-key");
  if (data.configured) {
    setStatus(parallelKeyStatus, ` — loaded from .env (${data.masked})`, "ok");
  } else {
    setStatus(parallelKeyStatus, " — missing in .env", "warn");
  }
}

async function loadOpenaiKeyStatus() {
  const data = await api("/api/settings/openai-api-key");
  if (data.configured) {
    setStatus(openaiKeyStatus, ` — loaded from .env (${data.masked})`, "ok");
  } else {
    setStatus(openaiKeyStatus, " — missing in .env", "warn");
  }
}

async function loadRagStatus() {
  try {
    const data = await api("/api/rag/status");
    if (data.ready) {
      ragIndexMeta.textContent = `Index ready · ${data.document_count} cafes`;
    } else {
      ragIndexMeta.textContent = "Index not built yet";
    }
    if (data.indexing) {
      setStatus(indexStatus, "Indexing cafes…", "warn");
      indexCafesBtn.disabled = true;
    }
  } catch (err) {
    ragIndexMeta.textContent = "RAG unavailable";
    setStatus(indexStatus, err.message, "err");
  }
}

async function loadSummary() {
  const data = await api(
    `/api/summary?neighborhood=${encodeURIComponent(selectedNeighborhood())}`
  );
  for (const [key, value] of Object.entries(data)) {
    const el = document.querySelector(`#summary [data-key="${key}"]`);
    if (!el) continue;
    el.textContent =
      value === null || value === undefined
        ? "—"
        : typeof value === "number"
          ? Number.isInteger(value)
            ? String(value)
            : value.toFixed(2)
          : String(value);
  }
}

function renderLogs(el, logs) {
  if (!logs?.length) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = logs.join("\n");
  el.scrollTop = el.scrollHeight;
}

function setCollectingUi(running) {
  collectBtn.disabled = running;
  cancelBtn.disabled = !running;
}

function setCoffeeUi(running) {
  coffeeFetchBtn.disabled = running;
  coffeeCancelBtn.disabled = !running;
}

function updateCoffeeProgress(data) {
  coffeeTotal.textContent =
    data.total === undefined || data.total === null ? "—" : String(data.total);
  coffeeCompleted.textContent =
    data.completed === undefined || data.completed === null
      ? "—"
      : String(data.completed);
  coffeeSkipped.textContent =
    data.skipped === undefined || data.skipped === null
      ? "—"
      : String(data.skipped);
}

async function pollCollectStatus() {
  const status = await api("/api/collect/status");
  renderLogs(collectLog, status.logs);
  if (status.running) {
    setCollectingUi(true);
    setStatus(collectStatus, "Collection running…", "warn");
    return true;
  }
  setCollectingUi(false);
  if (status.error) {
    setStatus(collectStatus, status.error, "err");
  } else if (status.finishedAt) {
    setStatus(collectStatus, "Collection finished.", "ok");
    await loadSummary();
  }
  return false;
}

async function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const tick = async () => {
    try {
      const running = await pollCollectStatus();
      if (!running && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch (err) {
      setStatus(collectStatus, err.message, "err");
    }
  };
  await tick();
  pollTimer = setInterval(tick, 1500);
}

async function pollCoffeeStatus() {
  const status = await api("/api/coffee-content/status");
  updateCoffeeProgress(status);
  renderLogs(coffeeLog, status.logs);
  if (status.running) {
    setCoffeeUi(true);
    setStatus(coffeeStatus, "Fetching coffee content…", "warn");
    return true;
  }
  setCoffeeUi(false);
  if (status.error) {
    setStatus(coffeeStatus, status.error, "err");
  } else if (status.finishedAt) {
    setStatus(coffeeStatus, "Coffee content fetch finished.", "ok");
  }
  return false;
}

async function startCoffeePolling() {
  if (coffeePollTimer) clearInterval(coffeePollTimer);
  const tick = async () => {
    try {
      const running = await pollCoffeeStatus();
      if (!running && coffeePollTimer) {
        clearInterval(coffeePollTimer);
        coffeePollTimer = null;
      }
    } catch (err) {
      setStatus(coffeeStatus, err.message, "err");
    }
  };
  await tick();
  coffeePollTimer = setInterval(tick, 1500);
}

async function pollIndexStatus() {
  const status = await api("/api/rag/index/status");
  if (status.running) {
    indexCafesBtn.disabled = true;
    setStatus(indexStatus, "Indexing cafes…", "warn");
    return true;
  }
  indexCafesBtn.disabled = false;
  if (status.error) {
    setStatus(indexStatus, status.error, "err");
  } else if (status.result) {
    setStatus(
      indexStatus,
      `Indexed ${status.result.indexed ?? status.result.document_count ?? "?"} docs`,
      "ok"
    );
    await loadRagStatus();
  }
  return false;
}

async function startIndexPolling() {
  if (indexPollTimer) clearInterval(indexPollTimer);
  const tick = async () => {
    try {
      const running = await pollIndexStatus();
      if (!running && indexPollTimer) {
        clearInterval(indexPollTimer);
        indexPollTimer = null;
      }
    } catch (err) {
      setStatus(indexStatus, err.message, "err");
    }
  };
  await tick();
  indexPollTimer = setInterval(tick, 2000);
}

neighborhoodSelect?.addEventListener("change", () => {
  updateExportLink();
  loadSummary().catch((err) => setStatus(collectStatus, err.message, "err"));
});

indexCafesBtn?.addEventListener("click", async () => {
  try {
    indexCafesBtn.disabled = true;
    setStatus(indexStatus, "Starting index…", "warn");
    await api("/api/rag/index", { method: "POST", body: "{}" });
    await startIndexPolling();
  } catch (err) {
    indexCafesBtn.disabled = false;
    setStatus(indexStatus, err.message, "err");
  }
});

ragSearchForm?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    ragSearchBtn.disabled = true;
    setStatus(ragSearchStatus, "Searching…", "warn");
    ragAnswer.hidden = true;
    const data = await api("/api/rag/search", {
      method: "POST",
      body: JSON.stringify({
        query: ragQuery.value,
        topN: Number(ragTopN.value) || 5,
      }),
    });
    ragAnswerText.textContent = data.answer || "";
    ragAnswer.hidden = false;
    setStatus(ragSearchStatus, "Done.", "ok");
  } catch (err) {
    setStatus(ragSearchStatus, err.message, "err");
  } finally {
    ragSearchBtn.disabled = false;
  }
});

collectForm?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    setCollectingUi(true);
    setStatus(collectStatus, "Starting collection…", "warn");
    collectLog.hidden = false;
    collectLog.textContent = "";
    await api("/api/collect", {
      method: "POST",
      body: JSON.stringify({ neighborhoodId: selectedNeighborhood() }),
    });
    await startPolling();
  } catch (err) {
    setCollectingUi(false);
    setStatus(collectStatus, err.message, "err");
  }
});

cancelBtn?.addEventListener("click", async () => {
  try {
    await api("/api/collect/cancel", { method: "POST", body: "{}" });
    setStatus(collectStatus, "Cancelling…", "warn");
  } catch (err) {
    setStatus(collectStatus, err.message, "err");
  }
});

coffeeFetchBtn?.addEventListener("click", async () => {
  try {
    setCoffeeUi(true);
    setStatus(coffeeStatus, "Starting coffee content fetch…", "warn");
    coffeeLog.hidden = false;
    coffeeLog.textContent = "";
    const data = await api("/api/coffee-content/fetch", {
      method: "POST",
      body: JSON.stringify({ neighborhoodId: selectedNeighborhood() }),
    });
    updateCoffeeProgress({
      total: data.total,
      completed: 0,
      skipped: data.skipped,
    });
    await startCoffeePolling();
  } catch (err) {
    setCoffeeUi(false);
    setStatus(coffeeStatus, err.message, "err");
  }
});

coffeeCancelBtn?.addEventListener("click", async () => {
  try {
    await api("/api/coffee-content/cancel", { method: "POST", body: "{}" });
    setStatus(coffeeStatus, "Cancelling…", "warn");
  } catch (err) {
    setStatus(coffeeStatus, err.message, "err");
  }
});

refreshSummaryBtn?.addEventListener("click", () => {
  loadSummary().catch((err) => setStatus(collectStatus, err.message, "err"));
});

exportLink?.addEventListener("click", (ev) => {
  downloadExport(ev).catch((err) =>
    setStatus(collectStatus, err.message, "err")
  );
});

async function bootstrapAdminUi() {
  await loadNeighborhoods();
  await loadApiKeyStatus();
  await loadParallelKeyStatus();
  await loadOpenaiKeyStatus();
  await loadSummary();
  await loadRagStatus();

  const status = await api("/api/collect/status");
  if (status.running) {
    await startPolling();
  } else if (status.logs?.length) {
    renderLogs(collectLog, status.logs);
  }

  const coffee = await api("/api/coffee-content/status");
  if (coffee.running || coffee.finishedAt) {
    updateCoffeeProgress(coffee);
    renderLogs(coffeeLog, coffee.logs);
  }
  if (coffee.running) {
    await startCoffeePolling();
  }

  const index = await api("/api/rag/index/status");
  if (index.running) {
    await startIndexPolling();
  } else if (index.result || index.error) {
    await pollIndexStatus();
  }
}

async function applySession(session) {
  accessToken = session?.access_token || null;
  if (!accessToken) {
    showLogin();
    return false;
  }
  try {
    const me = await api("/api/auth/me");
    showAdmin(me.email);
    await bootstrapAdminUi();
    return true;
  } catch (err) {
    accessToken = null;
    if (supabase) await supabase.auth.signOut();
    showLogin();
    setStatus(loginStatus, err.message, "err");
    return false;
  }
}

loginForm?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!supabase) {
    setStatus(
      loginStatus,
      authMode === "basic"
        ? "This server uses HTTP Basic auth. Reload the page and sign in with your admin username and password."
        : "Magic-link sign-in is not configured on this server.",
      "err"
    );
    return;
  }
  const email = loginEmail.value.trim();
  if (!email) return;
  loginBtn.disabled = true;
  setStatus(loginStatus, "Sending magic link…", "warn");
  try {
    const redirectTo = `${window.location.origin}/admin`;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) throw error;
    setStatus(
      loginStatus,
      `Check ${email} for the magic link (then return here).`,
      "ok"
    );
  } catch (err) {
    setStatus(loginStatus, err.message || String(err), "err");
  } finally {
    loginBtn.disabled = false;
  }
});

signOutBtn?.addEventListener("click", async () => {
  accessToken = null;
  if (supabase) await supabase.auth.signOut();
  showLogin();
  setStatus(loginStatus, "Signed out.", "ok");
});

async function init() {
  const cfgRes = await fetch("/api/auth/config");
  const cfg = await cfgRes.json();
  authMode = cfg.authMode || "open";

  if (authMode === "magic_link") {
    supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.access_token) {
        accessToken = session.access_token;
      }
    });

    const { data } = await supabase.auth.getSession();
    if (data.session) {
      await applySession(data.session);
    } else {
      showLogin();
    }
    return;
  }

  // basic or open: no magic-link gate
  accessToken = null;
  showAdmin(authMode === "basic" ? "Basic auth (browser)" : null);
  await bootstrapAdminUi();
}

init().catch((err) => {
  showLogin();
  setStatus(loginStatus || collectStatus, err.message, "err");
});
