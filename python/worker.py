#!/usr/bin/env python3
"""A deliberately small, bytes-only Xberg stdio worker.

This process is an optional runtime boundary for the DSH plugin.  It accepts
one JSON object per stdin line and writes exactly one JSON object per stdout
line.  The parent process is responsible for all file-system and network
authorization; this worker deliberately has no ``path``, ``uri``, or URL input
field.

Protocol request examples::

    {"protocol":"dsh-document-engine/v1","id":"health-1","operation":"health"}
    {
      "protocol":"dsh-document-engine/v1",
      "id":"convert-1",
      "operation":"convert",
      "document": {
        "bytes_base64":"...",
        "media_type":"application/pdf",
        "name":"report.pdf",
        "size":123
      },
      "options": {
        "output_format":"md",
        "ocr":true,
        "ocr_languages":["eng","chi_sim"],
        "ocr_backend":"tesseract",
        "timeout_ms":120000,
        "max_output_chars":32000
      }
    }

The worker never emits diagnostics to stdout, because stdout is the protocol
channel.  Its error messages are intentionally generic so a parser traceback,
local filename, or document content cannot be reflected through a DSH tool.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import platform
import re
import sys
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any


PROTOCOL = "dsh-document-engine/v1"
DEFAULT_MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
DEFAULT_MAX_TIMEOUT_MS = 10 * 60 * 1000
MAX_FILENAME_CHARS = 255
MAX_MIME_TYPE_CHARS = 255
MAX_LANGUAGES = 16
LANGUAGE_PATTERN = re.compile(r"^[A-Za-z0-9_+.-]{1,32}$")
DEFAULT_MAX_OUTPUT_CHARS = 32_000
TRUNCATION_NOTICE = "\n\n> Document parsed successfully, but output was truncated.\n"
MIN_OUTPUT_CHARS = len(TRUNCATION_NOTICE) + 16


def _positive_environment_integer(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


MAX_DOCUMENT_BYTES = _positive_environment_integer(
    "DSH_DOC_WORKER_MAX_INPUT_BYTES", DEFAULT_MAX_DOCUMENT_BYTES
)
# Base64 adds at most 4/3 of the payload, then JSON field names and a newline.
MAX_WIRE_BYTES = ((MAX_DOCUMENT_BYTES + 2) // 3) * 4 + 64 * 1024
MAX_TIMEOUT_MS = _positive_environment_integer(
    "DSH_DOC_WORKER_MAX_TIMEOUT_MS", DEFAULT_MAX_TIMEOUT_MS
)
MAX_OUTPUT_CHARS = max(
    MIN_OUTPUT_CHARS,
    _positive_environment_integer("DSH_DOC_WORKER_MAX_OUTPUT_CHARS", DEFAULT_MAX_OUTPUT_CHARS),
)


class WorkerError(Exception):
    """An error that maps to the engine-neutral TypeScript error codes."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _error_code(error: BaseException) -> str:
    if isinstance(error, WorkerError):
        return error.code
    if isinstance(error, TimeoutError):
        return "ENGINE_TIMEOUT"
    # Avoid importing xberg just to classify malformed protocol requests.  Once
    # it is imported, its public exception classes provide precise safe codes.
    try:
        import xberg

        if isinstance(error, xberg.UnsupportedFormatError):
            return "ENGINE_UNSUPPORTED_FORMAT"
        if isinstance(error, xberg.OcrError):
            return "ENGINE_OCR_UNAVAILABLE"
        if isinstance(error, xberg.XbergTimeoutError):
            return "ENGINE_TIMEOUT"
    except (ImportError, OSError):
        return "ENGINE_UNAVAILABLE"
    return "ENGINE_CONVERSION_FAILED"


def _write(response: Mapping[str, Any]) -> None:
    # ``ensure_ascii=False`` preserves document text while json.dumps still
    # escapes embedded newlines, so each protocol response is exactly one line.
    # Python's Windows text stdout normally follows the active ANSI codepage
    # (often GBK).  Writing bytes explicitly is necessary to keep the protocol
    # UTF-8 when OCR returns Chinese or other non-ASCII text.
    encoded = (json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _error_response(request_id: str | None, code: str) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "id": request_id,
        "ok": False,
        "error": {"code": code},
    }


def _expect_mapping(value: object) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise WorkerError("ENGINE_PROTOCOL_ERROR")
    return value


def _request_id(request: Mapping[str, Any]) -> str:
    value = request.get("id")
    if isinstance(value, str) and value:
        return value
    raise WorkerError("ENGINE_PROTOCOL_ERROR")


def _decode_document(value: object) -> tuple[bytes, str, str]:
    payload = _expect_mapping(value)
    encoded = payload.get("bytes_base64")
    mime_type = payload.get("media_type")
    filename = payload.get("name")
    size = payload.get("size")
    if (
        not isinstance(encoded, str)
        or not isinstance(mime_type, str)
        or not isinstance(filename, str)
        or not isinstance(size, int)
        or isinstance(size, bool)
        or size < 0
    ):
        raise WorkerError("ENGINE_INVALID_INPUT")
    if (
        not filename
        or len(filename) > MAX_FILENAME_CHARS
        or "\x00" in filename
        or "/" in filename
        or "\\" in filename
    ):
        raise WorkerError("ENGINE_INVALID_INPUT")
    if not mime_type or len(mime_type) > MAX_MIME_TYPE_CHARS or "/" not in mime_type:
        raise WorkerError("ENGINE_INVALID_INPUT")
    try:
        content = base64.b64decode(encoded.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error):
        raise WorkerError("ENGINE_INVALID_INPUT") from None
    if not content or len(content) != size or len(content) > MAX_DOCUMENT_BYTES:
        raise WorkerError("ENGINE_INVALID_INPUT")
    return content, mime_type, filename


def _option_string(options: Mapping[str, Any], name: str, default: str, allowed: set[str]) -> str:
    value = options.get(name, default)
    if not isinstance(value, str) or value not in allowed:
        raise WorkerError("ENGINE_PROTOCOL_ERROR")
    return value


def _bundled_languages() -> list[str]:
    """List the Tesseract packs deliberately bundled by the platform runtime."""
    raw_path = os.environ.get("DSH_DOC_TESSDATA_PATH")
    if not raw_path:
        return []
    directory = Path(raw_path)
    if not directory.is_dir():
        return []
    return sorted(
        item.stem
        for item in directory.glob("*.traineddata")
        if item.is_file() and LANGUAGE_PATTERN.fullmatch(item.stem)
    )


def _ocr_languages(options: Mapping[str, Any]) -> list[str]:
    value = options.get("ocr_languages")
    if value is None:
        # The caller did not pin languages: use every pack the runtime carries
        # instead of defaulting to English-only OCR.
        return _bundled_languages()
    if not isinstance(value, list) or not value or len(value) > MAX_LANGUAGES:
        raise WorkerError("ENGINE_PROTOCOL_ERROR")
    if not all(isinstance(item, str) and LANGUAGE_PATTERN.fullmatch(item) for item in value):
        raise WorkerError("ENGINE_PROTOCOL_ERROR")
    return list(value)


def _tessdata_path(languages: list[str]) -> str:
    """Require model files deliberately bundled by the platform runtime.

    Xberg can opportunistically fetch a missing Tesseract language pack.  That
    is useful for a developer CLI but violates this plugin's offline, bundled
    runtime contract.  The env variable is set by the runtime launcher, never
    by a tool request, and is the only file-system path this worker consumes.
    """
    raw_path = os.environ.get("DSH_DOC_TESSDATA_PATH")
    if not raw_path:
        raise WorkerError("ENGINE_OCR_UNAVAILABLE")
    directory = Path(raw_path)
    if not directory.is_dir():
        raise WorkerError("ENGINE_OCR_UNAVAILABLE")
    if any(not (directory / f"{language}.traineddata").is_file() for language in languages):
        raise WorkerError("ENGINE_OCR_UNAVAILABLE")
    return str(directory)


def _page_range(value: object) -> tuple[int, int] | None:
    if value is None:
        return None
    if (
        not isinstance(value, list)
        or len(value) != 2
        or not all(isinstance(page, int) and not isinstance(page, bool) for page in value)
    ):
        raise WorkerError("ENGINE_INVALID_INPUT")
    first, last = value
    if first < 1 or last < first:
        raise WorkerError("ENGINE_INVALID_INPUT")
    return first, last


def _utf16_length(value: str) -> int:
    """Match JavaScript String.length for the shared model-output contract."""
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _prefix_at_utf16_limit(value: str, limit: int) -> str:
    """Return the longest prefix whose JavaScript length is at most ``limit``."""
    units = 0
    end = 0
    for end, character in enumerate(value, start=1):
        character_units = 2 if ord(character) > 0xFFFF else 1
        if units + character_units > limit:
            return value[: end - 1]
        units += character_units
    return value


def _limit_output(value: str, max_chars: int) -> tuple[str, int, int, bool]:
    """Use the same heading/line-oriented truncation behavior as Node."""
    original_chars = _utf16_length(value)
    if original_chars <= max_chars:
        return value, original_chars, original_chars, False
    budget = max_chars - _utf16_length(TRUNCATION_NOTICE)
    prefix_window = _prefix_at_utf16_limit(value, budget)
    cut = prefix_window
    heading = prefix_window.rfind("\n#")
    if heading >= 0 and _utf16_length(prefix_window[:heading]) > int(budget * 0.55):
        cut = prefix_window[:heading]
    else:
        line = prefix_window.rfind("\n")
        if line >= 0 and _utf16_length(prefix_window[:line]) > int(budget * 0.8):
            cut = prefix_window[:line]
    limited = f"{cut.rstrip()}{TRUNCATION_NOTICE}"
    return limited, original_chars, _utf16_length(limited), True


def _max_output_chars(options: Mapping[str, Any]) -> int:
    value = options.get("max_output_chars", MAX_OUTPUT_CHARS)
    if not isinstance(value, int) or isinstance(value, bool) or value < MIN_OUTPUT_CHARS:
        raise WorkerError("ENGINE_PROTOCOL_ERROR")
    return min(value, MAX_OUTPUT_CHARS)


def _build_config(options_value: object) -> tuple[dict[str, Any], int, str, tuple[int, int] | None, int]:
    options = _expect_mapping(options_value)
    output_format = _option_string(options, "output_format", "md", {"md", "text", "json"})
    ocr = options.get("ocr", False)
    if not isinstance(ocr, bool):
        raise WorkerError("ENGINE_PROTOCOL_ERROR")
    table_mode = _option_string(options, "table_mode", "fast", {"fast", "accurate"})
    # Xberg has automatic table extraction.  Its documented OCR Tesseract
    # option is the only stable, local mapping available in v1.0.14; accurate
    # asks that backend to run its table detector when OCR is enabled.
    timeout_ms = options.get("timeout_ms", MAX_TIMEOUT_MS)
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or timeout_ms <= 0:
        raise WorkerError("ENGINE_PROTOCOL_ERROR")
    timeout_ms = min(timeout_ms, MAX_TIMEOUT_MS)
    page_range = _page_range(options.get("page_range"))
    max_output_chars = _max_output_chars(options)

    xberg_format = {"md": "markdown", "text": "plain", "json": "json"}[output_format]
    config: dict[str, Any] = {
        "output_format": xberg_format,
        # The plugin owns cache policy and input authorization.  A worker cache
        # would create an unbounded, opaque second data store under a user home.
        "use_cache": False,
        "disable_ocr": not ocr,
        "extraction_timeout_secs": max(1, (timeout_ms + 999) // 1000),
        # Keep Python and Node table/reading-order semantics identical for
        # PDFs, whether or not OCR is required for the particular page.
        # Reading-order reflow improves Markdown/JSON structure, but on
        # multi-column layouts it interleaves fragments into scrambled
        # plain text, so text output keeps the native stream order.
        "pdf_options": {
            "extract_tables": table_mode == "accurate",
            "reading_order": table_mode == "accurate" and output_format != "text",
        },
    }
    if page_range is not None:
        # Xberg emits page objects when requested.  Selection is applied after
        # extraction below, matching the Node engine's bytes-only semantics.
        config["pages"] = {"extract_pages": True}
    if ocr:
        # The v1 embedded runtime carries Tesseract language packs.  Do not
        # expose Xberg's downloadable Paddle/Candle model paths until each is
        # a separately pinned and bundled runtime artifact.
        requested_backend = _option_string(options, "ocr_backend", "auto", {"auto", "tesseract", "paddleocr"})
        if requested_backend == "paddleocr":
            raise WorkerError("ENGINE_OCR_UNAVAILABLE")
        backend = "tesseract"
        languages = _ocr_languages(options)
        if not languages:
            raise WorkerError("ENGINE_OCR_UNAVAILABLE")
        tessdata_path = _tessdata_path(languages)
        ocr_config: dict[str, Any] = {"enabled": True, "backend": backend, "language": languages}
        ocr_config["tessdata_path"] = tessdata_path
        ocr_config["tesseract_config"] = {
            "language": languages,
            "enable_table_detection": table_mode == "accurate",
            # Xberg's Tesseract-specific cache defaults to enabled even when
            # the top-level extraction cache is disabled. Never retain a
            # document-derived OCR result in this worker runtime.
            "use_cache": False,
        }
        config["ocr"] = ocr_config
        # Deliberately no force_ocr: Xberg's default strategy only OCRs pages
        # without a usable native text layer.  Forcing OCR would replace a
        # perfect embedded text layer with a lossy Tesseract rendering.
    return config, timeout_ms, output_format, page_range, max_output_chars


def _safe_optional_string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _metadata(document: Any) -> dict[str, Any]:
    metadata = getattr(document, "metadata", None)
    counts = getattr(document, "counts", None)
    result: dict[str, Any] = {}
    title = _safe_optional_string(getattr(metadata, "title", None))
    if title:
        result["title"] = title
    pages = getattr(counts, "pages", None)
    if isinstance(pages, int) and pages > 0:
        result["pages"] = pages
    detected_format = _safe_optional_string(getattr(document, "mime_type", None))
    if detected_format:
        result["detected_format"] = detected_format
    ocr_used = getattr(metadata, "ocr_used", None)
    if isinstance(ocr_used, bool):
        result["ocrUsed"] = ocr_used
    return result


def _extension(filename: str) -> str:
    dot = filename.rfind(".")
    return filename[dot + 1:].lower() if dot >= 0 and dot < len(filename) - 1 else "document"


def _selected_content(document: Any, content: str, page_range: tuple[int, int] | None) -> str:
    if page_range is None:
        return content
    pages = getattr(document, "pages", None)
    if not isinstance(pages, list):
        return content
    first, last = page_range
    selected = [
        page_content
        for page in pages
        if isinstance((page_content := getattr(page, "content", None)), str)
        and isinstance((page_number := getattr(page, "page_number", None)), int)
        and first <= page_number <= last
    ]
    return "\n\n".join(selected)


def _json_value(content: str, document: Any) -> Any:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        # Maintain JSON validity if a future Xberg renderer returns text even
        # when JSON was requested.  Keep the envelope intentionally shallow;
        # rich metadata belongs in a future explicitly-versioned contract.
        return {"content": content, "mime_type": getattr(document, "mime_type", None)}


async def _convert(request: Mapping[str, Any]) -> dict[str, Any]:
    content, mime_type, filename = _decode_document(request.get("document"))
    config_data, timeout_ms, output_format, page_range, max_output_chars = _build_config(request.get("options", {}))
    try:
        import xberg
    except (ImportError, OSError):
        raise WorkerError("ENGINE_UNAVAILABLE") from None

    try:
        xberg_input = xberg.ExtractInput(
            kind="bytes",
            bytes=content,
            mime_type=mime_type,
            filename=filename,
        )
        config = xberg.ExtractionConfig(config_data)
        extraction = await asyncio.wait_for(
            xberg.extract(xberg_input, config), timeout=timeout_ms / 1000
        )
    except asyncio.TimeoutError:
        raise WorkerError("ENGINE_TIMEOUT") from None

    results = getattr(extraction, "results", None)
    if not isinstance(results, list) or not results:
        raise WorkerError("ENGINE_CONVERSION_FAILED")
    document = results[0]
    extracted_content = getattr(document, "content", None)
    if not isinstance(extracted_content, str):
        raise WorkerError("ENGINE_CONVERSION_FAILED")
    result: dict[str, Any] = {
        "format": _extension(filename),
        "metadata": _metadata(document),
    }
    if output_format == "md":
        limited, output_chars, returned_chars, truncated = _limit_output(
            _selected_content(document, extracted_content, page_range), max_output_chars
        )
        result["markdown"] = limited
    elif output_format == "text":
        limited, output_chars, returned_chars, truncated = _limit_output(
            _selected_content(document, extracted_content, page_range), max_output_chars
        )
        result["text"] = limited
    else:
        json_value = _json_value(extracted_content, document)
        rendered_json = json.dumps(json_value, ensure_ascii=False, indent=2)
        limited, output_chars, returned_chars, truncated = _limit_output(rendered_json, max_output_chars)
        # A partial JSON value is not canonical JSON. Match the Node engine by
        # returning a bounded text preview when JSON output exceeds its limit.
        if truncated:
            result["text"] = limited
        else:
            result["json"] = json_value
    result["stats"] = {
        "output_chars": output_chars,
        "returned_chars": returned_chars,
        "truncated": truncated,
    }
    return result


def _health() -> dict[str, Any]:
    try:
        import xberg
    except (ImportError, OSError):
        raise WorkerError("ENGINE_UNAVAILABLE") from None
    backends = xberg.list_ocr_backends()
    ocr_languages = _bundled_languages()
    ocr_available = bool(ocr_languages and "tesseract" in backends)
    return {
        "status": "ready",
        "engine": "xberg-python",
        "runtime_version": _safe_optional_string(getattr(xberg, "__version__", None)),
        "python_version": platform.python_version(),
        # The engine may list more backends, but only the bundled Tesseract
        # backend is available through this offline worker contract.
        "ocr_backends": ["tesseract"] if ocr_available and "tesseract" in backends else [],
        "ocr_available": ocr_available,
        "ocr_languages": ocr_languages,
        "max_document_bytes": MAX_DOCUMENT_BYTES,
    }


async def _handle(request: Mapping[str, Any]) -> dict[str, Any]:
    if request.get("protocol") != PROTOCOL:
        raise WorkerError("ENGINE_PROTOCOL_ERROR")
    operation = request.get("operation")
    if operation == "health":
        return _health()
    if operation == "convert":
        return await _convert(request)
    raise WorkerError("ENGINE_PROTOCOL_ERROR")


def main() -> int:
    while True:
        # ``for line in stdin`` has no length cap and can allocate an arbitrary
        # line before we get a chance to reject it.  Read bounded chunks instead
        # because stdin is still a process boundary, even though it is private.
        raw_line = sys.stdin.buffer.readline(MAX_WIRE_BYTES + 1)
        if not raw_line:
            break
        if len(raw_line) > MAX_WIRE_BYTES:
            # Drain the rest of this oversized logical line before accepting a
            # subsequent request; otherwise its trailing bytes could be parsed
            # as a fresh JSON request.
            while raw_line and not raw_line.endswith(b"\n"):
                raw_line = sys.stdin.buffer.readline(MAX_WIRE_BYTES + 1)
            _write(_error_response(None, "ENGINE_PROTOCOL_ERROR"))
            continue
        try:
            decoded = raw_line.decode("utf-8")
            request = _expect_mapping(json.loads(decoded))
            request_id = _request_id(request)
            started = time.monotonic()
            result = asyncio.run(_handle(request))
            elapsed_ms = int((time.monotonic() - started) * 1000)
            _write({"protocol": PROTOCOL, "id": request_id, "ok": True, "result": result, "elapsed_ms": elapsed_ms})
        except BaseException as error:  # stdout must retain a well-formed reply.
            request_id: str | None = None
            if "request" in locals() and isinstance(request, Mapping):
                try:
                    request_id = _request_id(request)
                except WorkerError:
                    pass
            _write(_error_response(request_id, _error_code(error)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
