# Install dsh-doc with a DSH agent

No local checkout is needed. Paste this prompt into a running DSH session (for
example `dsh web`) in your own project folder — the agent clones, builds,
registers, and configures the plugin in one go. Prerequisites: `git`,
`pnpm` ≥ 10, Node `^22.19` or `>= 24`, and PowerShell 7+ on Windows x64.

```text
Install the dsh-doc plugin into my DSH web profile, end to end. Do every
step yourself in the terminal and verify the result.

1. Clone the repository (skip this step if the directory already exists):
   git clone https://github.com/Sqhao-O/dsh-docs.git <home>/.dsh/plugins/dsh-docs
   Replace <home> with my absolute home directory and use that absolute clone
   path in every later step.
2. Build the plugin: run `pnpm install` inside the clone. Its prepare script
   compiles lib/; make sure lib/index.js exists afterwards.
3. Windows x64 only — build the offline OCR runtime (every download is
   SHA-256 pinned):
   pwsh -File <clone>/scripts/build-runtime-win32-x64.ps1
   On any other platform, skip this step and use engine: node below.
4. Register the plugin with my web profile:
   dsh plugin --profile web add <clone>
5. Edit <home>/.dsh/profiles/web/cordis.patch.yml. Preserve every existing
   entry and add or update this one, with <clone> and <workspace> replaced by
   absolute paths (<workspace> is my current working directory):
   - id: dsh-doc
     config:
       engine: python
       runtimeDir: <clone>/.dsh-runtime/runtime-win32-x64
       allowedLocalRoots:
         - <workspace>
       defaultOcr: true
       maxOutputChars: 32000
   If you skipped step 3, use `engine: node` and `defaultOcr: false` instead
   and omit runtimeDir.
6. Verify with `dsh --profile web --dump-config` that the composed dsh-doc
   entry carries exactly this config, then report the result and remind me to
   restart `dsh web` so I can call dshdoc_health.

Hard constraints: never install, start, or configure Docling Serve, Docker,
containers, or any remote document-conversion service; never configure a
downloadable OCR backend or allow a model download; do not commit the clone's
.dsh-runtime/ artifacts to Git.
```

## Manual procedure

1. Clone and build the plugin (the prepare script compiles `lib/`):

   ```powershell
   git clone https://github.com/Sqhao-O/dsh-docs.git $HOME/.dsh/plugins/dsh-docs
   pnpm install --dir $HOME/.dsh/plugins/dsh-docs
   ```

2. Windows x64 only — build the offline OCR runtime:

   ```powershell
   pwsh -File $HOME/.dsh/plugins/dsh-docs/scripts/build-runtime-win32-x64.ps1
   ```

3. Determine the active profile. `dsh web` always uses `web`; do not install
   into `default` and then expect it to appear in `dsh web`.

4. Install the plugin from the local checkout:

   ```powershell
   dsh plugin --profile web add $HOME/.dsh/plugins/dsh-docs
   ```

5. Surgically add or update the plugin entry in that profile's
   `cordis.patch.yml`. Preserve other entries. Replace `$HOME` and the
   workspace with absolute paths.

   ```yaml
   - id: dsh-doc
     config:
       engine: python
       runtimeDir: $HOME/.dsh/plugins/dsh-docs/.dsh-runtime/runtime-win32-x64
       allowedLocalRoots:
         - D:/Dev/Projects/my-workspace
       # The configured runtime contains the local language packs.
       defaultOcr: true
       maxOutputChars: 32000
   ```

6. Restart `dsh web`. A configuration dump can help inspect the generated
   profile, but DSH may rewrite its profile layer while dumping, so keep normal
   configuration under version control or make a backup first.

7. Ask the Harness to run `dshdoc_health`, then parse a file beneath the
   configured root. `dshdoc_extract` is the preferred tool.

## Required offline Python runtime for OCR

For Windows x64, build the runtime in a trusted checkout:

```powershell
pwsh -File ./scripts/build-runtime-win32-x64.ps1
```

Then use:

```yaml
- id: dsh-doc
  config:
    engine: python
    runtimeDir: $HOME/.dsh/plugins/dsh-docs/.dsh-runtime/runtime-win32-x64
    allowedLocalRoots:
      - D:/Dev/Projects/my-workspace
```

The artifact is outside Git by design and includes fixed CPython, Xberg, and
Tesseract language data. It has no HTTP endpoint and does not download a model
while parsing a document.
