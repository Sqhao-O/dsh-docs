# Optional embedded Python runtime

`worker.py` is the bytes-only bridge for a packaged CPython + Xberg runtime.
It exists so a DSH installation can ship a fixed Python/OCR runtime without
requiring a user-wide Python installation, a localhost HTTP service, or a
remote document converter.

It is deliberately source-only in this repository.  A normal npm package must
not contain a CPython distribution, native DLLs, OCR language data, or model
weights: those are platform-specific and can be hundreds of megabytes.  Ship
them in a separately versioned platform runtime artifact, for example
`dshdoc-runtime-win32-x64`, with this layout:

```text
runtime-win32-x64/
  python/python.exe
  python/Lib/site-packages/xberg/
  python/worker.py
  ocr/tessdata/eng.traineddata
  ocr/tessdata/chi_sim.traineddata
  manifest.json                 # files, versions, SHA-256 values, licenses
  NOTICE
  SBOM.spdx.json
```

The current `win32-x64.txt` is deliberately hash-pinned to the exact Xberg
wheel verified for the Windows x64 artifact.  An installer must install from a
vetted local wheelhouse with `--require-hashes`; it must never fetch Python
packages or model weights on first document conversion.

The runtime launcher must set `DSH_DOC_TESSDATA_PATH` to the packaged
`ocr/tessdata` directory.  The worker checks every requested
`<language>.traineddata` file before invoking Xberg and returns
`ENGINE_OCR_UNAVAILABLE` if a pack is absent.  This intentionally prevents
Xberg's developer-oriented automatic language-pack download.  Version 1
exposes only bundled Tesseract; Paddle/Candle are not enabled until their model
assets have the same pinned, offline artifact treatment.

## Stdio protocol

The parent sends one UTF-8 JSON object per line and receives one response per
line. Only `document.bytes_base64`, `document.media_type`, `document.name`,
and its asserted size are accepted for conversion. The worker rejects path
separators, paths, URIs, and URLs by construction. It has no file-read, URL
fetch, or cache input API.

```json
{"protocol":"dsh-document-engine/v1","id":"health-1","operation":"health"}
```

```json
{
  "protocol":"dsh-document-engine/v1",
  "id":"convert-1",
  "operation":"convert",
  "document":{"bytes_base64":"...","media_type":"application/pdf","name":"report.pdf","size":123},
  "options":{"output_format":"md","ocr":true,"ocr_languages":["eng","chi_sim"],"ocr_backend":"tesseract","timeout_ms":120000,"max_output_chars":32000}
}
```

Responses are either `{"protocol":"dsh-document-engine/v1","id":...,"ok":true,"result":...}` or a generic,
engine-neutral error such as
`{"id":...,"ok":false,"error":{"code":"ENGINE_CONVERSION_FAILED"}}`.
Parser tracebacks and document data are never reflected in error responses.

`DSH_DOC_WORKER_MAX_INPUT_BYTES` and
`DSH_DOC_WORKER_MAX_TIMEOUT_MS` are optional hard ceilings supplied by the
parent runtime.  The parent must still enforce its own limits before base64
encoding, because the worker cannot undo memory already consumed by a wire
line. `max_output_chars` is also supplied by the parent: the worker truncates
before serializing stdout and returns original/returned character statistics,
so a large document cannot overflow the stdio response cap before the normal
Tool Result limiter runs.
