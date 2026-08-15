# Changelog

## Unreleased

- Replace the PowerShell-only runtime build/verify scripts with plain Node.js
  scripts (`scripts/*.mjs`) that run identically from cmd, PowerShell, pwsh,
  and Git Bash; drop the pwsh 7 prerequisite from the docs and CI.
- Add `scripts/fetch-runtime-win32-x64.mjs`, which downloads the prebuilt
  Windows x64 runtime from the pinned GitHub Release asset (archive SHA-256
  pinned in source) and verifies every extracted file against the manifest.
- Publish the package to the npm registry so `dsh plugin --profile web add
  dsh-doc` installs prebuilt code without git, pnpm, or a local build.
- BREAKING: Rename the package and plugin id to `dsh-doc`, the tools to
  `dshdoc_*`, the error types to `DshdocError`/`DshdocErrorCode` with
  `DSHDOC_*` codes, and the worker environment variables to `DSH_DOC_*`
  (from the initial `dsh-docling` / `docling_*` / `DSH_DOCLING_*` release).
- Authorize the session workspace (session cwd) implicitly for local reads so
  any project folder works without profile edits; `allowedLocalRoots` now only
  adds extra persistent roots, and `allowWorkspaceFiles: false` restores the
  strict allowlist-only behavior.
- Replace the Docling Serve HTTP transport with local Xberg parsing.
- Add native Node and optional embedded-Python stdio engines.
- Add a pinned Windows x64 runtime builder with offline Tesseract data.
- Restrict the plugin engine boundary to authorized local-file byte snapshots.
- Disable remote URL conversion rather than forwarding URLs to a parser.
- Make the embedded Python/Tesseract runtime the documented complete OCR path;
  Node OCR now requires explicit local tessdata and never downloads models.
- Disable both extraction and Tesseract-specific document-result caches.
- Preserve local engine errors through DSH ToolRuntime and expose offline OCR
  readiness/languages through `dshdoc_health`.
- Verify the opened file descriptor identity after authorization to close
  replacement races before taking a byte snapshot.
- Add real generated PDF, OOXML, image OCR, DSH ToolRuntime, and AgentLoop
  context-injection tests.

## 0.1.0

- Initial release
- Docling Serve health check
- Local document conversion
- Remote URL conversion
- OCR and table options
- Local path sandbox
- SSRF protection
- Bounded tool output
