# Changelog

## Unreleased

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
