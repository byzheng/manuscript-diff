const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const sanitizeHtml = require("sanitize-html");
const { parseDocument } = require("htmlparser2");

const { convertDocxToText, convertDocxToHtmlPreview, runMammothHtml, withTempCopyOnPermission } = require("./pandoc");
const { buildDiff, normaliseText, splitParagraphs } = require("./textUtils");

function sanitisePrimaryPreviewHtml(inputHtml) {
  return sanitizeHtml(String(inputHtml || ""), {
    allowedTags: [
      "div",
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "sup",
      "sub",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "hr",
      "span",
      "a",
      "figure",
      "figcaption",
      "pre",
      "code",
      "img",
      "canvas",
    ],
    allowedAttributes: {
      "*": ["colspan", "rowspan", "width", "height", "class"],
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      canvas: ["width", "height"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      img: ["http", "https", "data"],
    },
    disallowedTagsMode: "discard",
  });
}

function scorePreviewHtml(previewHtml) {
  const html = String(previewHtml || "").toLowerCase();
  if (!html.trim()) {
    return Number.NEGATIVE_INFINITY;
  }

  const scoreMatches = (pattern, weight) => ((html.match(pattern) || []).length || 0) * weight;

  let score = 0;
  score += scoreMatches(/<img\b/g, 6);
  score += scoreMatches(/<figure\b/g, 4);
  score += scoreMatches(/<svg\b/g, 4);
  score += scoreMatches(/<table\b/g, 2);
  score += scoreMatches(/<figcaption\b/g, 1);

  score -= scoreMatches(/\[(drawing|shape|textbox|diagram|canvas)[^\]]*\]/g, 4);
  score -= scoreMatches(/drawingml|v:shape|canvas text|textbox:/g, 3);

  return score;
}

function pickBestPreviewHtml(candidates) {
  let bestHtml = "";
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const html of candidates) {
    const score = scorePreviewHtml(html);
    if (score > bestScore) {
      bestScore = score;
      bestHtml = html;
    }
  }

  return bestHtml;
}

function getDirectChildTags(el, tagNames) {
  return (el.children || []).filter((child) => child.type === "tag" && tagNames.includes(child.name));
}

function getElementText(el) {
  let result = "";
  for (const child of el.children || []) {
    if (child.type === "text") {
      result += child.data;
    } else if (child.type === "tag") {
      result += child.name === "br" ? " " : getElementText(child);
    }
  }
  return result;
}

function collectCellParagraphTexts(cellEl) {
  const texts = [];

  const walk = (node) => {
    for (const child of node.children || []) {
      // Nested tables (rare) are ignored so their paragraphs don't bleed into this cell.
      if (child.type !== "tag" || child.name === "table") {
        continue;
      }

      if (child.name === "p") {
        const text = getElementText(child).replace(/\s+/g, " ").trim();
        if (text) {
          texts.push(text);
        }
        continue;
      }

      walk(child);
    }
  };

  walk(cellEl);

  if (texts.length > 0) {
    return texts;
  }

  const wholeText = getElementText(cellEl).replace(/\s+/g, " ").trim();
  return wholeText ? [wholeText] : [];
}

function getTableRows(tableEl) {
  const directRows = getDirectChildTags(tableEl, ["tr"]);
  if (directRows.length > 0) {
    return directRows;
  }

  const sections = getDirectChildTags(tableEl, ["thead", "tbody", "tfoot"]);
  return sections.flatMap((section) => getDirectChildTags(section, ["tr"]));
}

function findTableElements(node, results) {
  for (const child of node.children || []) {
    if (child.type !== "tag") {
      continue;
    }

    if (child.name === "table") {
      results.push(child);
      continue;
    }

    findTableElements(child, results);
  }
}

// Extracts the exact per-cell paragraph text from the same HTML the browser renders, so a
// clicked <tr>/<td> can be identified by its structural position instead of fuzzy text matching.
function extractPrimaryTables(html) {
  if (!html) {
    return [];
  }

  const dom = parseDocument(String(html));
  const tableEls = [];
  findTableElements(dom, tableEls);

  return tableEls.map((tableEl) =>
    getTableRows(tableEl).map((rowEl) =>
      getDirectChildTags(rowEl, ["td", "th"]).map((cellEl) => collectCellParagraphTexts(cellEl))
    )
  );
}

class JobManager {
  constructor(config) {
    this.config = config;
    this.jobs = new Map();
    this.watchers = [];
    this.listeners = new Set();
    this.debounceTimers = new Map();
  }

  async init() {
    for (const jobConfig of this.config.jobs) {
      fs.mkdirSync(jobConfig.outputDir, { recursive: true });

      this.jobs.set(jobConfig.id, {
        id: jobConfig.id,
        name: jobConfig.name || jobConfig.id,
        config: jobConfig,
        status: "starting",
        error: null,
        updatedAt: null,
        primaryNormalized: "",
        primaryParagraphs: [],
        primaryPreviewHtml: "",
        primaryTables: [],
        startParagraph: 0,
        diffMode: ["word", "hybrid", "char"].includes(jobConfig.diffMode) ? jobConfig.diffMode : "word",
        compareDirection:
          jobConfig.compareDirection === "primary-to-secondary" ? "primary-to-secondary" : "secondary-to-primary",
        windowExtra: Number.isInteger(jobConfig.windowExtra) ? jobConfig.windowExtra : 0,
        primarySelectionOverride: null,
        selectedTableCell: null,
        secondaryParagraphCount: 0,
        compareRange: { start: 0, end: -1, count: 0 },
        secondaryOverride: null,
        diff: {
          inlineHtml: "",
          sideBySide: { left: "", right: "" },
          changes: 0,
          primaryLength: 0,
          secondaryLength: 0,
        },
      });

      this.createWatchers(jobConfig);
      await this.refreshJob(jobConfig.id, "initial");
    }
  }

  createWatchers(jobConfig) {
    const ignoredTempDocx = /(^|[\\/])~\$.*\.docx$/i;

    const watchTarget = ({ filePath, stabilityThreshold, onReason, ignoreTemp }) => {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath).toLowerCase();

      const watcher = chokidar.watch(dir, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold,
          pollInterval: 100,
        },
      });

      const handle = (eventName, changedPath) => {
        if (ignoreTemp && ignoredTempDocx.test(changedPath)) {
          return;
        }

        const changedBase = path.basename(changedPath).toLowerCase();
        if (changedBase !== base) {
          return;
        }

        this.scheduleRefresh(jobConfig.id, `${onReason}-${eventName}`);
      };

      watcher.on("add", (changedPath) => handle("add", changedPath));
      watcher.on("change", (changedPath) => handle("change", changedPath));
      watcher.on("unlink", (changedPath) => handle("unlink", changedPath));
      watcher.on("error", (error) => this.setError(jobConfig.id, `Watcher error: ${error.message}`));
      this.watchers.push(watcher);
    };

    watchTarget({
      filePath: jobConfig.primaryDocx,
      stabilityThreshold: 400,
      onReason: "primary",
      ignoreTemp: true,
    });

    if (typeof jobConfig.secondaryText === "string" && jobConfig.secondaryText.trim() !== "") {
      watchTarget({
        filePath: jobConfig.secondaryText,
        stabilityThreshold: 300,
        onReason: "secondary",
        ignoreTemp: false,
      });
    }
  }

  scheduleRefresh(jobId, reason) {
    const ms = this.config.debounceMs;
    const existing = this.debounceTimers.get(jobId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.refreshJob(jobId, reason).catch((error) => {
        this.setError(jobId, error.message);
      });
      this.debounceTimers.delete(jobId);
    }, ms);

    this.debounceTimers.set(jobId, timer);
  }

  async forceRefresh(jobId, reason = "api-refresh") {
    const existing = this.debounceTimers.get(jobId);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(jobId);
    }

    await this.refreshJob(jobId, reason);
  }

  async refreshJob(jobId, reason = "manual") {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    const { config } = job;
    const primaryTxtPath = path.join(config.outputDir, "primary.txt");
    const diffHtmlPath = path.join(config.outputDir, "diff.html");

    console.log(`[job:${jobId}] trigger=${reason} converting`);
    job.status = "converting";
    job.error = null;
    this.emitUpdate(jobId);

    let primaryText = "";
    let primaryPreviewHtml = "";

    try {
      primaryText = await convertDocxToText({
        pandocPath: this.config.pandocPath,
        inputPath: config.primaryDocx,
        extraArgs: config.pandocArgs,
        conversionMode: config.conversionMode,
      });

      try {
        let mammothPreviewHtml = "";
        let pandocPreviewHtml = "";

        try {
          const rawMammothPreviewHtml = await withTempCopyOnPermission(config.primaryDocx, (candidatePath) =>
            runMammothHtml(candidatePath)
          );
          mammothPreviewHtml = sanitisePrimaryPreviewHtml(rawMammothPreviewHtml);
        } catch (_mammothPreviewError) {
          mammothPreviewHtml = "";
        }

        try {
          const rawPandocPreviewHtml = await convertDocxToHtmlPreview({
            pandocPath: this.config.pandocPath,
            inputPath: config.primaryDocx,
          });
          pandocPreviewHtml = sanitisePrimaryPreviewHtml(rawPandocPreviewHtml);
        } catch (_pandocPreviewError) {
          pandocPreviewHtml = "";
        }

        primaryPreviewHtml = pickBestPreviewHtml([mammothPreviewHtml, pandocPreviewHtml]);
      } catch (_previewError) {
        primaryPreviewHtml = "";
      }

      const normalizedPrimary = normaliseText(primaryText, config.normalise || {});
      fs.writeFileSync(primaryTxtPath, normalizedPrimary, "utf8");
      job.primaryNormalized = normalizedPrimary;
      job.primaryParagraphs = splitParagraphs(normalizedPrimary);
      job.primaryPreviewHtml = primaryPreviewHtml;
      job.primaryTables = extractPrimaryTables(primaryPreviewHtml);
      // Preview content just changed, so any previously selected table cell is no longer valid.
      job.primarySelectionOverride = null;
      job.selectedTableCell = null;
      if (job.startParagraph >= job.primaryParagraphs.length) {
        job.startParagraph = 0;
      }
    } catch (error) {
      this.setError(jobId, `Conversion failed: ${error.message}`);
      return;
    }

    console.log(`[job:${jobId}] trigger=${reason} diffing`);
    job.status = "diffing";
    this.emitUpdate(jobId);

    try {
      const secondaryText = this.getSecondaryText(job);
      const result = this.computeDiffFromCurrentState(job, secondaryText);
      this.persistDiff(job, result.diff, diffHtmlPath);
      job.secondaryParagraphCount = result.secondaryParagraphCount;
      job.compareRange = result.compareRange;
      job.status = "ok";
      job.error = null;
      job.updatedAt = new Date().toISOString();

      console.log(`[job:${jobId}] updated, changes=${result.diff.changes}`);
      this.emitUpdate(jobId);
    } catch (error) {
      this.setError(jobId, `Diff failed: ${error.message}`);
    }
  }

  getSecondaryText(job) {
    if (typeof job.secondaryOverride === "string") {
      return job.secondaryOverride;
    }

    const secondaryPath = job.config.secondaryText;
    if (typeof secondaryPath !== "string" || secondaryPath.trim() === "") {
      return "";
    }

    try {
      return fs.readFileSync(secondaryPath, "utf8");
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return "";
      }

      throw error;
    }
  }

  computeDiffFromCurrentState(job, secondaryText) {
    const normalisedSecondary = normaliseText(String(secondaryText || ""), job.config.normalise || {});
    const secondaryParagraphs = splitParagraphs(normalisedSecondary);
    const secondaryParagraphCount = secondaryParagraphs.length;

    // A selected table cell is compared using its exact extracted text directly, bypassing
    // the paragraph-index range below entirely (no fuzzy matching involved).
    if (typeof job.primarySelectionOverride === "string" && job.primarySelectionOverride.length > 0) {
      const selectedPrimary = job.primarySelectionOverride;
      const diff = buildDiff(selectedPrimary, secondaryText, {
        normalise: job.config.normalise || {},
        compareMode: "full",
        diffMode: job.diffMode,
        compareDirection: job.compareDirection,
      });

      return {
        diff,
        secondaryParagraphCount,
        compareRange: { start: -1, end: -1, count: splitParagraphs(selectedPrimary).length },
      };
    }

    const totalPrimary = job.primaryParagraphs.length;
    const safeStart = Math.min(Math.max(0, job.startParagraph), Math.max(0, totalPrimary - 1));
    const extra = Math.max(0, Number(job.windowExtra) || 0);
    const desiredCount = secondaryParagraphCount > 0 ? secondaryParagraphCount + extra : 0;
    const actualCount = totalPrimary > 0 ? Math.max(0, Math.min(desiredCount, totalPrimary - safeStart)) : 0;

    const start = safeStart;
    const end = actualCount > 0 ? safeStart + actualCount - 1 : -1;
    const selectedPrimary = actualCount > 0 ? job.primaryParagraphs.slice(start, end + 1).join("\n\n") : "";

    const diff = buildDiff(selectedPrimary, secondaryText, {
      normalise: job.config.normalise || {},
      compareMode: "full",
      diffMode: job.diffMode,
      compareDirection: job.compareDirection,
    });

    return {
      diff,
      secondaryParagraphCount,
      compareRange: { start, end, count: actualCount },
    };
  }

  persistDiff(job, diff, diffHtmlPath) {
    const diffHtmlDoc = this.wrapDiffHtml(job, diff.inlineHtml);
    fs.writeFileSync(diffHtmlPath, diffHtmlDoc, "utf8");
    job.diff = diff;
  }

  async compareOnly(jobId, reason = "manual-compare") {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("Unknown job id");
    }

    const diffHtmlPath = path.join(job.config.outputDir, "diff.html");
    job.status = "diffing";
    job.error = null;
    this.emitUpdate(jobId);

    const secondaryText = this.getSecondaryText(job);
    const result = this.computeDiffFromCurrentState(job, secondaryText);
    this.persistDiff(job, result.diff, diffHtmlPath);
    job.secondaryParagraphCount = result.secondaryParagraphCount;
    job.compareRange = result.compareRange;

    job.status = "ok";
    job.updatedAt = new Date().toISOString();
    console.log(`[job:${jobId}] trigger=${reason} updated, changes=${result.diff.changes}`);
    this.emitUpdate(jobId);
  }

  async setStartParagraph(jobId, startParagraph) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("Unknown job id");
    }

    const next = Number(startParagraph);
    if (!Number.isInteger(next) || next < 0 || next >= Math.max(1, job.primaryParagraphs.length)) {
      throw new Error("Invalid startParagraph");
    }

    job.startParagraph = next;
    job.primarySelectionOverride = null;
    job.selectedTableCell = null;
    await this.compareOnly(jobId, "set-start-paragraph");
  }

  async setPrimaryCellSelection(jobId, tableIndex, rowIndex, colIndex) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("Unknown job id");
    }

    const table = Array.isArray(job.primaryTables) ? job.primaryTables[Number(tableIndex)] : null;
    const row = Array.isArray(table) ? table[Number(rowIndex)] : null;
    const cell = Array.isArray(row) ? row[Number(colIndex)] : null;
    if (!Array.isArray(cell) || cell.length === 0) {
      throw new Error("Unknown table cell");
    }

    job.primarySelectionOverride = cell.join("\n\n");
    job.selectedTableCell = { tableIndex: Number(tableIndex), rowIndex: Number(rowIndex), colIndex: Number(colIndex) };
    await this.compareOnly(jobId, "set-primary-cell-selection");
  }

  async setSecondaryText(jobId, text) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("Unknown job id");
    }

    job.secondaryOverride = String(text || "");
    await this.compareOnly(jobId, "set-secondary-text");
  }

  async setWindowExtra(jobId, windowExtra) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("Unknown job id");
    }

    const next = Number(windowExtra);
    if (!Number.isInteger(next) || next < 0 || next > 50) {
      throw new Error("Invalid windowExtra");
    }

    job.windowExtra = next;
    await this.compareOnly(jobId, "set-window-extra");
  }

  async setDiffMode(jobId, diffMode) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("Unknown job id");
    }

    const next = String(diffMode || "").toLowerCase();
    if (!["word", "hybrid", "char"].includes(next)) {
      throw new Error("Invalid diffMode");
    }

    job.diffMode = next;
    await this.compareOnly(jobId, "set-diff-mode");
  }

  async setCompareDirection(jobId, compareDirection) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("Unknown job id");
    }

    const next = String(compareDirection || "").toLowerCase();
    if (!["primary-to-secondary", "secondary-to-primary"].includes(next)) {
      throw new Error("Invalid compareDirection");
    }

    job.compareDirection = next;
    await this.compareOnly(jobId, "set-compare-direction");
  }

  async runCompare(jobId, payload = {}) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("Unknown job id");
    }

    if (payload.startParagraph !== undefined) {
      const next = Number(payload.startParagraph);
      if (Number.isInteger(next) && next >= 0 && next < Math.max(1, job.primaryParagraphs.length)) {
        job.startParagraph = next;
      }
    }

    if (payload.secondaryText !== undefined) {
      job.secondaryOverride = String(payload.secondaryText || "");
    }

    if (payload.windowExtra !== undefined) {
      const next = Number(payload.windowExtra);
      if (Number.isInteger(next) && next >= 0 && next <= 50) {
        job.windowExtra = next;
      }
    }

    if (payload.diffMode !== undefined) {
      const next = String(payload.diffMode || "").toLowerCase();
      if (["word", "hybrid", "char"].includes(next)) {
        job.diffMode = next;
      }
    }

    if (payload.compareDirection !== undefined) {
      const next = String(payload.compareDirection || "").toLowerCase();
      if (["primary-to-secondary", "secondary-to-primary"].includes(next)) {
        job.compareDirection = next;
      }
    }

    await this.compareOnly(jobId, "api-compare");
  }

  getEditorState(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    return {
      id: job.id,
      name: job.name,
      primaryDocx: job.config.primaryDocx,
      status: job.status,
      error: job.error,
      updatedAt: job.updatedAt,
      startParagraph: job.startParagraph,
      diffMode: job.diffMode,
      compareDirection: job.compareDirection,
      windowExtra: job.windowExtra,
      selectedTableCell: job.selectedTableCell || null,
      secondaryParagraphCount: job.secondaryParagraphCount,
      compareRange: job.compareRange,
      paragraphs: job.primaryParagraphs.map((text, index) => ({ index, text })),
      primaryPreviewHtml: job.primaryPreviewHtml || "",
      secondaryText: this.getSecondaryText(job),
      diff: {
        inlineHtml: job.diff.inlineHtml,
        sideBySide: job.diff.sideBySide,
        changes: job.diff.changes,
        primaryLength: job.diff.primaryLength,
        secondaryLength: job.diff.secondaryLength,
        mode: job.diff.mode || job.diffMode,
      },
    };
  }

  wrapDiffHtml(job, body) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${job.name} Diff</title>
  <style>
    body { font-family: Georgia, serif; padding: 18px; line-height: 1.6; }
    .diff { white-space: pre-wrap; }
    .ins { background: #dff3df; text-decoration: underline; }
    .del { background: #ffe1e1; text-decoration: line-through; }
  </style>
</head>
<body>
  <h1>${job.name}</h1>
  <div class="diff">${body}</div>
</body>
</html>`;
  }

  setError(jobId, message) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    job.status = "error";
    job.error = message;
    job.updatedAt = new Date().toISOString();
    console.error(`[job:${jobId}] ${message}`);
    this.emitUpdate(jobId);
  }

  onUpdate(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitUpdate(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    const event = {
      jobId,
      updatedAt: job.updatedAt,
      status: job.status,
      error: job.error,
    };

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getJobList() {
    return Array.from(this.jobs.values()).map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      error: job.error,
      updatedAt: job.updatedAt,
    }));
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  async close() {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    const closeTasks = this.watchers.map((watcher) => watcher.close());
    await Promise.allSettled(closeTasks);
    this.watchers = [];
    this.listeners.clear();
  }
}

module.exports = {
  JobManager,
};
