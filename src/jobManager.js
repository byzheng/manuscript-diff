const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");

const { convertDocxToText } = require("./pandoc");
const { buildDiff, normaliseText, splitParagraphs } = require("./textUtils");

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
        startParagraph: 0,
        diffMode: ["word", "hybrid", "char"].includes(jobConfig.diffMode) ? jobConfig.diffMode : "word",
        windowExtra: Number.isInteger(jobConfig.windowExtra) ? jobConfig.windowExtra : 0,
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

    try {
      primaryText = await convertDocxToText({
        pandocPath: this.config.pandocPath,
        inputPath: config.primaryDocx,
        extraArgs: config.pandocArgs,
        conversionMode: config.conversionMode,
      });
      const normalizedPrimary = normaliseText(primaryText, config.normalise || {});
      fs.writeFileSync(primaryTxtPath, normalizedPrimary, "utf8");
      job.primaryNormalized = normalizedPrimary;
      job.primaryParagraphs = splitParagraphs(normalizedPrimary);
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
    await this.compareOnly(jobId, "set-start-paragraph");
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
      status: job.status,
      error: job.error,
      updatedAt: job.updatedAt,
      startParagraph: job.startParagraph,
      diffMode: job.diffMode,
      windowExtra: job.windowExtra,
      secondaryParagraphCount: job.secondaryParagraphCount,
      compareRange: job.compareRange,
      paragraphs: job.primaryParagraphs.map((text, index) => ({ index, text })),
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
}

module.exports = {
  JobManager,
};
