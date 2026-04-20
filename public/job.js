const jobId = window.__JOB_ID__;
const pollMs = Number(window.__POLL_MS__) || 2000;

let sideBySide = false;

const statusEl = document.getElementById("status");
const updatedAtEl = document.getElementById("updated-at");
const errorEl = document.getElementById("error");
const diffWrapEl = document.getElementById("diff-wrap");
const toggleBtn = document.getElementById("toggle-btn");
const refreshBtn = document.getElementById("refresh-btn");

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

function renderDiff(payload) {
  const diff = payload.diff || {};
  if (!sideBySide) {
    diffWrapEl.className = "diff-inline";
    diffWrapEl.innerHTML = `<div class="diff">${diff.inlineHtml || ""}</div>`;
    return;
  }

  diffWrapEl.className = "diff-sxs";
  const left = (diff.sideBySide && diff.sideBySide.left) || "";
  const right = (diff.sideBySide && diff.sideBySide.right) || "";
  diffWrapEl.innerHTML = `
    <div class="col">
      <h3>Primary</h3>
      <div class="diff">${left}</div>
    </div>
    <div class="col">
      <h3>Secondary</h3>
      <div class="diff">${right}</div>
    </div>`;
}

function updateMeta(payload) {
  setStatus(payload.status);
  updatedAtEl.textContent = `Last update: ${payload.updatedAt || "--"}`;
  errorEl.textContent = payload.error ? `Error: ${escapeHtml(payload.error)}` : "";
}

async function loadDiff() {
  const response = await fetch(`/api/job/${encodeURIComponent(jobId)}/diff`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to load diff: ${response.status}`);
  }

  const payload = await response.json();
  document.getElementById("job-title").textContent = payload.name || jobId;
  updateMeta(payload);
  renderDiff(payload);
}

async function forceRefresh() {
  refreshBtn.disabled = true;
  const previousText = refreshBtn.textContent;
  refreshBtn.textContent = "Refreshing...";

  try {
    const response = await fetch(`/api/job/${encodeURIComponent(jobId)}/refresh`, {
      method: "POST",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh: ${response.status}`);
    }

    await loadDiff();
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = previousText;
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
      loadDiff().catch((error) => {
        errorEl.textContent = `Error: ${escapeHtml(error.message)}`;
      });
    } catch (error) {
      errorEl.textContent = `Error: ${escapeHtml(error.message)}`;
    }
  };

  stream.onerror = () => {
    stream.close();
    window.setInterval(() => {
      loadDiff().catch(() => {
        // Polling will keep trying.
      });
    }, pollMs);
  };

  return true;
}

toggleBtn.addEventListener("click", () => {
  sideBySide = !sideBySide;
  loadDiff().catch((error) => {
    errorEl.textContent = `Error: ${escapeHtml(error.message)}`;
  });
});

refreshBtn.addEventListener("click", () => {
  forceRefresh().catch((error) => {
    errorEl.textContent = `Error: ${escapeHtml(error.message)}`;
  });
});

loadDiff().catch((error) => {
  errorEl.textContent = `Error: ${escapeHtml(error.message)}`;
});

if (!setupSse()) {
  window.setInterval(() => {
    loadDiff().catch(() => {
      // Polling fallback intentionally ignores intermittent errors.
    });
  }, pollMs);
}
