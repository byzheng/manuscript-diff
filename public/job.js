const jobId = window.__JOB_ID__;
const pollMs = Number(window.__POLL_MS__) || 2000;

const statusEl = document.getElementById("status");
const updatedAtEl = document.getElementById("updated-at");
const startBadgeEl = document.getElementById("start-badge");
const secondaryCountBadgeEl = document.getElementById("secondary-count-badge");
const rangeBadgeEl = document.getElementById("range-badge");
const primaryDocxPathEl = document.getElementById("primary-docx-path");
const errorEl = document.getElementById("error");

const refreshBtn = document.getElementById("refresh-btn");
const applySecondaryBtn = document.getElementById("apply-secondary-btn");
const windowExtraInputEl = document.getElementById("window-extra-input");
const applyWindowExtraBtn = document.getElementById("apply-window-extra-btn");

const primaryPreviewEl = document.getElementById("primary-preview");
const primarySearchInputEl = document.getElementById("primary-search-input");
const primarySearchPrevBtn = document.getElementById("primary-search-prev-btn");
const primarySearchNextBtn = document.getElementById("primary-search-next-btn");
const primarySearchCountEl = document.getElementById("primary-search-count");
const secondaryInputEl = document.getElementById("secondary-input");
const secondarySyncStatusEl = document.getElementById("secondary-sync-status");
const compareDirectionButtonEls = Array.from(document.querySelectorAll(".compare-direction-btn"));
const diffModeButtonEls = Array.from(document.querySelectorAll(".diff-mode-btn"));
const diffWrapEl = document.getElementById("diff-wrap");
const panelCompareEl = document.getElementById("panel-compare");
const compareWidthInputEl = document.getElementById("compare-width-input");
const compareWidthValueEl = document.getElementById("compare-width-value");

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
let primarySearchMatches = [];
let primarySearchActiveIndex = -1;
let primarySearchDebounceTimer = null;
let secondaryAutoTimer = null;
let activePreviewAnchorEl = null;
let suppressSseUntilMs = 0;
let lastRenderedPrimaryPreviewHtml = null;
let primaryScrollPersistTimer = null;
const editorStorageKey = `manuscript-diff:${jobId}:editor`;
const secondaryMinHeightPx = 280;
const compareBoxWidthDefaultPct = 100;
const compareBoxWidthMinPct = 55;
const compareBoxWidthMaxPct = 100;

function normalizeCompareBoxWidth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return compareBoxWidthDefaultPct;
  }

  const rounded = Math.round(numeric);
  return Math.min(compareBoxWidthMaxPct, Math.max(compareBoxWidthMinPct, rounded));
}

function applyCompareBoxWidth(widthPct, options = {}) {
  const { persist = true } = options;
  const normalizedWidthPct = normalizeCompareBoxWidth(widthPct);
  const isNarrowViewport = window.innerWidth < 900;
  const effectiveWidthPct = isNarrowViewport ? 100 : normalizedWidthPct;

  if (panelCompareEl) {
    panelCompareEl.style.setProperty("--compare-box-width", `${effectiveWidthPct}%`);
  }

  if (compareWidthInputEl && document.activeElement !== compareWidthInputEl) {
    compareWidthInputEl.value = String(normalizedWidthPct);
  }

  if (compareWidthValueEl) {
    compareWidthValueEl.textContent = `${normalizedWidthPct}%`;
  }

  if (persist) {
    patchPersistedEditorState({ compareBoxWidth: normalizedWidthPct });
  }
}

function resizeSecondaryInputToViewport() {
  if (activeTab !== "secondary") {
    return;
  }

  const panel = tabPanels.secondary;
  if (!panel || !panel.classList.contains("active")) {
    return;
  }

  const controls = panel.querySelector(".inline-controls");
  const syncHeight = secondarySyncStatusEl ? secondarySyncStatusEl.getBoundingClientRect().height : 0;
  const controlsHeight = controls ? controls.getBoundingClientRect().height : 0;
  const reserveBelowInput = syncHeight + controlsHeight + 28;

  const inputTop = secondaryInputEl.getBoundingClientRect().top;
  const availableHeight = Math.floor(window.innerHeight - inputTop - reserveBelowInput);
  const targetHeight = Math.max(secondaryMinHeightPx, availableHeight);

  secondaryInputEl.style.height = `${targetHeight}px`;
}

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

function persistPrimaryViewportPosition() {
  const primaryPanel = tabPanels.primary;
  patchPersistedEditorState({
    primaryPreviewScrollTop: primaryPreviewEl ? primaryPreviewEl.scrollTop : 0,
    primaryPanelScrollTop: primaryPanel ? primaryPanel.scrollTop : 0,
    primaryWindowScrollY: window.scrollY || window.pageYOffset || 0,
  });
}

function schedulePersistPrimaryViewportPosition() {
  if (primaryScrollPersistTimer) {
    window.clearTimeout(primaryScrollPersistTimer);
  }

  primaryScrollPersistTimer = window.setTimeout(() => {
    primaryScrollPersistTimer = null;
    persistPrimaryViewportPosition();
  }, 120);
}

function restorePrimaryViewportPosition(saved) {
  const primaryPanel = tabPanels.primary;

  if (primaryPreviewEl && Number.isFinite(Number(saved.primaryPreviewScrollTop))) {
    primaryPreviewEl.scrollTop = Number(saved.primaryPreviewScrollTop);
  }

  if (primaryPanel && Number.isFinite(Number(saved.primaryPanelScrollTop))) {
    primaryPanel.scrollTop = Number(saved.primaryPanelScrollTop);
  }

  if (Number.isFinite(Number(saved.primaryWindowScrollY))) {
    const panelStyle = primaryPanel ? window.getComputedStyle(primaryPanel) : null;
    const panelScrolls = panelStyle && (panelStyle.overflowY === "auto" || panelStyle.overflowY === "scroll");
    if (!panelScrolls && activeTab === "primary") {
      window.scrollTo({ top: Number(saved.primaryWindowScrollY), behavior: "auto" });
    }
  }
}

async function restorePersistedEditorState() {
  const saved = loadPersistedEditorState();
  let restoredViewport = false;

  applyCompareBoxWidth(saved.compareBoxWidth, { persist: false });

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

  if (typeof saved.diffMode === "string" && (!editorState || saved.diffMode !== editorState.diffMode)) {
    try {
      await setDiffMode(saved.diffMode, { openCompareTab: false });
    } catch (_error) {
      // Ignore stale values from older versions.
    }
  }

  if (typeof saved.compareDirection === "string" && (!editorState || saved.compareDirection !== editorState.compareDirection)) {
    try {
      await setCompareDirection(saved.compareDirection, { openCompareTab: false });
    } catch (_error) {
      // Ignore stale values from older versions.
    }
  }

  if (
    saved &&
    (saved.primaryPreviewScrollTop !== undefined ||
      saved.primaryPanelScrollTop !== undefined ||
      saved.primaryWindowScrollY !== undefined)
  ) {
    window.setTimeout(() => {
      restorePrimaryViewportPosition(saved);
    }, 0);
    restoredViewport = true;
  }

  return {
    restoredViewport,
  };
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

function suppressImmediateSseRerender(durationMs = 1000) {
  suppressSseUntilMs = Date.now() + Math.max(0, Number(durationMs) || 0);
}

function isSseSuppressed() {
  return Date.now() < suppressSseUntilMs;
}

function capturePrimaryViewport() {
  const primaryPanel = tabPanels.primary;
  if (!primaryPanel) {
    return null;
  }

  const snapshot = {
    panelScrollTop: primaryPanel.scrollTop,
    windowScrollTop: window.scrollY || window.pageYOffset || 0,
    previewScrollTop: primaryPreviewEl ? primaryPreviewEl.scrollTop : 0,
    anchorParagraphIndex: null,
    anchorViewportOffset: null,
  };

  // Anchor to the selected paragraph's on-screen position, since raw scrollTop
  // drifts once reloaded content reflows to a different height.
  if (activePreviewAnchorEl && primaryPreviewEl && primaryPreviewEl.contains(activePreviewAnchorEl)) {
    const paragraphIndex = Number(activePreviewAnchorEl.dataset.paragraphIndex);
    if (Number.isInteger(paragraphIndex)) {
      snapshot.anchorParagraphIndex = paragraphIndex;
      snapshot.anchorViewportOffset = activePreviewAnchorEl.getBoundingClientRect().top;
    }
  }

  return snapshot;
}

function restorePrimaryViewport(snapshot) {
  if (!snapshot) {
    return;
  }

  const primaryPanel = tabPanels.primary;

  if (Number.isInteger(snapshot.anchorParagraphIndex) && primaryPreviewEl) {
    const selector = `.preview-anchor[data-paragraph-index="${snapshot.anchorParagraphIndex}"]`;
    const anchor = primaryPreviewEl.querySelector(selector);
    if (anchor) {
      const delta = anchor.getBoundingClientRect().top - snapshot.anchorViewportOffset;
      if (delta !== 0) {
        if (primaryPreviewEl) {
          primaryPreviewEl.scrollTop += delta;
        }
        if (primaryPanel) {
          primaryPanel.scrollTop += delta;
        }

        const panelStyle = primaryPanel ? window.getComputedStyle(primaryPanel) : null;
        const panelScrolls = panelStyle && (panelStyle.overflowY === "auto" || panelStyle.overflowY === "scroll");
        if (!panelScrolls && activeTab === "primary") {
          window.scrollBy({ top: delta, behavior: "auto" });
        }
      }
      return;
    }
  }

  if (primaryPanel) {
    primaryPanel.scrollTop = snapshot.panelScrollTop;
  }

  if (primaryPreviewEl) {
    primaryPreviewEl.scrollTop = snapshot.previewScrollTop;
  }

  const panelStyle = primaryPanel ? window.getComputedStyle(primaryPanel) : null;
  const panelScrolls = panelStyle && (panelStyle.overflowY === "auto" || panelStyle.overflowY === "scroll");
  if (!panelScrolls && activeTab === "primary") {
    window.scrollTo({ top: snapshot.windowScrollTop, behavior: "auto" });
  }
}

function normalizePreviewText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenisePreviewText(text) {
  return normalizePreviewText(text)
    .split(" ")
    .filter((token) => token.length > 2);
}

function findBestParagraphIndexFromPreviewText(previewText) {
  if (!editorState || !Array.isArray(editorState.paragraphs) || editorState.paragraphs.length === 0) {
    return -1;
  }

  const snippet = normalizePreviewText(previewText);
  if (!snippet) {
    return -1;
  }

  const paragraphs = editorState.paragraphs;
  if (snippet.length >= 24) {
    for (let i = 0; i < paragraphs.length; i += 1) {
      const paragraphText = normalizePreviewText(paragraphs[i].text || "");
      if (paragraphText.includes(snippet) || snippet.includes(paragraphText)) {
        return i;
      }
    }
  }

  const tokens = tokenisePreviewText(snippet).slice(0, 16);
  if (tokens.length === 0) {
    return -1;
  }

  let best = { index: -1, score: 0 };
  for (let i = 0; i < paragraphs.length; i += 1) {
    const paragraphText = normalizePreviewText(paragraphs[i].text || "");
    if (!paragraphText) {
      continue;
    }

    let overlap = 0;
    for (const token of tokens) {
      if (paragraphText.includes(token)) {
        overlap += 1;
      }
    }

    const score = overlap / tokens.length;
    if (score > best.score) {
      best = { index: i, score };
    }
  }

  return best.score >= 0.34 ? best.index : -1;
}

function markActivePreviewAnchor(anchor) {
  if (activePreviewAnchorEl && activePreviewAnchorEl !== anchor) {
    activePreviewAnchorEl.classList.remove("active");
  }

  activePreviewAnchorEl = anchor || null;
  if (activePreviewAnchorEl) {
    activePreviewAnchorEl.classList.add("active");
  }
}

function syncActivePreviewAnchorWithState() {
  if (!primaryPreviewEl || !editorState || !Number.isInteger(editorState.startParagraph)) {
    markActivePreviewAnchor(null);
    return;
  }

  const selector = `.preview-anchor[data-paragraph-index="${editorState.startParagraph}"]`;
  const mappedAnchor = primaryPreviewEl.querySelector(selector);
  if (mappedAnchor) {
    markActivePreviewAnchor(mappedAnchor);
    return;
  }

  markActivePreviewAnchor(null);
}

function getPreviewAnchorFromTarget(target) {
  if (!primaryPreviewEl || !target) {
    return null;
  }

  const anchor = target.closest(".preview-anchor");
  if (!anchor || !primaryPreviewEl.contains(anchor)) {
    return null;
  }

  return anchor;
}

function navigateFromPreviewAnchor(anchor, options = {}) {
  if (!anchor) {
    return;
  }

  const mappedIndex = Number(anchor.dataset.paragraphIndex);
  if (Number.isInteger(mappedIndex) && mappedIndex >= 0) {
    setError("");
    markActivePreviewAnchor(anchor);
    setStartParagraph(mappedIndex, options).catch((error) => setError(error.message));
    return;
  }

  const previewText = anchor.innerText || anchor.textContent || "";
  const index = findBestParagraphIndexFromPreviewText(previewText);
  if (!Number.isInteger(index) || index < 0) {
    setError("Unable to map this preview paragraph to a primary paragraph.");
    return;
  }

  setError("");
  markActivePreviewAnchor(anchor);
  setStartParagraph(index, options).catch((error) => setError(error.message));
}

function centerSelectedParagraphInViewport() {
  if (!primaryPreviewEl) {
    return;
  }

  const primaryPanel = tabPanels.primary;
  const panelStyle = primaryPanel ? window.getComputedStyle(primaryPanel) : null;
  const panelScrolls = panelStyle && (panelStyle.overflowY === "auto" || panelStyle.overflowY === "scroll");

  if (panelScrolls && primaryPanel) {
    const panelRect = primaryPanel.getBoundingClientRect();
    const previewRect = primaryPreviewEl.getBoundingClientRect();
    const offsetInPanel = previewRect.top - panelRect.top + primaryPanel.scrollTop;
    const targetScroll = offsetInPanel - primaryPanel.clientHeight / 2 + previewRect.height / 2;
    primaryPanel.scrollTo({ top: Math.max(0, targetScroll), behavior: "smooth" });
    return;
  }

  const header = document.querySelector(".top-menu");
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  const rect = primaryPreviewEl.getBoundingClientRect();
  const currentTop = window.scrollY || window.pageYOffset;
  const targetTop = currentTop + rect.top - (window.innerHeight / 2) + (rect.height / 2) - (headerHeight / 2);
  window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
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

  if (nextTab === "compare") {
    window.setTimeout(() => {
      const header = document.querySelector(".top-menu");
      const headerHeight = header ? header.getBoundingClientRect().height : 0;
      const panel = tabPanels.compare;
      const rect = panel.getBoundingClientRect();
      const currentTop = window.scrollY || window.pageYOffset;
      const targetTop = currentTop + rect.top - headerHeight - 8;

      window.scrollTo({
        top: Math.max(0, targetTop),
        behavior: "smooth",
      });
    }, 0);
  }

  if (nextTab === "secondary") {
    window.setTimeout(() => {
      resizeSecondaryInputToViewport();
    }, 0);
  }
}

function renderParagraphs(state, options = {}) {
  return;
}

function renderDiff(state) {
  const diff = (state && state.diff) || {};
  diffWrapEl.innerHTML = `<div class="diff">${diff.inlineHtml || ""}</div>`;
}

function renderPrimaryPreview(state) {
  if (!primaryPreviewEl) {
    return;
  }

  primaryPreviewEl.hidden = false;

  const html = String((state && state.primaryPreviewHtml) || "").trim();
  if (!html) {
    primaryPreviewEl.innerHTML = "<p class=\"muted\">Styled preview unavailable for this file.</p>";
    lastRenderedPrimaryPreviewHtml = html;
    clearPrimarySearchHighlights();
    updatePrimarySearchCount();
    return;
  }

  if (lastRenderedPrimaryPreviewHtml === html && primaryPreviewEl.innerHTML) {
    if (!primaryPreviewEl.hidden) {
      attachPreviewParagraphAnchors();
    }
    return;
  }

  primaryPreviewEl.innerHTML = html;
  lastRenderedPrimaryPreviewHtml = html;
  rasterizePreviewCanvases();
  attachPreviewParagraphAnchors();
  // Content was replaced wholesale, so re-highlight without jumping the viewport.
  reapplyPrimarySearchHighlights();
}

function clearPrimarySearchHighlights() {
  if (primaryPreviewEl) {
    primaryPreviewEl.querySelectorAll("mark.primary-search-match").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) {
        return;
      }
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }

  primarySearchMatches = [];
  primarySearchActiveIndex = -1;
}

function updatePrimarySearchCount() {
  if (!primarySearchCountEl) {
    return;
  }

  primarySearchCountEl.textContent =
    primarySearchMatches.length > 0 ? `${primarySearchActiveIndex + 1}/${primarySearchMatches.length}` : "0/0";
}

function applyPrimarySearchHighlights(term, options = {}) {
  const { preserveActiveIndex = false, skipScroll = false } = options;
  const previousActiveIndex = primarySearchActiveIndex;
  clearPrimarySearchHighlights();

  if (!primaryPreviewEl || !term) {
    updatePrimarySearchCount();
    return;
  }

  const lowerTerm = term.toLowerCase();
  const walker = document.createTreeWalker(primaryPreviewEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) {
        return NodeFilter.FILTER_REJECT;
      }
      const parentTag = node.parentElement ? node.parentElement.tagName : "";
      if (parentTag === "SCRIPT" || parentTag === "STYLE") {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    textNodes.push(node);
  }

  textNodes.forEach((textNode) => {
    const text = textNode.nodeValue;
    const lowerText = text.toLowerCase();
    if (!lowerText.includes(lowerTerm)) {
      return;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let matchIndex = lowerText.indexOf(lowerTerm, cursor);
    while (matchIndex !== -1) {
      if (matchIndex > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, matchIndex)));
      }

      const mark = document.createElement("mark");
      mark.className = "primary-search-match";
      mark.textContent = text.slice(matchIndex, matchIndex + term.length);
      fragment.appendChild(mark);
      primarySearchMatches.push(mark);

      cursor = matchIndex + term.length;
      matchIndex = lowerText.indexOf(lowerTerm, cursor);
    }

    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    textNode.parentNode.replaceChild(fragment, textNode);
  });

  if (primarySearchMatches.length === 0) {
    updatePrimarySearchCount();
    return;
  }

  const nextIndex = preserveActiveIndex && previousActiveIndex >= 0
    ? Math.min(previousActiveIndex, primarySearchMatches.length - 1)
    : 0;

  primarySearchActiveIndex = nextIndex;
  primarySearchMatches[nextIndex].classList.add("active");
  updatePrimarySearchCount();

  if (!skipScroll) {
    primarySearchMatches[nextIndex].scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function reapplyPrimarySearchHighlights() {
  if (!primarySearchInputEl) {
    return;
  }

  const term = primarySearchInputEl.value.trim();
  if (!term) {
    clearPrimarySearchHighlights();
    updatePrimarySearchCount();
    return;
  }

  applyPrimarySearchHighlights(term, { preserveActiveIndex: true, skipScroll: true });
}

function focusPrimarySearchMatch(index) {
  if (primarySearchMatches.length === 0) {
    return;
  }

  primarySearchMatches.forEach((mark) => mark.classList.remove("active"));
  const normalizedIndex = ((index % primarySearchMatches.length) + primarySearchMatches.length) % primarySearchMatches.length;
  primarySearchActiveIndex = normalizedIndex;

  const activeMark = primarySearchMatches[normalizedIndex];
  activeMark.classList.add("active");
  activeMark.scrollIntoView({ block: "center", behavior: "smooth" });
  updatePrimarySearchCount();
}

function attachPreviewParagraphAnchors() {
  if (!primaryPreviewEl || !editorState || !Array.isArray(editorState.paragraphs)) {
    return;
  }

  markActivePreviewAnchor(null);

  const paragraphCount = editorState.paragraphs.length;
  let nextGuessIndex = 0;
  const candidates = primaryPreviewEl.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote");
  candidates.forEach((node) => {
    if (node.closest("table") || node.closest("figure")) {
      return;
    }

    const text = String(node.textContent || "").trim();
    if (text.length < 8) {
      return;
    }

    // Prefer monotonic mapping to keep click -> paragraph selection stable.
    let mappedIndex = -1;
    const upperBound = Math.min(paragraphCount - 1, Math.max(nextGuessIndex + 24, 0));
    const localSlice = editorState.paragraphs.slice(nextGuessIndex, upperBound + 1);
    if (localSlice.length > 0) {
      let bestLocal = { offset: -1, score: 0 };
      const tokens = tokenisePreviewText(text).slice(0, 16);

      for (let offset = 0; offset < localSlice.length; offset += 1) {
        const candidateText = normalizePreviewText(localSlice[offset].text || "");
        if (!candidateText) {
          continue;
        }

        let overlap = 0;
        for (const token of tokens) {
          if (candidateText.includes(token)) {
            overlap += 1;
          }
        }

        const score = tokens.length > 0 ? overlap / tokens.length : 0;
        if (score > bestLocal.score) {
          bestLocal = { offset, score };
        }
      }

      if (bestLocal.offset >= 0 && bestLocal.score >= 0.3) {
        mappedIndex = nextGuessIndex + bestLocal.offset;
      }
    }

    if (mappedIndex < 0) {
      mappedIndex = findBestParagraphIndexFromPreviewText(text);
    }

    if (Number.isInteger(mappedIndex) && mappedIndex >= 0) {
      node.dataset.paragraphIndex = String(mappedIndex);
      nextGuessIndex = Math.min(paragraphCount - 1, Math.max(mappedIndex, nextGuessIndex));
    }

    node.classList.add("preview-anchor");
    node.title = "Click to set start paragraph. Double-click to open Diff.";
  });

  syncActivePreviewAnchorWithState();
}

function rasterizePreviewCanvases() {
  if (!primaryPreviewEl) {
    return;
  }

  const canvases = Array.from(primaryPreviewEl.querySelectorAll("canvas"));
  canvases.forEach((canvas, index) => {
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const image = document.createElement("img");
      image.src = dataUrl;
      image.alt = canvas.getAttribute("aria-label") || `Diagram ${index + 1}`;
      image.className = "primary-preview-rasterized";

      const width = Number(canvas.getAttribute("width"));
      const height = Number(canvas.getAttribute("height"));
      if (Number.isFinite(width) && width > 0) {
        image.width = width;
      }
      if (Number.isFinite(height) && height > 0) {
        image.height = height;
      }

      canvas.replaceWith(image);
    } catch (_error) {
      // Keep original canvas if conversion fails.
    }
  });
}

function renderState(state, options = {}) {
  const { preferParagraphReuse = false, skipPreviewRender = false } = options;
  editorState = state;
  document.getElementById("job-title").textContent = state.name || jobId;
  setStatus(state.status);
  updatedAtEl.textContent = `Last update: ${state.updatedAt || "--"}`;
  startBadgeEl.textContent = `Start paragraph: ${Number.isInteger(state.startParagraph) ? state.startParagraph + 1 : "--"}`;
  secondaryCountBadgeEl.textContent = `Secondary paragraphs: ${Number.isInteger(state.secondaryParagraphCount) ? state.secondaryParagraphCount : 0}`;
  const range = state.compareRange || { start: 0, end: -1, count: 0 };
  rangeBadgeEl.textContent =
    range.count > 0 ? `Range: ${range.start + 1}-${range.end + 1} (${range.count})` : "Range: empty";
  primaryDocxPathEl.textContent = `Primary DOCX: ${state.primaryDocx || "--"}`;
  primaryDocxPathEl.title = state.primaryDocx || "";
  setError(state.error || "");

  if (document.activeElement !== windowExtraInputEl) {
    windowExtraInputEl.value = String(Number.isInteger(state.windowExtra) ? state.windowExtra : 0);
  }

  if (document.activeElement !== secondaryInputEl) {
    secondaryInputEl.value = state.secondaryText || "";
    setSecondarySyncStatus("Synced", "ok");
  }

  if (diffModeButtonEls.length > 0) {
    const mode = state.diffMode || "word";
    diffModeButtonEls.forEach((button) => {
      button.classList.toggle("active", button.dataset.diffMode === mode);
    });
  }

  if (compareDirectionButtonEls.length > 0) {
    const compareDirection = state.compareDirection || "secondary-to-primary";
    compareDirectionButtonEls.forEach((button) => {
      button.classList.toggle("active", button.dataset.compareDirection === compareDirection);
    });
  }

  if (!skipPreviewRender) {
    renderPrimaryPreview(state);
  } else {
    syncActivePreviewAnchorWithState();
  }
  renderDiff(state);

  if (activeTab === "secondary") {
    window.setTimeout(() => {
      resizeSecondaryInputToViewport();
    }, 0);
  }
}

async function fetchEditorState(options = {}) {
  const { force = false, renderOptions = {} } = options;
  if (!force && isSseSuppressed()) {
    return;
  }

  const response = await fetch(`/api/job/${encodeURIComponent(jobId)}/editor-state`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load editor state: ${response.status}`);
  }

  const state = await response.json();
  const viewportSnapshot = activeTab === "primary" ? capturePrimaryViewport() : null;

  renderState(state, renderOptions);

  if (viewportSnapshot) {
    window.requestAnimationFrame(() => {
      restorePrimaryViewport(viewportSnapshot);
    });
  }
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
    await fetchEditorState({ force: true });
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = original;
  }
}

async function setStartParagraph(index, options = {}) {
  const { openCompareTab = true } = options;
  const shouldPreserveViewport = !openCompareTab && activeTab === "primary";
  const viewportSnapshot = shouldPreserveViewport ? capturePrimaryViewport() : null;

  if (shouldPreserveViewport) {
    suppressImmediateSseRerender(1200);
  }

  const data = await postJson(`/api/job/${encodeURIComponent(jobId)}/start`, {
    startParagraph: index,
  });

  renderState(data.state, {
    skipPreviewRender: shouldPreserveViewport,
  });

  if (shouldPreserveViewport) {
    // Wait one frame so refreshed DOM measurements/scroll boxes are applied.
    window.requestAnimationFrame(() => {
      restorePrimaryViewport(viewportSnapshot);
    });
  }

  patchPersistedEditorState({ startParagraph: data.state.startParagraph });
  persistPrimaryViewportPosition();
  if (openCompareTab) {
    setActiveTab("compare");
  }
}

async function setDiffMode(diffMode, options = {}) {
  const { openCompareTab = false } = options;
  const next = String(diffMode || "").toLowerCase();
  if (!["word", "hybrid", "char"].includes(next)) {
    return;
  }

  const data = await postJson(`/api/job/${encodeURIComponent(jobId)}/diff-mode`, {
    diffMode: next,
  });

  renderState(data.state);
  patchPersistedEditorState({ diffMode: data.state.diffMode || "word" });

  if (openCompareTab) {
    setActiveTab("compare");
  }
}

async function setCompareDirection(compareDirection, options = {}) {
  const { openCompareTab = false } = options;
  const next = String(compareDirection || "").toLowerCase();
  if (!["primary-to-secondary", "secondary-to-primary"].includes(next)) {
    return;
  }

  const data = await postJson(`/api/job/${encodeURIComponent(jobId)}/compare-direction`, {
    compareDirection: next,
  });

  renderState(data.state);
  patchPersistedEditorState({ compareDirection: data.state.compareDirection || "secondary-to-primary" });

  if (openCompareTab) {
    setActiveTab("compare");
  }
}

async function applySecondaryText(options = {}) {
  const { openCompareTab = true, silent = false } = options;

  suppressImmediateSseRerender(2000);

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
    renderState(data.state, {
      skipPreviewRender: true,
    });
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

      if (isSseSuppressed()) {
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

if (primarySearchInputEl) {
  primarySearchInputEl.addEventListener("input", () => {
    if (primarySearchDebounceTimer) {
      window.clearTimeout(primarySearchDebounceTimer);
    }

    const term = primarySearchInputEl.value.trim();
    primarySearchDebounceTimer = window.setTimeout(() => {
      applyPrimarySearchHighlights(term);
    }, 200);
  });

  primarySearchInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      focusPrimarySearchMatch(primarySearchActiveIndex + (event.shiftKey ? -1 : 1));
    } else if (event.key === "Escape") {
      primarySearchInputEl.value = "";
      clearPrimarySearchHighlights();
      updatePrimarySearchCount();
    }
  });
}

if (primarySearchNextBtn) {
  primarySearchNextBtn.addEventListener("click", () => {
    focusPrimarySearchMatch(primarySearchActiveIndex + 1);
  });
}

if (primarySearchPrevBtn) {
  primarySearchPrevBtn.addEventListener("click", () => {
    focusPrimarySearchMatch(primarySearchActiveIndex - 1);
  });
}

applySecondaryBtn.addEventListener("click", () => {
  applySecondaryText().catch((error) => setError(error.message));
});

secondaryInputEl.addEventListener("input", () => {
  suppressImmediateSseRerender(2500);
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

diffModeButtonEls.forEach((button) => {
  button.addEventListener("click", () => {
    setDiffMode(button.dataset.diffMode, { openCompareTab: false }).catch((error) => setError(error.message));
  });
});

compareDirectionButtonEls.forEach((button) => {
  button.addEventListener("click", () => {
    setCompareDirection(button.dataset.compareDirection, { openCompareTab: false }).catch((error) => setError(error.message));
  });
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tab);
  });
});

if (primaryPreviewEl) {
  primaryPreviewEl.addEventListener("click", (event) => {
    const anchor = getPreviewAnchorFromTarget(event.target);
    navigateFromPreviewAnchor(anchor, { openCompareTab: false });
  });

  primaryPreviewEl.addEventListener("dblclick", (event) => {
    const anchor = getPreviewAnchorFromTarget(event.target);
    navigateFromPreviewAnchor(anchor, { openCompareTab: true });
  });

  primaryPreviewEl.addEventListener("scroll", () => {
    schedulePersistPrimaryViewportPosition();
  });
}

window.addEventListener("scroll", () => {
  if (activeTab === "primary") {
    schedulePersistPrimaryViewportPosition();
  }
});

window.addEventListener("resize", () => {
  resizeSecondaryInputToViewport();
  applyCompareBoxWidth(compareWidthInputEl ? compareWidthInputEl.value : compareBoxWidthDefaultPct, { persist: false });
});

if (compareWidthInputEl) {
  compareWidthInputEl.addEventListener("input", () => {
    applyCompareBoxWidth(compareWidthInputEl.value);
  });
}

async function initPage() {
  applyCompareBoxWidth(compareBoxWidthDefaultPct, { persist: false });
  setActiveTab("primary");
  await fetchEditorState({ force: true });
  const restoreResult = await restorePersistedEditorState();
  if (!restoreResult || !restoreResult.restoredViewport) {
    window.setTimeout(() => {
      centerSelectedParagraphInViewport();
    }, 0);
  }

  if (!setupSse()) {
    window.setInterval(() => {
      fetchEditorState().catch(() => {
        // Ignore intermittent polling errors.
      });
    }, pollMs);
  }
}

initPage().catch((error) => setError(error.message));
