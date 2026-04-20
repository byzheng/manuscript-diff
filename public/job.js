const jobId = window.__JOB_ID__;
const pollMs = Number(window.__POLL_MS__) || 2000;

const statusEl = document.getElementById("status");
const updatedAtEl = document.getElementById("updated-at");
const startBadgeEl = document.getElementById("start-badge");
const secondaryCountBadgeEl = document.getElementById("secondary-count-badge");
const rangeBadgeEl = document.getElementById("range-badge");
const errorEl = document.getElementById("error");

const refreshBtn = document.getElementById("refresh-btn");
const applySecondaryBtn = document.getElementById("apply-secondary-btn");
const windowExtraInputEl = document.getElementById("window-extra-input");
const applyWindowExtraBtn = document.getElementById("apply-window-extra-btn");

const paragraphListEl = document.getElementById("primary-paragraphs");
const paragraphSearchInputEl = document.getElementById("paragraph-search-input");
const paragraphSearchBtn = document.getElementById("paragraph-search-btn");
const secondaryInputEl = document.getElementById("secondary-input");
const secondarySyncStatusEl = document.getElementById("secondary-sync-status");
const diffWrapEl = document.getElementById("diff-wrap");

const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
const tabPanels = {
  primary: document.getElementById("panel-primary"),
  secondary: document.getElementById("panel-secondary"),
  compare: document.getElementById("panel-compare"),
};

let editorState = null;
let activeTab = "primary";
let lastSearchTerm = "";
let lastSearchIndex = -1;
let secondaryAutoTimer = null;
const editorStorageKey = `manuscript-diff:${jobId}:editor`;

function loadPersistedEditorState() {
  try {
    const raw = window.localStorage.getItem(editorStorageKey);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return parsed;
  } catch (_error) {
    return {};
  }
}

function patchPersistedEditorState(patch) {
  try {
    const current = loadPersistedEditorState();
    const next = { ...current, ...patch };
    window.localStorage.setItem(editorStorageKey, JSON.stringify(next));
  } catch (_error) {
    // Ignore local storage write failures.
  }
}

async function restorePersistedEditorState() {
  const saved = loadPersistedEditorState();

  if (Number.isInteger(saved.startParagraph) && (!editorState || saved.startParagraph !== editorState.startParagraph)) {
    try {
      await setStartParagraph(saved.startParagraph, { openCompareTab: false });
    } catch (_error) {
      // Ignore invalid stale paragraph index.
    }
  }

  if (typeof saved.secondaryText === "string") {
    secondaryInputEl.value = saved.secondaryText;
    if (!editorState || saved.secondaryText !== (editorState.secondaryText || "")) {
      setSecondarySyncStatus("Restored draft. Auto-updating...", "busy");
      await applySecondaryText({ openCompareTab: false, silent: true });
    } else {
      setSecondarySyncStatus("Synced", "ok");
    }
  }
}

function setSecondarySyncStatus(text, type) {
  secondarySyncStatusEl.textContent = text;
  secondarySyncStatusEl.className = `sync-status ${type || ""}`.trim();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(status) {
  statusEl.textContent = (status || "unknown").toUpperCase();
  statusEl.className = `status status-${status || "unknown"}`;
}

function setError(message) {
  errorEl.textContent = message ? `Error: ${escapeHtml(message)}` : "";
}

function centerSelectedParagraphInViewport() {
  if (!editorState || !Number.isInteger(editorState.startParagraph)) {
    return;
  }

  const selected = paragraphListEl.querySelector(`.paragraph-item[data-index=\"${editorState.startParagraph}\"]`);
  if (!selected) {
    return;
  }

  const header = document.querySelector(".top-menu");
  const headerHeight = header ? header.getBoundingClientRect().height : 0;

  const rect = selected.getBoundingClientRect();
  const currentTop = window.scrollY || window.pageYOffset;
  const targetTop = currentTop + rect.top - (window.innerHeight / 2) + (rect.height / 2) - (headerHeight / 2);

  window.scrollTo({
    top: Math.max(0, targetTop),
    behavior: "smooth",
  });
}

function setActiveTab(nextTab) {
  activeTab = nextTab;
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === nextTab);
  });

  Object.entries(tabPanels).forEach(([name, panel]) => {
    panel.classList.toggle("active", name === nextTab);
  });

  if (nextTab === "primary") {
    // Delay one tick so the tab panel is fully visible before measuring positions.
    window.setTimeout(() => {
      centerSelectedParagraphInViewport();
    }, 0);
  }
}

function renderParagraphs(state) {
  const rows = state.paragraphs || [];
  paragraphListEl.innerHTML = rows
    .map((paragraph) => {
      const activeClass = paragraph.index === state.startParagraph ? " active" : "";
      return `<button type="button" class="paragraph-item${activeClass}" data-index="${paragraph.index}">
        <span class="paragraph-index">${paragraph.index + 1}</span>
        <span class="paragraph-text">${escapeHtml(paragraph.text)}</span>
      </button>`;
    })
    .join("");

  paragraphListEl.querySelectorAll(".paragraph-item").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      setStartParagraph(index, { openCompareTab: false }).catch((error) => setError(error.message));
    });

    button.addEventListener("dblclick", () => {
      const index = Number(button.dataset.index);
      setStartParagraph(index, { openCompareTab: true }).catch((error) => setError(error.message));
    });
  });
}

function renderDiff(state) {
  const diff = (state && state.diff) || {};
  diffWrapEl.innerHTML = `<div class="diff">${diff.inlineHtml || ""}</div>`;
}

function renderState(state) {
  editorState = state;
  document.getElementById("job-title").textContent = state.name || jobId;
  setStatus(state.status);
  updatedAtEl.textContent = `Last update: ${state.updatedAt || "--"}`;
  startBadgeEl.textContent = `Start paragraph: ${Number.isInteger(state.startParagraph) ? state.startParagraph + 1 : "--"}`;
  secondaryCountBadgeEl.textContent = `Secondary paragraphs: ${Number.isInteger(state.secondaryParagraphCount) ? state.secondaryParagraphCount : 0}`;
  const range = state.compareRange || { start: 0, end: -1, count: 0 };
  rangeBadgeEl.textContent =
    range.count > 0 ? `Range: ${range.start + 1}-${range.end + 1} (${range.count})` : "Range: empty";
  setError(state.error || "");

  if (document.activeElement !== windowExtraInputEl) {
    windowExtraInputEl.value = String(Number.isInteger(state.windowExtra) ? state.windowExtra : 0);
  }

  if (document.activeElement !== secondaryInputEl) {
    secondaryInputEl.value = state.secondaryText || "";
    setSecondarySyncStatus("Synced", "ok");
  }

  renderParagraphs(state);
  renderDiff(state);
}

async function fetchEditorState() {
  const response = await fetch(`/api/job/${encodeURIComponent(jobId)}/editor-state`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load editor state: ${response.status}`);
  }

  const state = await response.json();
  renderState(state);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    cache: "no-store",
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}

async function forceRefresh() {
  refreshBtn.disabled = true;
  const original = refreshBtn.textContent;
  refreshBtn.textContent = "Refreshing...";

  try {
    await postJson(`/api/job/${encodeURIComponent(jobId)}/refresh`, {});
    await fetchEditorState();
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = original;
  }
}

async function setStartParagraph(index, options = {}) {
  const { openCompareTab = true } = options;
  const data = await postJson(`/api/job/${encodeURIComponent(jobId)}/start`, {
    startParagraph: index,
  });

  renderState(data.state);
  patchPersistedEditorState({ startParagraph: data.state.startParagraph });
  if (openCompareTab) {
    setActiveTab("compare");
  }
}

function findNextParagraphByKeyword() {
  if (!editorState || !Array.isArray(editorState.paragraphs) || editorState.paragraphs.length === 0) {
    return;
  }

  const term = (paragraphSearchInputEl.value || "").trim().toLowerCase();
  if (!term) {
    setError("Enter a keyword to search.");
    return;
  }

  const paragraphs = editorState.paragraphs;
  if (term !== lastSearchTerm) {
    lastSearchTerm = term;
    lastSearchIndex = editorState.startParagraph;
  }

  const total = paragraphs.length;
  for (let step = 1; step <= total; step += 1) {
    const idx = (lastSearchIndex + step) % total;
    const text = String(paragraphs[idx].text || "").toLowerCase();
    if (text.includes(term)) {
      lastSearchIndex = idx;

      const btn = paragraphListEl.querySelector(`.paragraph-item[data-index=\"${idx}\"]`);
      if (btn) {
        btn.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      setStartParagraph(idx, { openCompareTab: false }).catch((error) => setError(error.message));
      setError("");
      return;
    }
  }

  setError(`No paragraph found for keyword: ${term}`);
}

async function applySecondaryText(options = {}) {
  const { openCompareTab = true, silent = false } = options;

  if (editorState && secondaryInputEl.value === (editorState.secondaryText || "")) {
    setSecondarySyncStatus("Synced", "ok");
    return;
  }

  if (!silent) {
    applySecondaryBtn.disabled = true;
    setSecondarySyncStatus("Applying...", "busy");
  }
  const original = applySecondaryBtn.textContent;
  if (!silent) {
    applySecondaryBtn.textContent = "Applying...";
  }

  try {
    const data = await postJson(`/api/job/${encodeURIComponent(jobId)}/secondary`, {
      secondaryText: secondaryInputEl.value,
    });
    renderState(data.state);
    patchPersistedEditorState({ secondaryText: data.state.secondaryText || "" });
    setSecondarySyncStatus("Synced", "ok");
    if (openCompareTab) {
      setActiveTab("compare");
    }
  } catch (error) {
    setSecondarySyncStatus("Sync failed", "error");
    throw error;
  } finally {
    if (!silent) {
      applySecondaryBtn.disabled = false;
      applySecondaryBtn.textContent = original;
    }
  }
}

function scheduleSecondaryAutoApply() {
  if (secondaryAutoTimer) {
    window.clearTimeout(secondaryAutoTimer);
  }

  secondaryAutoTimer = window.setTimeout(() => {
    setSecondarySyncStatus("Auto-updating...", "busy");
    applySecondaryText({ openCompareTab: false, silent: true }).catch((error) => setError(error.message));
  }, 500);
}

async function applyWindowExtra() {
  applyWindowExtraBtn.disabled = true;
  const original = applyWindowExtraBtn.textContent;
  applyWindowExtraBtn.textContent = "Applying...";

  try {
    const data = await postJson(`/api/job/${encodeURIComponent(jobId)}/window-extra`, {
      windowExtra: Number(windowExtraInputEl.value || 0),
    });
    renderState(data.state);
    setActiveTab("compare");
  } finally {
    applyWindowExtraBtn.disabled = false;
    applyWindowExtraBtn.textContent = original;
  }
}

function setupSse() {
  if (!window.EventSource) {
    return false;
  }

  const stream = new EventSource("/events");
  stream.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.jobId && data.jobId !== jobId) {
        return;
      }

      fetchEditorState().catch((error) => setError(error.message));
    } catch (error) {
      setError(error.message);
    }
  };

  stream.onerror = () => {
    stream.close();
    window.setInterval(() => {
      fetchEditorState().catch(() => {
        // Ignore intermittent polling errors.
      });
    }, pollMs);
  };

  return true;
}

refreshBtn.addEventListener("click", () => {
  forceRefresh().catch((error) => setError(error.message));
});

applySecondaryBtn.addEventListener("click", () => {
  applySecondaryText().catch((error) => setError(error.message));
});

secondaryInputEl.addEventListener("input", () => {
  patchPersistedEditorState({ secondaryText: secondaryInputEl.value });
  setSecondarySyncStatus("Pending changes...", "pending");
  scheduleSecondaryAutoApply();
});

applyWindowExtraBtn.addEventListener("click", () => {
  applyWindowExtra().catch((error) => setError(error.message));
});

windowExtraInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyWindowExtra().catch((error) => setError(error.message));
  }
});

paragraphSearchBtn.addEventListener("click", () => {
  findNextParagraphByKeyword();
});

paragraphSearchInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    findNextParagraphByKeyword();
  }
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tab);
  });
});

async function initPage() {
  setActiveTab("primary");
  await fetchEditorState();
  await restorePersistedEditorState();
  window.setTimeout(() => {
    centerSelectedParagraphInViewport();
  }, 0);

  if (!setupSse()) {
    window.setInterval(() => {
      fetchEditorState().catch(() => {
        // Ignore intermittent polling errors.
      });
    }, pollMs);
  }
}

initPage().catch((error) => setError(error.message));
