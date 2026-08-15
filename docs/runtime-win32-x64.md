# Windows x64 offline runtime

`dsh-doc` keeps the Python/OCR engine out of the small npm package. Most users
download the prebuilt, hash-pinned artifact from the GitHub Release:

~~~text
node ./scripts/fetch-runtime-win32-x64.mjs
~~~

The archive SHA-256 is pinned inside the fetch script, and every extracted file
is verified against the bundled manifest before the runtime is usable. To audit
and rebuild the separately versioned artifact from source instead, run:

~~~text
node ./scripts/build-runtime-win32-x64.mjs
~~~

The artifact is written to .dsh-runtime\runtime-win32-x64, which is
intentionally ignored by Git. The builder refuses to overwrite an existing
output directory. This prevents a runtime binary, OCR model, generated cache,
or test sample from being added to the repository accidentally.

## What the build pins

- CPython embeddable 3.11.9 x64;
- the SHA-256-pinned xberg==1.0.14 wheel from
  [python/requirements/win32-x64.txt](../python/requirements/win32-x64.txt);
- eng and chi_sim from one pinned tessdata_fast revision; and
- complete SHA-256 file records, source URLs, license notices, a manifest.json,
  a top-level SPDX 2.3 artifact inventory, and Xberg's bundled CycloneDX
  component inventory.

The builder validates each hash before extracting anything. It also runs an
embedded-CPython Xberg OCR smoke test with Hugging Face offline mode enabled.
The build machine needs network access only to populate the vetted artifact;
the completed runtime does not.

## Running offline

Use run-worker.cmd in the generated artifact for manual testing. It sets:

~~~text
DSH_DOC_TESSDATA_PATH=<runtime>\ocr\tessdata
XBERG_CACHE_DIR=<runtime>\cache
HF_HUB_OFFLINE=1
HUGGINGFACE_HUB_OFFLINE=1
~~~

When launching python\python.exe directly from the plugin, pass the same
environment values. The worker must receive only the authorized byte snapshot
from the TypeScript layer; it must never be given an arbitrary source path or
URL.

The first artifact contains only bundled Tesseract data (eng, chi_sim).
Do not set a downloadable Paddle/Candle backend as the default. A higher-grade
model requires its own platform artifact, fixed source/version/hashes, license
notice, and an offline smoke test before it is exposed.

`dshdoc_health` reports `OCR: ready (eng, chi_sim)` only when the configured
runtime exposes all requested local language packs. Missing packs leave parser
health available but report OCR unavailable, and an OCR conversion fails closed
with `ENGINE_OCR_UNAVAILABLE`.

## Audit before distribution

~~~text
node ./scripts/verify-runtime-win32-x64.mjs .dsh-runtime/runtime-win32-x64
~~~

Inspect the manifest and component inventories in the generated artifact
(`manifest.json`, `sbom.spdx.json`, `sbom/xberg-py.cyclonedx.json`), and run
`run-worker.cmd` for a manual stdio check.

The verifier hashes every payload listed in `manifest.json` and rejects missing,
changed, or unexpected files. The top-level SPDX document covers the runtime
artifact; inspect the copied Xberg CycloneDX document for its native/Rust
component graph before distribution. Sign the final archive or publish its
manifest SHA-256 through your normal release channel when distributing outside
this local build workflow.

run-worker.cmd starts the worker on stdio. Send its documented health JSON
line, then terminate it with EOF. No listener or localhost HTTP service is
created.

~~~json
{"protocol":"dsh-document-engine/v1","id":"health-1","operation":"health"}
~~~
