# Architecture

## Upstream compatibility decision

Research was performed against DeepSeek Harness commit
`47f943859bef60e4160492346772ded9b24f765a` and Docling Serve commit
`69192d178924bbae2f1733e2d7cd21ffd04259c5` (Docling Serve 1.30.0).

- DSH plugins are Cordis modules exporting `name`, `inject`, `Config`, and
  `apply`. Tool registration is `ctx.tools.register(defineTool(...))`.
  `defineTool` validates parameters, retains a canonical JSON value, and uses
  `output.render` for model-facing content.
- A DSH distributable plugin is a bundle package with
  `dsh.bundle.patch: "./cordis.patch.yml"`; the patch inserts a row whose
  `name` is the installed package name. `dsh plugin --profile <name> add`
  maintains the profile dependency and bundle list.
- Current DSH durable attachments and Web UI are image-only. This release does
  not attempt to modify Harness Core or consume an unstable arbitrary-file
  attachment seam. Local paths and public URLs are the v0.1 source boundary.
- Docling Serve v1 provides `GET /health`, multipart `POST /v1/convert/file`,
  and JSON `POST /v1/convert/source`. Authentication, when enabled by
  `DOCLING_SERVE_API_KEY`, is `X-Api-Key`.

## Runtime flow

```text
DeepSeek Harness ToolRuntime
        |
        +-- docling_extract / docling_convert_file / docling_convert_url
                 |
                 +-- local path sandbox OR URL SSRF policy
                 |
                 +-- DoclingHttpClient
                         |
                         +-- Docling Serve v1 HTTP API
                                 |
                                 +-- normalized canonical result
                                         |
                                         +-- bounded native Tool Result render
```

## Module boundaries

- `src/security` owns pre-network input authorization. It resolves both the
  candidate path and configured roots with `realpath`, then checks containment.
  URL validation permits only HTTP(S), rejects local/private addresses, and
  resolves DNS once before sending a source to Docling.
- `src/docling` owns HTTP transport, authentication, timeouts, status mapping,
  response normalization, and output-size enforcement. It never exposes raw
  server tracebacks to a tool.
- `src/tools` owns DSH schemas, model descriptions, default selection, and
  canonical-to-model rendering. Client construction is isolated from tool
  factories to keep tests injectable.
- `src/output` owns a Unicode-safe, Markdown-aware output limiter. JSON that
  exceeds the cap becomes a bounded text preview, rather than invalid partial
  JSON in the canonical result.

## Security posture

The configured Docling endpoint is a deployment trust boundary and may be a
private address. That is intentionally separate from document URL validation.
Local documents require explicit non-root `allowedLocalRoots`; an empty list
denies all local access. `allowPrivateUrls` is an explicit, default-off escape
hatch for controlled internal deployments.
