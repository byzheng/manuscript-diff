const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

function runPandoc({ pandocPath, inputPath, extraArgs }) {
  return new Promise((resolve, reject) => {
    const args = [inputPath, ...(extraArgs || [])];
    const child = spawn(pandocPath, args, {
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(new Error(`Pandoc process error: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Pandoc failed with code ${code}: ${stderr || "unknown error"}`));
        return;
      }

      resolve(stdout);
    });
  });
}

function makeTempDocxPath(inputPath) {
  const stamp = Date.now();
  const hash = crypto.createHash("md5").update(inputPath).digest("hex").slice(0, 8);
  const baseName = path.basename(inputPath, path.extname(inputPath));
  return path.join(os.tmpdir(), `manuscript-diff-${baseName}-${hash}-${stamp}.docx`);
}

async function convertDocxToText({ pandocPath, inputPath, extraArgs }) {
  try {
    return await runPandoc({ pandocPath, inputPath, extraArgs });
  } catch (error) {
    const message = String(error && error.message ? error.message : "").toLowerCase();
    const isPermissionError = message.includes("permission denied");

    if (!isPermissionError) {
      throw error;
    }

    const tempPath = makeTempDocxPath(inputPath);

    try {
      // Some synced/virtualized folders can block pandoc direct file access.
      // Copying to a local temp file avoids this for many OneDrive-style paths.
      fs.copyFileSync(inputPath, tempPath);
      return await runPandoc({ pandocPath, inputPath: tempPath, extraArgs });
    } catch (fallbackError) {
      throw new Error(
        `Pandoc direct read failed with permission denied and temp-copy fallback failed: ${fallbackError.message}`
      );
    } finally {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }
}

module.exports = {
  convertDocxToText,
};
