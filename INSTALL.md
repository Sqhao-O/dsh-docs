# Install dsh-docling (for a DSH agent)

You are a DeepSeek Harness (DSH) agent. The user asked you to install and
configure `dsh-docling`. Follow this procedure exactly. It is DSH-only: do not
install skills for other harnesses and do not download, start, or configure
Docling Serve, Python, Docker, Podman, models, or container images.

The procedure is idempotent. Preserve existing profile configuration and never
replace a whole YAML file just to add this plugin.

## 1. Establish the target profile and service details

Use the currently active DSH profile. If its name is not available from the
current session or user request, ask one concise question: “Which DSH profile
should receive dsh-docling? (`web` is the usual choice when you run `dsh web`.)”
Do not guess a different profile.

Use the user's existing Docling Serve endpoint. If no endpoint is present in
the profile configuration or user request, ask for its HTTP(S) base URL. Ask
for an API key only if that service requires one. Never print an API key or add
it to a repository.

For local files, use only the current workspace directory when the user asked
for it. Otherwise leave `allowedLocalRoots` empty; this safely denies local-file
access by default.

## 2. Install the DSH bundle

Run this command, replacing `<profile>` with the chosen DSH profile:

```bash
dsh plugin --profile <profile> add git+https://github.com/Sqhao-O/dsh-docling.git#main
```

The explicit HTTPS Git URL avoids requiring GitHub SSH access. Pin a commit
instead of `#main` for production deployments.

If DSH asks to allow the package's trusted `prepare` build, explain that it
compiles this repository's TypeScript to `lib/` and ask the user for approval.
Do not bypass a DSH or pnpm safety prompt.

When a DSH workspace sandbox blocks this exact command because the global DSH
executable or selected profile is outside the workspace, retry only this
command with DSH's explicit `danger-full-access` permission request. Explain
that the wider access is needed solely to install this requested bundle into
the selected profile. If the user declines, report the denial and stop. Do not
use that permission to install another runtime or to download or start
Docling.

On Windows, if the `dsh` PowerShell shim fails with a
`StandardOutputEncoding`-style error, run `dsh.cmd` for the same command. That
is a shim issue, not evidence that DSH is absent from `PATH`.

If the command fails because `dsh` is not on `PATH`, report that DSH itself is
not available; do not install another agent runtime without the user's
approval.

## 3. Add a minimal profile override

Edit the chosen profile's `cordis.patch.yml` surgically. Keep all existing
entries. Add or update only the `dsh-docling` entry:

```yaml
- id: dsh-docling
  config:
    baseUrl: https://docling.example.internal
    # apiKey: add only when the user supplied one for this service
    allowedLocalRoots:
      - /absolute/path/to/current-workspace
```

Use the user's real endpoint and workspace path. On Windows, an allowed root
may be written as `C:/work/project`. The plugin rejects filesystem roots such
as `C:\` or `/`. If the user did not approve local document access, configure
`allowedLocalRoots: []` instead.

Do not set `allowPrivateUrls: true` unless the user explicitly requests access
to private document URLs. A private `baseUrl` is allowed and does not require
that setting.

If the workspace sandbox blocks access to the selected profile directory,
request the same narrowly explained `danger-full-access` permission before
editing that one file. Do not replace the profile or change unrelated entries.

## 4. Verify without converting a document

Run:

```bash
dsh --profile <profile> --dump-config
```

Confirm that the generated configuration contains an enabled `dsh-docling` row
and the intended non-secret values. Do not echo the API key. If it is missing,
report the exact safe error and stop.

The running DSH process must be restarted to load the newly installed bundle.
After restart, ask the user to say “Check Docling health,” or call
`docling_health` if the current DSH session already loaded the plugin. A failed
health check means the configured service is unreachable; do not try to solve
it by downloading Docling or starting a container.
