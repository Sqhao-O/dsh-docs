# Install dsh-docling with a DSH agent

Use this prompt inside DeepSeek Harness:

```text
Install the local dsh-docling plugin into my active DSH profile (use web only
when that is the active profile). Do not install, start, call, or configure
Docling Serve, Docker, containers, or a remote document service. Allow only my
current workspace as allowedLocalRoots. For OCR, build or use the trusted
embedded Python runtime and configure engine: python with its runtimeDir. Do
not configure a downloadable OCR backend or allow a model download. Node is a
non-OCR PDF/Office/text fallback unless a trusted local tessdataPath is supplied.
Verify the enabled plugin entry and report the exact local document formats/OCR
path that are available. Do not add generated test files or runtime artifacts to
Git.
```

## Manual procedure

1. Determine the active profile. `dsh web` always uses `web`; do not install
   into `default` and then expect it to appear in `dsh web`.

2. Install the plugin from a local checkout or a commit-pinned Git URL:

   ```powershell
   dsh plugin --profile web add D:/Dev/Projects/dsh-docling
   ```

3. Surgically add or update the plugin entry in that profile's
   `cordis.patch.yml`. Preserve other entries.

   ```yaml
   - id: dsh-docling
     config:
       engine: python
       runtimeDir: D:/Dev/Projects/dsh-docling/.dsh-runtime/runtime-win32-x64
       allowedLocalRoots:
         - D:/Dev/Projects/my-workspace
       # The configured runtime contains the local language packs.
       defaultOcr: true
       maxOutputChars: 32000
   ```

4. Restart `dsh web`. A configuration dump can help inspect the generated
   profile, but DSH may rewrite its profile layer while dumping, so keep normal
   configuration under version control or make a backup first.

5. Ask the Harness to run `docling_health`, then parse a file beneath the
   configured root. `docling_extract` is the preferred tool.

## Required offline Python runtime for OCR

For Windows x64, build the runtime in a trusted checkout:

```powershell
pwsh -File ./scripts/build-runtime-win32-x64.ps1
```

Then use:

```yaml
- id: dsh-docling
  config:
    engine: python
    runtimeDir: D:/Dev/Projects/dsh-docling/.dsh-runtime/runtime-win32-x64
    allowedLocalRoots:
      - D:/Dev/Projects/my-workspace
```

The artifact is outside Git by design and includes fixed CPython, Xberg, and
Tesseract language data. It has no HTTP endpoint and does not download a model
while parsing a document.
