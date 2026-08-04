const $ = (sel) => document.querySelector(sel);

const neighborhoodSelect = $("#neighborhood");
const apiKeyForm = $("#api-key-form");
const apiKeyInput = $("#api-key-input");
const apiKeyStatus = $("#api-key-status");
const toggleKeyBtn = $("#toggle-key");
const collectForm = $("#collect-form");
const collectBtn = $("#collect-btn");
const cancelBtn = $("#cancel-btn");
const collectStatus = $("#collect-status");
const collectLog = $("#collect-log");
const queryMeta = $("#query-meta");
const exportLink = $("#export-link");
const refreshSummaryBtn = $("#refresh-summary");

let pollTimer = null;

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function setStatus(el, message, kind = "") {
  el.textContent = message || "";
  el.className = `status${kind ? ` ${kind}` : ""}`;
}

function selectedNeighborhood() {
  return neighborhoodSelect.value || "all-barcelona";
}

function updateExportLink() {
  const id = selectedNeighborhood();
  exportLink.href = `/api/export.csv?neighborhood=${encodeURIComponent(id)}`;
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
    setStatus(apiKeyStatus, `Saved key: ${data.masked}`, "ok");
    apiKeyInput.placeholder = "Enter a new key to replace…";
  } else {
    setStatus(apiKeyStatus, "No API key saved yet.", "warn");
  }
}

async function loadSummary() {
  const data = await api(
    `/api/summary?neighborhood=${encodeURIComponent(selectedNeighborhood())}`
  );
  for (const [key, value] of Object.entries(data)) {
    const el = document.querySelector(`[data-key="${key}"]`);
    if (!el) continue;
    if (value === null || value === undefined) {
      el.textContent = "—";
    } else {
      el.textContent = String(value);
    }
  }
}

function renderLogs(logs) {
  if (!logs?.length) {
    collectLog.hidden = true;
    collectLog.textContent = "";
    return;
  }
  collectLog.hidden = false;
  collectLog.textContent = logs
    .map((l) => {
      const msg =
        l.message ||
        [l.neighborhood, l.query, l.stage].filter(Boolean).join(" · ");
      return `${l.at?.slice(11, 19) || ""}  ${msg}`;
    })
    .join("\n");
  collectLog.scrollTop = collectLog.scrollHeight;
}

function setCollectingUi(running) {
  collectBtn.disabled = running;
  cancelBtn.disabled = !running;
  neighborhoodSelect.disabled = running;
}

async function pollCollectStatus() {
  const data = await api("/api/collect/status");
  renderLogs(data.logs);

  if (data.running) {
    setCollectingUi(true);
    const last = data.logs?.[data.logs.length - 1];
    setStatus(
      collectStatus,
      last?.message || "Collection running…",
      "warn"
    );
    return;
  }

  setCollectingUi(false);
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (data.error) {
    setStatus(collectStatus, data.error, "err");
  } else if (data.result) {
    setStatus(
      collectStatus,
      `Finished. Upserted ${data.result.saved} cafe rows from ${data.result.found} API hits.`,
      "ok"
    );
    await loadSummary();
  }
}

async function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  await pollCollectStatus();
  pollTimer = setInterval(() => {
    pollCollectStatus().catch((err) => {
      setStatus(collectStatus, err.message, "err");
    });
  }, 1500);
}

apiKeyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const apiKey = apiKeyInput.value.trim();
    const data = await api("/api/settings/api-key", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
    apiKeyInput.value = "";
    setStatus(apiKeyStatus, `Saved key: ${data.masked}`, "ok");
  } catch (err) {
    setStatus(apiKeyStatus, err.message, "err");
  }
});

toggleKeyBtn.addEventListener("click", () => {
  const showing = apiKeyInput.type === "text";
  apiKeyInput.type = showing ? "password" : "text";
  toggleKeyBtn.textContent = showing ? "Show" : "Hide";
});

neighborhoodSelect.addEventListener("change", () => {
  updateExportLink();
  loadSummary().catch((err) => setStatus(collectStatus, err.message, "err"));
});

collectForm.addEventListener("submit", async (e) => {
  e.preventDefault();
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

cancelBtn.addEventListener("click", async () => {
  try {
    await api("/api/collect/cancel", { method: "POST", body: "{}" });
    setStatus(collectStatus, "Cancelling…", "warn");
  } catch (err) {
    setStatus(collectStatus, err.message, "err");
  }
});

refreshSummaryBtn.addEventListener("click", () => {
  loadSummary().catch((err) => setStatus(collectStatus, err.message, "err"));
});

async function init() {
  await loadNeighborhoods();
  await loadApiKeyStatus();
  await loadSummary();
  const status = await api("/api/collect/status");
  if (status.running) {
    await startPolling();
  } else if (status.logs?.length) {
    renderLogs(status.logs);
  }
}

init().catch((err) => {
  setStatus(collectStatus, err.message, "err");
});
