# Install dsh-doc with a DSH agent

No local checkout or build toolchain is needed. Paste this prompt into a
running DSH session (for example `dsh web`) in your own project folder — the
agent installs the published npm package, downloads the pinned offline OCR
runtime, and configures the plugin in one go. The only prerequisite is a
working `dsh` CLI on Node `^22.19` or `>= 24`; every runtime step is plain
Node.js, so any shell works: cmd, PowerShell, pwsh, or Git Bash.

```text
Install the dsh-doc plugin into my DSH web profile, end to end. Do every
step yourself in the terminal and verify the result.

1. Install the published plugin package:
   dsh plugin --profile web add dsh-doc
2. Windows x64 only — download the prebuilt offline OCR runtime. The script
   verifies the pinned archive SHA-256, then verifies every extracted file
   against the bundled manifest:
   node <home>/.dsh/profiles/web/node_modules/dsh-doc/scripts/fetch-runtime-win32-x64.mjs <home>/.dsh/runtimes/dshdoc-runtime-win32-x64
   Replace <home> with my absolute home directory in this and every later step.
   On any other platform, skip this step and use engine: node below.
3. Edit <home>/.dsh/profiles/web/cordis.patch.yml. Preserve every existing
   entry and add or update this one:
   - id: dsh-doc
     config:
       engine: python
       runtimeDir: <home>/.dsh/runtimes/dshdoc-runtime-win32-x64
       defaultOcr: true
       maxOutputChars: 32000
   The session workspace is readable automatically; add allowedLocalRoots only
   for extra persistent directories such as a shared document vault.
   If you skipped step 2, use `engine: node` and `defaultOcr: false` instead
   and omit runtimeDir.
4. Verify with `dsh --profile web --dump-config` that the composed dsh-doc
   entry carries exactly this config, then report the result and remind me to
   restart `dsh web` so I can call dshdoc_health.

Hard constraints: never install, start, or configure Docling Serve, Docker,
containers, or any remote document-conversion service; never configure a
downloadable OCR backend or allow a model download.
```

## Manual procedure

1. Install the published plugin into the active profile. `dsh web` always uses
   `web`; do not install into `default` and then expect it to appear in
   `dsh web`.

   ```text
   dsh plugin --profile web add dsh-doc
   ```

2. Windows x64 only — fetch the prebuilt offline OCR runtime into a stable
   directory outside `node_modules` (so plugin upgrades never delete it):

   ```text
   node $HOME/.dsh/profiles/web/node_modules/dsh-doc/scripts/fetch-runtime-win32-x64.mjs $HOME/.dsh/runtimes/dshdoc-runtime-win32-x64
   ```

3. Surgically add or update the plugin entry in that profile's
   `cordis.patch.yml`. Preserve other entries. Replace `$HOME` with the
   absolute home path.

   ```yaml
   - id: dsh-doc
     config:
       engine: python
       runtimeDir: $HOME/.dsh/runtimes/dshdoc-runtime-win32-x64
       # The configured runtime contains the local language packs.
       defaultOcr: true
       maxOutputChars: 32000
   ```

   The session workspace is readable without `allowedLocalRoots`; configure it
   only for extra persistent directories beyond the workspace.

4. Restart `dsh web`. A configuration dump can help inspect the generated
   profile, but DSH may rewrite its profile layer while dumping, so keep normal
   configuration under version control or make a backup first.

5. Ask the Harness to run `dshdoc_health`, then parse a file beneath the
   configured root. `dshdoc_extract` is the preferred tool.

## Offline Python runtime for OCR

For Windows x64, most users fetch the prebuilt, hash-pinned runtime from the
GitHub Release (see above). To audit and rebuild from source instead, clone the
repository and run:

```text
node ./scripts/build-runtime-win32-x64.mjs
```

Then point `runtimeDir` at the produced `.dsh-runtime/runtime-win32-x64`
directory:

```yaml
- id: dsh-doc
  config:
    engine: python
    runtimeDir: <absolute path to the runtime directory>
```

The artifact is outside Git by design and includes fixed CPython, Xberg, and
Tesseract language data. It has no HTTP endpoint and does not download a model
while parsing a document.
