const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");

const { convertDocxToText } = require("./pandoc");
const { buildDiff, normaliseText } = require("./textUtils");

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

    watchTarget({
      filePath: jobConfig.secondaryText,
      stabilityThreshold: 300,
      onReason: "secondary",
      ignoreTemp: false,
    });
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
      });
      const normalizedPrimary = normaliseText(primaryText, config.normalise || {});
      fs.writeFileSync(primaryTxtPath, normalizedPrimary, "utf8");
    } catch (error) {
      this.setError(jobId, `Conversion failed: ${error.message}`);
      return;
    }

    console.log(`[job:${jobId}] trigger=${reason} diffing`);
    job.status = "diffing";
    this.emitUpdate(jobId);

    try {
      const secondaryText = fs.readFileSync(config.secondaryText, "utf8");
      const diff = buildDiff(primaryText, secondaryText, {
        normalise: config.normalise || {},
        compareMode: config.compareMode || "full",
      });
      const diffHtmlDoc = this.wrapDiffHtml(job, diff.inlineHtml);

      fs.writeFileSync(diffHtmlPath, diffHtmlDoc, "utf8");

      job.diff = diff;
      job.status = "ok";
      job.error = null;
      job.updatedAt = new Date().toISOString();

      console.log(`[job:${jobId}] updated, changes=${diff.changes}`);
      this.emitUpdate(jobId);
    } catch (error) {
      this.setError(jobId, `Diff failed: ${error.message}`);
    }
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
