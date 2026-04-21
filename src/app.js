const express = require("express");
const path = require("path");

const { loadConfig } = require("./config");
const { JobManager } = require("./jobManager");

function renderHomePage(jobs) {
  const listItems = jobs
    .map(
      (job) => `
      <li>
        <a href="/job/${encodeURIComponent(job.id)}">${job.name}</a>
        <span class="status status-${job.status}">${job.status.toUpperCase()}</span>
      </li>`
    )
    .join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Manuscript Diff Monitor</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main class="layout">
    <section class="home-hero">
      <h1>Manuscript Diff Monitor</h1>
      <p class="home-subtitle">Compare a Word manuscript against a revised text snippet quickly, with paragraph-based positioning and a real-time preview of changes for editing review.</p>
    </section>

    <section class="home-jobs">
      <h2>Configured Jobs</h2>
      <p class="muted">Choose a configured job to open the editor workspace.</p>
      <ul class="job-list">${listItems}</ul>
    </section>

    <section class="home-guide">
      <h2>Quick Start</h2>
      <p>Edit your manuscript in Word as usual, then copy the revised excerpt into the Secondary tab and open Diff for a real-time preview of word-level changes.</p>

      <div class="guide-grid">
        <article class="guide-card">
          <h3>Why Jobs Are Preconfigured</h3>
          <p>Jobs are fixed in config for security and consistency. This limits file access to approved paths and avoids accidentally diffing or exposing unrelated local files.</p>
        </article>

        <article class="guide-card">
          <h3>Tabs</h3>
          <ul>
            <li><strong>Primary</strong>: choose the start paragraph from the converted Word text.</li>
            <li><strong>Secondary</strong>: paste or edit your revised text snippet.</li>
            <li><strong>Diff</strong>: inspect the comparison result for the selected range.</li>
          </ul>
        </article>
      </div>

      <p><a class="help-link" href="/help">Open full help page</a></p>
    </section>
  </main>
</body>
</html>`;
}

function renderHelpPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Help | Manuscript Diff Monitor</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main class="layout">
    <h1>How To Use Manuscript Diff Monitor</h1>
    <p><a href="/">Back to jobs</a></p>

    <section class="home-guide">
      <h2>Workflow</h2>
      <ol>
        <li>Open a configured job from the home page.</li>
        <li>In <strong>Primary</strong>, click the paragraph where comparison should start.</li>
        <li>In <strong>Secondary</strong>, paste your revised text (from your new draft).</li>
        <li>Open <strong>Diff</strong> to inspect additions/deletions for that range.</li>
      </ol>
    </section>

    <section class="home-guide">
      <h2>Why Preconfigured Jobs</h2>
      <p>Preconfigured jobs are a security guardrail. The app only reads files listed in configuration, which helps prevent accidental access to sensitive folders and keeps output predictable for each manuscript.</p>
    </section>

    <section class="home-guide">
      <h2>Tab Summary</h2>
      <ul>
        <li><strong>Primary</strong>: source text and paragraph selection.</li>
        <li><strong>Secondary</strong>: editable target text snippet.</li>
        <li><strong>Diff</strong>: result view for selected range.</li>
      </ul>
    </section>
  </main>
</body>
</html>`;
}

function renderJobPage(jobId, pollFallbackMs) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Job ${jobId}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" />
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main class="layout">
    <header class="top-menu navbar navbar-expand-lg bg-white border rounded-3 px-2 py-2 mb-3 sticky-top">
      <a class="btn btn-outline-secondary btn-sm me-2" href="/">Home</a>

      <div class="d-flex flex-wrap gap-2 align-items-center flex-grow-1">
        <div class="tab-segment" role="tablist" aria-label="Editor tabs">
          <button class="tab-btn btn btn-outline-primary btn-sm active" type="button" data-tab="primary">Primary</button>
          <button class="tab-btn btn btn-outline-primary btn-sm" type="button" data-tab="secondary">Secondary</button>
          <button class="tab-btn btn btn-outline-primary btn-sm" type="button" data-tab="compare">Diff</button>
        </div>
        <button id="refresh-btn" class="btn btn-success btn-sm" type="button">Refresh</button>
        <div class="input-group input-group-sm window-extra-group">
          <span class="input-group-text">Extra</span>
          <input id="window-extra-input" type="number" min="0" max="50" step="1" class="form-control" value="0" />
          <button id="apply-window-extra-btn" class="btn btn-outline-secondary" type="button">Apply</button>
        </div>
      </div>

      <div class="search-row mt-2 mt-lg-0 ms-lg-2">
        <div class="input-group input-group-sm">
          <input id="paragraph-search-input" class="paragraph-search-input form-control" type="text" placeholder="Search primary paragraphs" />
          <button id="paragraph-search-btn" class="btn btn-outline-secondary" type="button">Search</button>
        </div>
        <a class="btn btn-outline-secondary btn-sm help-btn" href="/help" aria-label="Help" title="Help"></a>
      </div>
    </header>

    <h1 id="job-title" class="h3">${jobId}</h1>

    <section class="meta-row">
      <span id="status" class="status">STARTING</span>
      <span id="updated-at">Last update: --</span>
      <span id="start-badge" class="start-badge">Start paragraph: --</span>
      <span id="secondary-count-badge" class="start-badge">Secondary paragraphs: --</span>
      <span id="range-badge" class="start-badge">Range: --</span>
      <span id="primary-docx-path" class="path-badge">Primary DOCX: --</span>
      <span id="error" class="error"></span>
    </section>

    <section class="tab-panel active" id="panel-primary">
      <p class="muted">Click a paragraph to set the comparison starting point.</p>
      <div id="primary-paragraphs" class="paragraph-list"></div>
    </section>

    <section class="tab-panel" id="panel-secondary">
      <label for="secondary-input">Secondary text</label>
      <textarea id="secondary-input" class="secondary-input" spellcheck="false"></textarea>
      <div id="secondary-sync-status" class="sync-status">Synced</div>
      <div class="controls inline-controls">
        <button id="apply-secondary-btn" type="button">Apply Secondary Text</button>
      </div>
    </section>

    <section class="tab-panel" id="panel-compare">
      <div class="diff-controls">
        <span class="diff-controls-label">Diff mode</span>
        <div class="diff-mode-toggle" role="group" aria-label="Diff mode switch">
          <button type="button" class="diff-mode-btn active" data-diff-mode="word">Word</button>
          <button type="button" class="diff-mode-btn" data-diff-mode="hybrid">Word + char detail</button>
          <button type="button" class="diff-mode-btn" data-diff-mode="char">Character</button>
        </div>
      </div>
      <div id="diff-wrap" class="diff-inline"></div>
    </section>
  </main>

  <script>
    window.__JOB_ID__ = ${JSON.stringify(jobId)};
    window.__POLL_MS__ = ${JSON.stringify(pollFallbackMs)};
  </script>
  <script src="/job.js"></script>
</body>
</html>`;
}

async function createApp() {
  const config = loadConfig();
  const app = express();
  const manager = new JobManager(config);
  await manager.init();

  app.use(express.json({ limit: "10mb" }));
  app.use(express.static(path.resolve(process.cwd(), "public")));

  app.get("/", (req, res) => {
    res.send(renderHomePage(manager.getJobList()));
  });

  app.get("/help", (req, res) => {
    res.send(renderHelpPage());
  });

  app.get("/job/:id", (req, res) => {
    const job = manager.getJob(req.params.id);
    if (!job) {
      res.status(404).send("Unknown job id");
      return;
    }
    res.send(renderJobPage(req.params.id, config.pollFallbackMs));
  });

  app.get("/api/job/:id/status", (req, res) => {
    const job = manager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Unknown job id" });
      return;
    }

    res.json({
      id: job.id,
      name: job.name,
      status: job.status,
      error: job.error,
      updatedAt: job.updatedAt,
    });
  });

  app.get("/api/job/:id/effective-config", (req, res) => {
    const job = manager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Unknown job id" });
      return;
    }

    res.json({
      id: job.id,
      name: job.name,
      config: job.config,
    });
  });

  app.get("/api/effective-config", (req, res) => {
    const jobs = manager.getJobList().map((item) => {
      const job = manager.getJob(item.id);
      return {
        id: item.id,
        name: item.name,
        config: job ? job.config : null,
      };
    });

    res.json({ jobs });
  });

  app.get("/api/job/:id/diff", (req, res) => {
    const job = manager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Unknown job id" });
      return;
    }

    res.json({
      id: job.id,
      name: job.name,
      status: job.status,
      error: job.error,
      updatedAt: job.updatedAt,
      diff: {
        inlineHtml: job.diff.inlineHtml,
        sideBySide: job.diff.sideBySide,
        changes: job.diff.changes,
        primaryLength: job.diff.primaryLength,
        secondaryLength: job.diff.secondaryLength,
      },
    });
  });

  app.get("/api/job/:id/editor-state", (req, res) => {
    const state = manager.getEditorState(req.params.id);
    if (!state) {
      res.status(404).json({ error: "Unknown job id" });
      return;
    }
    res.json(state);
  });

  app.post("/api/job/:id/start", async (req, res) => {
    const job = manager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Unknown job id" });
      return;
    }

    try {
      await manager.setStartParagraph(req.params.id, req.body.startParagraph);
      res.json({ ok: true, state: manager.getEditorState(req.params.id) });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to set start paragraph" });
    }
  });

  app.post("/api/job/:id/secondary", async (req, res) => {
    const job = manager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Unknown job id" });
      return;
    }

    try {
      await manager.setSecondaryText(req.params.id, req.body.secondaryText);
      res.json({ ok: true, state: manager.getEditorState(req.params.id) });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to set secondary text" });
    }
  });

  app.post("/api/job/:id/window-extra", async (req, res) => {
    const job = manager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Unknown job id" });
      return;
    }

    try {
      await manager.setWindowExtra(req.params.id, req.body.windowExtra);
      res.json({ ok: true, state: manager.getEditorState(req.params.id) });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to set window extra" });
    }
  });

  app.post("/api/job/:id/diff-mode", async (req, res) => {
    const job = manager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Unknown job id" });
      return;
    }

    try {
      await manager.setDiffMode(req.params.id, req.body.diffMode);
      res.json({ ok: true, state: manager.getEditorState(req.params.id) });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to set diff mode" });
    }
  });

  app.post("/api/job/:id/compare", async (req, res) => {
    const job = manager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Unknown job id" });
      return;
    }

    try {
      await manager.runCompare(req.params.id, req.body || {});
      res.json({ ok: true, state: manager.getEditorState(req.params.id) });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to compare" });
    }
  });

  app.post("/api/job/:id/refresh", async (req, res) => {
    const job = manager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Unknown job id" });
      return;
    }

    try {
      await manager.forceRefresh(req.params.id, "api-manual-refresh");
      const updatedJob = manager.getJob(req.params.id);
      res.json({
        ok: true,
        id: updatedJob.id,
        status: updatedJob.status,
        updatedAt: updatedJob.updatedAt,
        error: updatedJob.error,
      });
    } catch (error) {
      res.status(500).json({ error: error.message || "Refresh failed" });
    }
  });

  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({ type: "connected", at: new Date().toISOString() });
    const unsubscribe = manager.onUpdate(send);

    req.on("close", () => {
      unsubscribe();
    });
  });

  return { app, config };
}

module.exports = {
  createApp,
};
