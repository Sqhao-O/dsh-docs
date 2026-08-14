# dsh-docling

[中文](README.zh-CN.md) | [Installation prompt](INSTALL.md)

`dsh-docling` is a local document engine for DeepSeek Harness. It no longer
starts, calls, or requires Docling Serve, Docker, a localhost HTTP port, or a
remote document-conversion service. The package name and existing
`docling_*` tool names are retained for profile compatibility.

For complete PDF/Office/OCR use, it ships a pinned, embedded Python + Xberg
runtime recipe with offline Windows Tesseract language data. The native
[Xberg](https://github.com/xberg-io/xberg) Node binding remains a small local
fallback for non-OCR parsing; it never downloads OCR models.

## Supported and tested inputs

- PDF, DOCX, XLSX, PPTX, Markdown, HTML, CSV, and text
- PNG, JPEG, TIFF, WebP, and scanned PDFs through local OCR
- Markdown, plain text, or JSON-shaped Tool Results

The integration suite generates binary documents outside the repository and
verifies PDF, DOCX, XLSX, PPTX, PNG OCR, and scanned-PDF OCR. Test any other
Xberg-supported input against your own corpus before enabling it in production.

## Quick start with `dsh web`

Build the offline Python runtime first:

```powershell
pwsh -File ./scripts/build-runtime-win32-x64.ps1
```

Then install the local plugin into the `web` profile:

```powershell
dsh plugin --profile web add D:/Dev/Projects/dsh-docling
```

Add a narrow absolute allowlist to the web profile's `cordis.patch.yml`:

```yaml
- id: dsh-docling
  config:
    engine: python
    runtimeDir: D:/Dev/Projects/dsh-docling/.dsh-runtime/runtime-win32-x64
    allowedLocalRoots:
      - D:/Dev/Projects/my-workspace
    maxFileBytes: 52428800
    maxOutputChars: 32000
    # Safe here because the configured runtime carries the local language packs.
    defaultOcr: true
    defaultTableMode: accurate
    defaultOutputFormat: md
```

Restart `dsh web`, then ask it to read a local document:

```text
Read ./reports/annual-report.pdf and give me the three main risks.
Extract the tables from ./financials.xlsx.
Read the text from ./scanned-invoice.png.
```

Only paths below `allowedLocalRoots` are readable. Relative paths resolve
against the DSH session workspace, not the directory from which `dsh web` was
started.

## Offline embedded Python runtime (Windows x64)

Build the separate runtime artifact:

```powershell
pwsh -File ./scripts/build-runtime-win32-x64.ps1
```

This creates a gitignored `.dsh-runtime/runtime-win32-x64` directory containing
CPython 3.11.9, `xberg==1.0.14`, and pinned `eng` / `chi_sim` Tesseract data.
Every downloaded file is SHA-256 validated; the artifact contains a manifest,
NOTICE, and SPDX inventory. It does not alter a global Python installation.
Run `pwsh -File ./scripts/verify-runtime-win32-x64.ps1` before pointing a
profile at a copied runtime artifact.

Point the plugin at the runtime:

```yaml
- id: dsh-docling
  config:
    engine: python
    runtimeDir: D:/Dev/Projects/dsh-docling/.dsh-runtime/runtime-win32-x64
    allowedLocalRoots:
      - D:/Dev/Projects/my-workspace
```

The Python worker receives only a byte snapshot, display name, MIME type, and
conversion options over stdio. It never receives a user path or URL. It runs
offline, refuses missing OCR language packs, and disables document-derived OCR
caching. `docling_health` reports the available OCR languages. See [the runtime
guide](docs/runtime-win32-x64.md).

### Node-only fallback

Set `engine: node` only when you need PDF/Office/text parsing without the
embedded Python runtime. Its `defaultOcr` is `false`. To enable Node OCR, set
`tessdataPath` to a reviewed local directory containing every requested
`<language>.traineddata` pack; missing data returns `ENGINE_OCR_UNAVAILABLE`
instead of downloading a model. The Python runtime above is the supported
complete offline OCR path.

## Tools

| Tool | Purpose |
| --- | --- |
| `docling_health` | Report readiness of the selected local engine. |
| `docling_convert_file` | Parse an allowlisted local file. |
| `docling_extract` | Preferred local-file convenience tool. |
| `docling_convert_url` | Compatibility stub that returns `UNSUPPORTED_URL`. |

HTTP(S) input is detected only to reject it safely. Download a remote document
through a reviewed workflow into an allowed local root, then parse that file.
The plugin never forwards a URL to Xberg or Python, avoiding redirect and
DNS-rebinding risks.

`page_range` uses inclusive, one-based page numbers for Markdown and plain-text
results. JSON output deliberately retains the complete structured document.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `engine` | `auto` | `node`, `python`, or `auto`; auto selects configured embedded Python, otherwise Node Xberg. |
| `runtimeDir` | unset | Absolute embedded-runtime directory. |
| `pythonCommand` | unset | Trusted Python executable for a managed runtime. |
| `pythonWorkerPath` | shipped worker | Absolute Python worker override. |
| `tessdataPath` | runtime `ocr/tessdata` | Absolute bundled Tesseract language-data directory. |
| `ocrBackend` | `auto` | `auto` or `tesseract`; both select the pinned local Tesseract backend. |
| `ocrLanguages` | `[eng]` | Ordered local OCR language packs. |
| `timeoutMs` | `120000` | Per-conversion deadline. |
| `maxFileBytes` | `52428800` | Authorized input-size cap. |
| `allowedLocalRoots` | `[]` | Absolute non-root directories the model may read. |
| `defaultOcr` | `false` | OCR default for images and scans; enable it only with a configured local tessdata runtime. |
| `defaultTableMode` | `accurate` | `fast` or `accurate` PDF table behavior. |
| `defaultOutputFormat` | `md` | `md`, `text`, or `json`. |
| `maxOutputChars` | `32000` | Maximum result returned to the model. |
| `debug` | `false` | Logs safe engine metadata only. |

Older `baseUrl`, `apiKey`, `enableRemoteUrls`, and `allowPrivateUrls` profile
fields are accepted only for migration; they do not enable a remote engine.

## Security model

- Paths are realpathed and checked against every configured root. Traversal,
  symlink escapes, filesystem roots, non-files, and oversized inputs fail.
- The authorized descriptor is read once into a snapshot before parsing, so a
  later path replacement cannot change the parsed bytes.
- The Node and Python engines accept bytes only. The plugin creates no listener,
  URL fetcher, container, or external parser service.
- OCR is Tesseract-only in this release. All requested language packs are read
  from the configured local artifact; missing packs fail closed rather than
  triggering a model download.
- The descriptor opened for parsing must have the same device/inode identity as
  the post-open allowlisted path, blocking file replacement between authorization
  and the byte snapshot.
- Results are bounded before becoming Tool Results. JSON is limited using the
  same pretty representation shown to the model.

## Development

```powershell
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination .pack
```

Tests create temporary documents only. They cover native Xberg, the Python
stdio worker, local OCR data, Cordis ToolRuntime, and local DSH AgentLoop
context injection.

## Licenses

This project is MIT. Xberg 1.0.14 is MIT. The optional Windows runtime contains
CPython (PSF-2.0) and `tessdata_fast` language data (Apache-2.0), with exact
sources, hashes, and notices recorded in its generated artifact.
