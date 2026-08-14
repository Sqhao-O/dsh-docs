# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use GitHub's
[private security advisory form](https://github.com/Sqhao-O/dsh-docling/security/advisories/new)
and include a minimal reproduction, affected version, impact, and any proposed
mitigation. The maintainer will acknowledge reports as soon as practical and
coordinate a fix before public disclosure.

## Deployment boundary

`dsh-docling` validates model-supplied local paths and document URLs. Docling
Serve performs the actual document retrieval, however. Operators must restrict
Docling Serve egress from reaching private networks and cloud metadata services
to cover redirects and DNS rebinding after the plugin's preflight validation.
