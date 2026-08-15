# Architecture

## Runtime flow

```text
DeepSeek Harness ToolRuntime
        |
        +-- dshdoc_extract / dshdoc_convert_file
                 |
                 +-- realpath allowlist + file descriptor snapshot
                         |
                         +-- DocumentEngine
                              |-- Xberg Python worker over stdio (bundled OCR runtime)
                              `-- Xberg Node N-API (non-OCR fallback or explicit local tessdata)
                                      |
                                      `-- bounded canonical Tool Result
                                              |
                                              `-- next model context
```

The plugin has no Docling HTTP client, no listener, no URL downloader, no
container lifecycle, and no dependency on a remote parser service.

## Module boundaries

- `src/security/local-path.ts` authorizes real paths, opens the regular file,
  compares the opened descriptor identity to the post-open path, and returns a
  byte snapshot. Parser implementations do not receive its path.
- `src/engine/types.ts` is the engine-neutral bytes-only contract.
- `src/engine/xberg-node-client.ts` uses Xberg's native Node binding and only
  enables OCR with explicit pinned local Tesseract bytes.
- `src/engine/python-stdio-client.ts` sends a versioned, size-bounded JSON
  request to an isolated Python worker with `shell: false`.
- `python/worker.py` accepts bytes, display metadata, and options only. Its
  packaged runtime checks the explicit Tesseract data directory, runs offline,
  and disables OCR-result caching.
- `src/tools` owns DSH schemas, safe errors, and Tool Result rendering.
- `src/output` limits the exact text representation supplied to the model.

## Input and network boundary

The supported source boundary is an allowlisted local file. The compatibility
URL tool returns a stable `UNSUPPORTED_URL` error. This is deliberate: passing
a once-validated URL to Xberg or a Python worker would allow downstream DNS
rebinding or redirects to bypass the plugin's authorization boundary.

## Python runtime artifact

The normal npm package remains small. `scripts/build-runtime-win32-x64.ps1`
creates a separately deployable Windows x64 runtime under `.dsh-runtime/` with
pinned CPython, Xberg, `eng`, and `chi_sim` data. The artifact holds a manifest,
hashes, notices, and an SPDX inventory. See [runtime-win32-x64.md](runtime-win32-x64.md).
