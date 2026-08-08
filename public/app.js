const $ = (sel) => document.querySelector(sel);

const neighborhoodSelect = $("#neighborhood");
const apiKeyForm = $("#api-key-form");
const apiKeyInput = $("#api-key-input");
const apiKeyStatus = $("#api-key-status");
const toggleKeyBtn = $("#toggle-key");
const parallelKeyForm = $("#parallel-key-form");
const parallelKeyInput = $("#parallel-key-input");
const parallelKeyStatus = $("#parallel-key-status");
const toggleParallelKeyBtn = $("#toggle-parallel-key");
const openaiKeyForm = $("#openai-key-form");
const openaiKeyInput = $("#openai-key-input");
const openaiKeyStatus = $("#openai-key-status");
const toggleOpenaiKeyBtn = $("#toggle-openai-key");
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
    setStatus(apiKeyStatus, "No Google API key saved yet.", "warn");
  }
}

async function loadParallelKeyStatus() {
  const data = await api("/api/settings/parallel-api-key");
  if (data.configured) {
    setStatus(parallelKeyStatus, `Saved key: ${data.masked}`, "ok");
    parallelKeyInput.placeholder = "Enter a new key to replace…";
  } else {
    setStatus(parallelKeyStatus, "No Parallel API key saved yet.", "warn");
  }
}

async function loadOpenaiKeyStatus() {
  const data = await api("/api/settings/openai-api-key");
  if (data.configured) {
    setStatus(openaiKeyStatus, `Saved key: ${data.masked}`, "ok");
    openaiKeyInput.placeholder = "Enter a new key to replace…";
  } else {
    setStatus(openaiKeyStatus, "No OpenAI API key saved yet.", "warn");
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
    const el = document.querySelector(`[data-key="${key}"]`);
    if (!el) continue;
    if (value === null || value === undefined) {
      el.textContent = "—";
    } else {
      el.textContent = String(value);
    }
  }
}

function renderLogs(el, logs) {
  if (!logs?.length) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = logs
    .map((l) => {
      const msg =
        l.message ||
        [l.neighborhood, l.query, l.stage].filter(Boolean).join(" · ");
      return `${l.at?.slice(11, 19) || ""}  ${msg}`;
    })
    .join("\n");
  el.scrollTop = el.scrollHeight;
}

let collectRunning = false;
let coffeeRunning = false;

function setCollectingUi(running) {
  collectRunning = running;
  collectBtn.disabled = running || coffeeRunning;
  cancelBtn.disabled = !running;
  coffeeFetchBtn.disabled = coffeeRunning || running;
  syncNeighborhoodLock();
}

function setCoffeeUi(running) {
  coffeeRunning = running;
  coffeeFetchBtn.disabled = running || collectRunning;
  coffeeCancelBtn.disabled = !running;
  collectBtn.disabled = collectRunning || running;
  syncNeighborhoodLock();
}

function syncNeighborhoodLock() {
  neighborhoodSelect.disabled = collectRunning || coffeeRunning;
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
  const data = await api("/api/collect/status");
  renderLogs(collectLog, data.logs);

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

async function pollCoffeeStatus() {
  const data = await api("/api/coffee-content/status");
  updateCoffeeProgress(data);
  renderLogs(coffeeLog, data.logs);

  if (data.running) {
    setCoffeeUi(true);
    const label = data.current?.name
      ? `Extracting ${data.current.name} (${data.completed}/${data.total})…`
      : `Processing ${data.completed}/${data.total}…`;
    setStatus(coffeeStatus, label, "warn");
    return;
  }

  setCoffeeUi(false);
  if (coffeePollTimer) {
    clearInterval(coffeePollTimer);
    coffeePollTimer = null;
  }

  if (data.error) {
    setStatus(coffeeStatus, data.error, "err");
  } else if (data.finishedAt) {
    setStatus(
      coffeeStatus,
      `Finished. Completed ${data.completed}/${data.total}; skipped ${data.skipped}${
        data.failed ? `; failed ${data.failed}` : ""
      }.`,
      data.failed ? "warn" : "ok"
    );
    await loadSummary();
  }
}

async function startCoffeePolling() {
  if (coffeePollTimer) clearInterval(coffeePollTimer);
  await pollCoffeeStatus();
  coffeePollTimer = setInterval(() => {
    pollCoffeeStatus().catch((err) => {
      setStatus(coffeeStatus, err.message, "err");
    });
  }, 1200);
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

parallelKeyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const apiKey = parallelKeyInput.value.trim();
    const data = await api("/api/settings/parallel-api-key", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
    parallelKeyInput.value = "";
    setStatus(parallelKeyStatus, `Saved key: ${data.masked}`, "ok");
  } catch (err) {
    setStatus(parallelKeyStatus, err.message, "err");
  }
});

toggleParallelKeyBtn.addEventListener("click", () => {
  const showing = parallelKeyInput.type === "text";
  parallelKeyInput.type = showing ? "password" : "text";
  toggleParallelKeyBtn.textContent = showing ? "Show" : "Hide";
});

openaiKeyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const apiKey = openaiKeyInput.value.trim();
    const data = await api("/api/settings/openai-api-key", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
    openaiKeyInput.value = "";
    setStatus(openaiKeyStatus, `Saved key: ${data.masked}`, "ok");
  } catch (err) {
    setStatus(openaiKeyStatus, err.message, "err");
  }
});

toggleOpenaiKeyBtn.addEventListener("click", () => {
  const showing = openaiKeyInput.type === "text";
  openaiKeyInput.type = showing ? "password" : "text";
  toggleOpenaiKeyBtn.textContent = showing ? "Show" : "Hide";
});

async function pollIndexStatus() {
  const data = await api("/api/rag/index/status");
  if (data.running) {
    indexCafesBtn.disabled = true;
    ragSearchBtn.disabled = true;
    setStatus(indexStatus, "Rebuilding ChromaDB + BM25 indexes…", "warn");
    return;
  }

  indexCafesBtn.disabled = false;
  ragSearchBtn.disabled = false;
  if (indexPollTimer) {
    clearInterval(indexPollTimer);
    indexPollTimer = null;
  }

  if (data.error) {
    setStatus(indexStatus, data.error, "err");
  } else if (data.result) {
    setStatus(
      indexStatus,
      `Indexed ${data.result.indexed} cafes into ChromaDB + BM25.`,
      "ok"
    );
  }
  await loadRagStatus();
}

async function startIndexPolling() {
  if (indexPollTimer) clearInterval(indexPollTimer);
  await pollIndexStatus();
  indexPollTimer = setInterval(() => {
    pollIndexStatus().catch((err) => {
      setStatus(indexStatus, err.message, "err");
    });
  }, 1500);
}

indexCafesBtn.addEventListener("click", async () => {
  try {
    indexCafesBtn.disabled = true;
    ragSearchBtn.disabled = true;
    setStatus(indexStatus, "Starting index rebuild…", "warn");
    await api("/api/rag/index", { method: "POST", body: "{}" });
    await startIndexPolling();
  } catch (err) {
    indexCafesBtn.disabled = false;
    ragSearchBtn.disabled = false;
    setStatus(indexStatus, err.message, "err");
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render answer: safe HTML + clickable markdown [map](url) / [site](url). */
function formatRagAnswer(text) {
  const escaped = escapeHtml(text);
  const withLinks = escaped.replace(
    /\[(map|site)\]\((https?:\/\/[^)\s]+)\)/gi,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  return withLinks.replace(/\n/g, "<br>");
}

ragSearchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = ragQuery.value.trim();
  let topN = Number(ragTopN.value || 5);
  if (!Number.isFinite(topN)) topN = 5;
  topN = Math.max(1, Math.min(20, Math.round(topN)));
  ragTopN.value = String(topN);

  try {
    ragSearchBtn.disabled = true;
    indexCafesBtn.disabled = true;
    ragAnswer.hidden = true;
    setStatus(
      ragSearchStatus,
      "Detecting location, then searching (vector + BM25)…",
      "warn"
    );
    const data = await api("/api/rag/search", {
      method: "POST",
      body: JSON.stringify({ query, topN }),
    });
    ragAnswerText.innerHTML = formatRagAnswer(data.answer || "");
    ragAnswer.hidden = false;
    const loc = data.location;
    const locBit =
      loc?.applied && loc.location
        ? ` · near ${loc.location} (1 km, ${loc.cafe_count ?? 0} cafes)`
        : " · citywide";
    setStatus(
      ragSearchStatus,
      `Done. Used ${data.results?.length ?? 0} cafes (vector ${data.vector_count}, BM25 ${data.bm25_count})${locBit}.`,
      "ok"
    );
  } catch (err) {
    setStatus(ragSearchStatus, err.message, "err");
  } finally {
    ragSearchBtn.disabled = false;
    indexCafesBtn.disabled = false;
  }
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

coffeeFetchBtn.addEventListener("click", async () => {
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

coffeeCancelBtn.addEventListener("click", async () => {
  try {
    await api("/api/coffee-content/cancel", { method: "POST", body: "{}" });
    setStatus(coffeeStatus, "Cancelling…", "warn");
  } catch (err) {
    setStatus(coffeeStatus, err.message, "err");
  }
});

refreshSummaryBtn.addEventListener("click", () => {
  loadSummary().catch((err) => setStatus(collectStatus, err.message, "err"));
});

async function init() {
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

init().catch((err) => {
  setStatus(collectStatus, err.message, "err");
});
