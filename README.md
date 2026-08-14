# 📄 dsh-docling

[English](README.md) | [中文](README.zh-CN.md)

**Native document intelligence for DeepSeek Harness.**
**Powered by Docling.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF)](.github/workflows/ci.yml)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b6bfb)](https://github.com/deepseek-ai/deepseek-harness)
[![Docling](https://img.shields.io/badge/Docling-Serve-0b7a75)](https://github.com/docling-project/docling-serve)
[![npm](https://img.shields.io/npm/v/dsh-docling)](https://www.npmjs.com/package/dsh-docling)

Give DeepSeek Harness the ability to understand documents.

**PDF · DOCX · PPTX · XLSX · HTML · Markdown · CSV · Images**

Turn PDFs, Office documents and scanned files into structured context DeepSeek
Harness can reason over.

## Install in one message

### Hand this to your DSH agent

> Install and configure dsh-docling for this DSH profile by following [INSTALL.md](https://github.com/Sqhao-O/dsh-docling/blob/main/INSTALL.md). Allow only the current workspace as a local document root; use my existing Docling Serve endpoint, ask me only if its URL or API key is missing, do not download or start Docling or any container image, then verify the generated DSH configuration and report the result.

The guide is written for a DSH agent and is safe to repeat. It installs only
this DSH plugin; Docling Serve remains an operator-managed service. Once the
agent confirms the profile is configured, restart DSH and say: `Check Docling
health.`

<details>
<summary>Manual installation</summary>

See the full manual steps in [Quick start](#quick-start).

</details>

## Features

- PDF, DOCX, PPTX, XLSX, HTML, Markdown, CSV, and image/scanned documents
- Docling OCR and table extraction controls
- Local files protected by a realpath-based allowlist sandbox
- HTTP/HTTPS document URLs with DNS-aware SSRF protection
- Native DSH Tool Results with structured canonical values and readable renders
- Configurable file-size, timeout, and output-size limits
- No Python runtime, models, OCR, or parser bundled in this plugin

## Architecture

```text
Document
   ↓
dsh-docling (TypeScript)
   ↓ HTTP
Docling Serve
   ↓
structured Markdown / text / JSON + metadata
   ↓
DeepSeek Harness
   ↓
LLM reasoning
```

## Quick start

### 1. Start Docling Serve

Install and run it with Python:

```bash
pip install "docling-serve[ui]"
docling-serve run
```

Or use the upstream container image:

```bash
podman run -p 5001:5001 quay.io/docling-project/docling-serve
# Docker may be used in place of Podman.
```

The plugin only needs a reachable HTTP endpoint; it never installs Python or
downloads models.

### 2. Install the bundle manually

The commands below target the `web` profile used by `dsh web`. If you use a
different DSH surface, replace `web` with that active profile name.

From npm:

```bash
dsh plugin --profile web add dsh-docling
```

Or directly from GitHub (pin a commit in production):

```bash
dsh plugin --profile web add git+https://github.com/Sqhao-O/dsh-docling.git#main
```

This explicit HTTPS Git URL avoids requiring GitHub SSH access. Git installs
build TypeScript through `prepare`. With pnpm 10+, DSH may ask you to allow
that trusted build in the profile's `pnpm-workspace.yaml`. Pin a commit instead
of `#main` for production deployments.

### 3. Configure document access

The bundle adds its own `dsh-docling` row. Add or override it in the profile's
`cordis.patch.yml`; use absolute, non-filesystem-root directories.

```yaml
- id: dsh-docling
  config:
    baseUrl: http://127.0.0.1:5001
    # apiKey: set-this-only-if-DOCLING_SERVE_API_KEY-is-configured
    allowedLocalRoots:
      - C:/work/my-project
    maxFileBytes: 52428800
    maxOutputChars: 32000
    defaultOcr: true
    defaultTableMode: accurate
    defaultOutputFormat: md
```

Verify the generated layer without starting a surface:

```bash
dsh --profile web --dump-config
```

### 4. Ask Harness to read a document

```text
Read ./docs/report.pdf and summarize the key risks.

Analyze this annual report:
https://example.com/report.pdf

Extract the tables from ./financials.xlsx.
```

The model should normally choose `docling_extract`; it selects a file or URL
from the source automatically.

## Tools

| Tool | Purpose | Main parameters |
| --- | --- | --- |
| `docling_health` | Verify the configured service is reachable. | none |
| `docling_convert_file` | Convert an allowed local document. Best for PDF, Word, PowerPoint, Excel, and scans. | `path`, `output_format?`, `ocr?`, `table_mode?`, `page_range?` |
| `docling_convert_url` | Convert a public document URL. | `url`, `output_format?`, `ocr?`, `table_mode?`, `page_range?` |
| `docling_extract` | Preferred convenience tool; detects local file vs HTTP(S) URL. | `source`, `source_type?`, `ocr?`, `table_mode?`, `page_range?` |

`output_format` is `md`, `text`, or `json`. `page_range` is an inclusive
`[start, end]` pair with page numbers starting at 1.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:5001` | Docling Serve base URL; HTTP(S) only. |
| `apiKey` | unset | Sent as the upstream `X-Api-Key` header. |
| `timeoutMs` | `120000` | Per-request HTTP deadline. |
| `maxFileBytes` | `52428800` | File size cap before upload (50 MiB). |
| `enableLocalFiles` | `true` | Enable path sources, still subject to `allowedLocalRoots`. |
| `enableRemoteUrls` | `true` | Enable HTTP(S) URL sources. |
| `allowedLocalRoots` | `[]` | Explicit directories the model may read; empty denies all files. |
| `allowPrivateUrls` | `false` | Allow localhost/private URL targets. Use only in controlled deployments. |
| `defaultOcr` | `true` | Default Docling OCR setting. |
| `defaultTableMode` | `accurate` | `fast` or `accurate` table extraction. |
| `defaultOutputFormat` | `md` | `md`, `text`, or `json`. |
| `maxOutputChars` | `32000` | Maximum parsed content returned to the model. |
| `debug` | `false` | Log request metadata only; never logs API keys or document content. |

Invalid configuration fails while Cordis loads the plugin.

## Security

`dsh-docling` treats model-provided input as untrusted.

- Local paths are resolved, realpathed, and checked against each real allowed
  root. This blocks `..` traversal and symlink escapes. Filesystem roots such
  as `C:\` and `/` are rejected as configuration.
- Remote documents may use only `http:` or `https:`. Localhost, loopback,
  link-local, private LAN, shared-address, and other non-public addresses are
  rejected before Docling sees the URL; DNS results are checked too.
- Docling Serve performs the final download. Deploy it with outbound network
  controls that also block private networks and metadata services: a public URL
  can redirect or rebind after this plugin's preflight validation.
- Files are statted before upload. Oversized files are never sent.
- Output is bounded and reports truncation, original character count, and
  returned character count. The limiter favors Markdown section boundaries and
  never splits Unicode surrogate pairs.

The configured Docling Serve `baseUrl` is a separate, operator-controlled trust
boundary. It may safely be private; `allowPrivateUrls` controls only documents
that Docling is instructed to download.

## Development

Requires the Node versions supported by current DSH: Node `^22.19.0 || >=24`.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Tests include pure unit tests, an in-process HTTP mock integration suite, and a
real Cordis + DSH `ToolRuntime` registration lifecycle test. A real Docling
integration test is defined but runs only when a service is supplied:

```bash
DOCLING_BASE_URL=http://127.0.0.1:5001 pnpm test:integration
```

On PowerShell:

```powershell
$env:DOCLING_BASE_URL = 'http://127.0.0.1:5001'
pnpm test:integration
```

Before a release, inspect the exact npm artifact:

```bash
pnpm pack
tar -tf dsh-docling-0.1.0.tgz
```

## Roadmap

- [ ] Native generic Harness attachments when the upstream API is stable
- [ ] Document chunk navigation
- [ ] Opt-in document cache
- [ ] Image and table artifacts

## License and upstream projects

This project is MIT licensed. DeepSeek Harness and Docling are separate MIT
licensed upstream projects. `dsh-docling` is an independent community
integration; it does not bundle, fork, or modify either project.
