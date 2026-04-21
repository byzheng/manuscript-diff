const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.resolve(process.cwd(), "config", "config.json");

function asAbsolute(value) {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value === "string" && value.trim() === "") {
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

  const globalPandocArgs = Array.isArray(config.pandocArgs) && config.pandocArgs.length > 0 ? config.pandocArgs : ["-t", "plain"];
  const globalConversionMode = config.conversionMode || "mammoth";
  const globalCompareMode = config.compareMode || "full";
  const globalDiffMode = ["word", "hybrid", "char"].includes(config.diffMode) ? config.diffMode : "word";
  const globalWindowExtra = Number.isInteger(config.windowExtra) ? config.windowExtra : 0;
  const globalNormalise = {
    collapseWhitespace: true,
    normaliseQuotes: true,
    ignoreDashes: true,
    stripTrailingSpaces: true,
    unwrapLines: true,
    ...(config.normalise || {}),
  };

  const jobs = config.jobs.map((job) => {
    if (!job.id || !job.primaryDocx || !job.outputDir) {
      throw new Error(`Invalid job config: ${JSON.stringify(job)}`);
    }

    const secondaryTextValue = typeof job.secondaryText === "string" ? job.secondaryText.trim() : job.secondaryText;

    return {
      ...job,
      pandocArgs: Array.isArray(job.pandocArgs) && job.pandocArgs.length > 0 ? job.pandocArgs : globalPandocArgs,
      conversionMode: job.conversionMode || globalConversionMode,
      compareMode: job.compareMode || globalCompareMode,
      diffMode: ["word", "hybrid", "char"].includes(job.diffMode) ? job.diffMode : globalDiffMode,
      windowExtra: Number.isInteger(job.windowExtra) ? job.windowExtra : globalWindowExtra,
      primaryDocx: asAbsolute(job.primaryDocx),
      secondaryText: asAbsolute(secondaryTextValue),
      outputDir: asAbsolute(job.outputDir),
      normalise: {
        ...globalNormalise,
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
