# manuscript-diff

Local Node.js app for monitoring one or more DOCX manuscripts, converting each primary DOCX to text with pandoc, and showing a word-level diff against a secondary text file.

This is read-only: it visualizes changes only.

## Features

- Watches primary DOCX files and secondary text files with debounce.
- Ignores Word temp DOCX files matching `~$*.docx`.
- Converts DOCX to plain text via pandoc.
- Computes word-level diff using `diffWordsWithSpace` from `diff` (jsdiff).
- Preserves paragraph breaks (`white-space: pre-wrap` rendering).
- Provides inline and basic side-by-side diff views.
- Auto updates browser via SSE with polling fallback.
- Tabbed editor workflow per job:
  - Primary tab: converted primary text shown paragraph-by-paragraph; click a paragraph to set comparison start.
  - Secondary tab: editable secondary text input.
  - Compare tab: word-by-word diff output.

## Prerequisites

- Node.js 18+ recommended.
- pandoc installed and available in PATH (or set `pandocPath` in config).

## Install

```bash
npm install
```

## Configure

Edit `config/config.json`.

Important fields:

- `port`: web server port.
- `pandocPath`: command or full path to pandoc.
- `debounceMs`: delay after file-change bursts.
- `pollFallbackMs`: browser polling interval if SSE is unavailable.
- `jobs`: one or more comparison jobs.

Per job:

- `id`: unique id used in URL.
- `name`: display name.
- `primaryDocx`: absolute or repo-relative path to DOCX.
- `secondaryText`: path to plain text file.
- `outputDir`: where `primary.txt` and `diff.html` are written.
- `conversionMode`: `mammoth` (recommended for paragraph reliability) or `pandoc`.
- `compareMode`: `full` (default) or `subset`.
- `pandocArgs`: typically `["-t", "plain"]`.
- `normalise`: text normalisation toggles.

`conversionMode` details:

- `mammoth`: extracts DOCX text from paragraph structure in the document XML and is usually more reliable for paragraph boundaries.
- `pandoc`: uses pandoc text conversion. This can be preferable for some edge cases but may introduce wrapping/layout artifacts depending on source content.

`normalise` options:

- `collapseWhitespace`: collapse repeated spaces while preserving paragraph breaks.
- `normaliseQuotes`: convert smart quotes to straight quotes.
- `stripTrailingSpaces`: remove trailing spaces at line ends.
- `unwrapLines`: convert hard-wrapped single newlines inside a paragraph into spaces (useful for pandoc plain-text wrapping).

`compareMode` details:

- `full`: compares the full converted primary text against `secondaryText`.
- `subset`: treats `secondaryText` as an excerpt and finds the best matching paragraph window in primary text before computing the word diff. This reduces noisy deletions when entire leading/trailing paragraphs are absent in `secondaryText`.

## Run

Development with auto-restart:

```bash
npm run dev
```

Windows batch launcher (nodemon auto-reload):

```bat
dev-reload.bat
```

Normal run:

```bash
npm start
```

Open:

- `http://localhost:3000/` job list
- `http://localhost:3000/job/<job-id>` job page

## API

- `GET /` job list page
- `GET /job/:id` job page
- `GET /api/job/:id/status` status JSON
- `GET /api/job/:id/diff` diff JSON (inline + side-by-side HTML)
- `POST /api/job/:id/refresh` force immediate reconvert + rediff for one job
- `GET /events` SSE stream for updates

## Output files

For each job in `outputDir`:

- `primary.txt`: converted DOCX text
- `diff.html`: standalone diff HTML snapshot

## Security warning (external paths)

This tool can monitor files outside the project folder (for example `C:/...` or OneDrive locations). That is convenient, but keep these points in mind:

- The app will read any file path you configure in `config/config.json`; avoid pointing jobs at sensitive folders unrelated to your manuscript.
- Diff outputs (`primary.txt`, `diff.html`) may contain manuscript content, so keep `outputDir` in a private location.
- Keep the server local-only (`localhost`) and do not expose it to your local network unless you add authentication.
- Do not commit private absolute paths or generated manuscript outputs to shared/public repositories.
- If using synced/cloud folders, verify sharing permissions because external collaborators could potentially access those files.

## Troubleshooting

- If job status is `error` and mentions pandoc, verify pandoc installation:
  - Windows: install pandoc and ensure `pandoc` is on PATH.
  - macOS: `brew install pandoc`
  - Linux: install from package manager or pandoc release.
- If no updates appear, verify `primaryDocx` path and that you are editing the same file.
- Some editors save via replace/rename; watcher handles add/change events with debounce.
- Very large manuscripts may take noticeable time to convert/diff; status updates show progress.

## Notes for future improvements

- Add optional case-insensitive diff mode.
- Add jump-to-next-change navigation.
- Add ignore-rules for selected sections (for example references).
