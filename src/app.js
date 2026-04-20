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
    <h1>Manuscript Diff Monitor</h1>
    <p>Choose a configured job.</p>
    <ul class="job-list">${listItems}</ul>
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
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main class="layout">
    <p><a href="/">Back to jobs</a></p>
    <h1 id="job-title">${jobId}</h1>

    <section class="meta-row">
      <span id="status" class="status">STARTING</span>
      <span id="updated-at">Last update: --</span>
      <span id="error" class="error"></span>
    </section>

    <section class="controls">
      <button id="refresh-btn" type="button">Refresh</button>
      <button id="toggle-btn" type="button">Toggle inline/side-by-side</button>
    </section>

    <section id="diff-wrap" class="diff-inline"></section>
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

  app.use(express.static(path.resolve(process.cwd(), "public")));

  app.get("/", (req, res) => {
    res.send(renderHomePage(manager.getJobList()));
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
