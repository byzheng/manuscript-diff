const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.resolve(process.cwd(), "config", "config.json");

function asAbsolute(value) {
  if (!value) {
    return value;
  }

  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(process.cwd(), value);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config file at ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);

  if (!Array.isArray(config.jobs) || config.jobs.length === 0) {
    throw new Error("config.jobs must contain at least one job");
  }

  const jobs = config.jobs.map((job) => {
    if (!job.id || !job.primaryDocx || !job.secondaryText || !job.outputDir) {
      throw new Error(`Invalid job config: ${JSON.stringify(job)}`);
    }

    return {
      ...job,
      pandocArgs: Array.isArray(job.pandocArgs) && job.pandocArgs.length > 0 ? job.pandocArgs : ["-t", "plain"],
      conversionMode: job.conversionMode || "mammoth",
      compareMode: job.compareMode || "full",
      windowExtra: Number.isInteger(job.windowExtra) ? job.windowExtra : 0,
      primaryDocx: asAbsolute(job.primaryDocx),
      secondaryText: asAbsolute(job.secondaryText),
      outputDir: asAbsolute(job.outputDir),
      normalise: {
        collapseWhitespace: true,
        normaliseQuotes: true,
        stripTrailingSpaces: true,
        unwrapLines: true,
        ...(job.normalise || {}),
      },
    };
  });

  return {
    port: Number(config.port) || 3000,
    pandocPath: config.pandocPath || "pandoc",
    pollFallbackMs: Number(config.pollFallbackMs) || 2000,
    debounceMs: Number(config.debounceMs) || 500,
    jobs,
  };
}

module.exports = {
  CONFIG_PATH,
  loadConfig,
};
