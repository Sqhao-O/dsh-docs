# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use GitHub's
[private security advisory form](https://github.com/Sqhao-O/dsh-docs/security/advisories/new)
and include a minimal reproduction, affected version, impact, and any proposed
mitigation. The maintainer will acknowledge reports as soon as practical and
coordinate a fix before public disclosure.

## Deployment boundary

`dsh-doc` accepts only model-supplied paths below the session workspace or
explicit local allowlist roots. It resolves real paths, opens a regular file,
verifies the opened file descriptor still matches the authorized path
identity, then passes a byte snapshot to a local engine. Paths, URLs, and
network-capable source handles are never forwarded to Xberg or the Python
worker.

The plugin creates no listener and has no Docling Serve, Docker, URL-fetch, or
remote-parser dependency. OCR only uses configured local Tesseract data;
missing language packs fail closed rather than downloading a model. Treat the
configured allowlist and runtime artifact as trusted deployment inputs.
