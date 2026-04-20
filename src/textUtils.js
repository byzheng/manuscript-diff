const { diffWordsWithSpace } = require("diff");

function normaliseQuotes(text) {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2032\u2033]/g, '"');
}

function collapseWhitespaceKeepNewlines(text) {
  return text
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function stripTrailingSpaces(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
}

function unwrapWrappedLines(text) {
  return text
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0)
    .join("\n\n");
}

function applyNormalisation(input, options) {
  let output = input.replace(/\r\n/g, "\n");

  if (options.normaliseQuotes) {
    output = normaliseQuotes(output);
  }

  if (options.stripTrailingSpaces) {
    output = stripTrailingSpaces(output);
  }

  if (options.unwrapLines) {
    output = unwrapWrappedLines(output);
  }

  if (options.collapseWhitespace) {
    output = collapseWhitespaceKeepNewlines(output);
  }

  return output;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineDiff(parts) {
  return parts
    .map((part) => {
      const safe = escapeHtml(part.value);
      // Primary is the working version: words only in primary are "insertions"
      // and words only in secondary are "deletions" from the primary perspective.
      if (part.added) {
        return `<span class=\"del\">${safe}</span>`;
      }

      if (part.removed) {
        return `<span class=\"ins\">${safe}</span>`;
      }

      return `<span>${safe}</span>`;
    })
    .join("");
}

function renderSideBySide(parts) {
  let left = "";
  let right = "";

  for (const part of parts) {
    const safe = escapeHtml(part.value);
    if (part.added) {
      right += `<span class=\"del\">${safe}</span>`;
      continue;
    }

    if (part.removed) {
      left += `<span class=\"ins\">${safe}</span>`;
      continue;
    }

    left += `<span>${safe}</span>`;
    right += `<span>${safe}</span>`;
  }

  return { left, right };
}

function splitParagraphs(text) {
  return text
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function diffScore(parts) {
  return parts.reduce((total, part) => {
    if (part.added || part.removed) {
      return total + part.value.length;
    }
    return total;
  }, 0);
}

function tokeniseForSimilarity(paragraph) {
  return paragraph
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function paragraphSimilarity(a, b) {
  const aTokens = tokeniseForSimilarity(a);
  const bTokens = tokeniseForSimilarity(b);

  if (aTokens.length === 0 || bTokens.length === 0) {
    return 0;
  }

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let common = 0;

  for (const token of aSet) {
    if (bSet.has(token)) {
      common += 1;
    }
  }

  return (2 * common) / (aSet.size + bSet.size);
}

function findBestParagraphAlignment(primaryParagraphs, secondaryParagraphs) {
  const n = primaryParagraphs.length;
  const m = secondaryParagraphs.length;

  if (n === 0 || m === 0) {
    return null;
  }

  const gapPenalty = 0.35;
  const scores = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const trace = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  let best = { score: 0, i: 0, j: 0 };

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sim = paragraphSimilarity(primaryParagraphs[i - 1], secondaryParagraphs[j - 1]);
      const diagonal = scores[i - 1][j - 1] + sim;
      const up = scores[i - 1][j] - gapPenalty;
      const left = scores[i][j - 1] - gapPenalty;

      let direction = 0;
      let value = 0;

      if (diagonal >= up && diagonal >= left && diagonal > 0) {
        value = diagonal;
        direction = 1;
      } else if (up >= left && up > 0) {
        value = up;
        direction = 2;
      } else if (left > 0) {
        value = left;
        direction = 3;
      }

      scores[i][j] = value;
      trace[i][j] = direction;

      if (value > best.score) {
        best = { score: value, i, j };
      }
    }
  }

  if (best.score <= 0) {
    return null;
  }

  const matchedPairs = [];
  let i = best.i;
  let j = best.j;

  while (i > 0 && j > 0 && scores[i][j] > 0) {
    const direction = trace[i][j];
    if (direction === 1) {
      matchedPairs.push({ i: i - 1, j: j - 1 });
      i -= 1;
      j -= 1;
    } else if (direction === 2) {
      i -= 1;
    } else if (direction === 3) {
      j -= 1;
    } else {
      break;
    }
  }

  if (matchedPairs.length === 0) {
    return null;
  }

  matchedPairs.reverse();

  const startParagraph = matchedPairs[0].i;
  const endParagraph = matchedPairs[matchedPairs.length - 1].i;
  const coverage = matchedPairs.length / secondaryParagraphs.length;

  return {
    startParagraph,
    endParagraph,
    matchedPairs: matchedPairs.length,
    coverage,
    score: best.score,
  };
}

function choosePrimarySegment(normalisedPrimary, normalisedSecondary, compareMode) {
  if (compareMode !== "subset") {
    return {
      selectedPrimary: normalisedPrimary,
      alignment: {
        mode: "full",
        matched: false,
      },
    };
  }

  const primaryParagraphs = splitParagraphs(normalisedPrimary);
  const secondaryParagraphs = splitParagraphs(normalisedSecondary);

  if (primaryParagraphs.length === 0 || secondaryParagraphs.length === 0) {
    return {
      selectedPrimary: normalisedPrimary,
      alignment: {
        mode: "subset",
        matched: false,
      },
    };
  }

  const best = findBestParagraphAlignment(primaryParagraphs, secondaryParagraphs);
  if (!best) {
    return {
      selectedPrimary: normalisedPrimary,
      alignment: {
        mode: "subset",
        matched: false,
      },
    };
  }

  const text = primaryParagraphs.slice(best.startParagraph, best.endParagraph + 1).join("\n\n");

  return {
    selectedPrimary: text,
    alignment: {
      mode: "subset",
      matched: true,
      startParagraph: best.startParagraph,
      endParagraph: best.endParagraph,
      matchedPairs: best.matchedPairs,
      coverage: best.coverage,
      score: best.score,
      method: "paragraph-local-alignment",
    },
  };
}

function buildDiff(primaryText, secondaryText, options) {
  const normaliseOptions = options.normalise || {};
  const compareMode = options.compareMode || "full";
  const normalisedPrimary = applyNormalisation(primaryText, normaliseOptions);
  const normalisedSecondary = applyNormalisation(secondaryText, normaliseOptions);

  const { selectedPrimary, alignment } = choosePrimarySegment(normalisedPrimary, normalisedSecondary, compareMode);
  const parts = diffWordsWithSpace(selectedPrimary, normalisedSecondary);

  const inlineHtml = renderInlineDiff(parts);
  const sideBySide = renderSideBySide(parts);
  const changes = parts.filter((part) => part.added || part.removed).length;

  return {
    inlineHtml,
    sideBySide,
    changes,
    primaryLength: selectedPrimary.length,
    secondaryLength: normalisedSecondary.length,
    alignment,
  };
}

module.exports = {
  normaliseText: applyNormalisation,
  buildDiff,
};
