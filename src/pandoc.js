const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const mammoth = require("mammoth");

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

async function runMammoth(inputPath) {
  const result = await mammoth.extractRawText({ path: inputPath });
  return String(result.value || "").replace(/\r\n/g, "\n");
}

function isPermissionError(error) {
  const message = String(error && error.message ? error.message : "").toLowerCase();
  return message.includes("permission denied") || message.includes("eacces");
}

async function withTempCopyOnPermission(inputPath, work) {
  try {
    return await work(inputPath);
  } catch (error) {
    if (!isPermissionError(error)) {
      throw error;
    }

    const tempPath = makeTempDocxPath(inputPath);
    try {
      fs.copyFileSync(inputPath, tempPath);
      return await work(tempPath);
    } finally {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }
}

async function convertDocxToText({ pandocPath, inputPath, extraArgs, conversionMode }) {
  const mode = conversionMode || "mammoth";

  if (mode === "pandoc") {
    return withTempCopyOnPermission(inputPath, (candidatePath) =>
      runPandoc({ pandocPath, inputPath: candidatePath, extraArgs })
    );
  }

  try {
    return await withTempCopyOnPermission(inputPath, (candidatePath) => runMammoth(candidatePath));
  } catch (mammothError) {
    // Fallback keeps the pipeline running for unusual DOCX constructs.
    return withTempCopyOnPermission(inputPath, (candidatePath) =>
      runPandoc({ pandocPath, inputPath: candidatePath, extraArgs })
    ).catch((pandocError) => {
      throw new Error(
        `DOCX conversion failed (mammoth then pandoc fallback). mammoth=${mammothError.message}; pandoc=${pandocError.message}`
      );
    });
  }
}

module.exports = {
  convertDocxToText,
};
