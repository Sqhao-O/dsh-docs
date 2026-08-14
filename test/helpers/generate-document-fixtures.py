#!/usr/bin/env python3
"""Generate disposable, deterministic parser fixtures outside the repository.

The output documents deliberately are not checked into Git.  This script uses
only Python's standard library so a test runner can create PDF, Office, and
scanned-image inputs without downloading authoring libraries or committing
binary fixtures.
"""

from __future__ import annotations

import argparse
import binascii
import json
import os
import struct
import tempfile
import zipfile
import zlib
from pathlib import Path
from xml.sax.saxutils import escape


SENTINELS = {
    "pdf": "DSH PDF SENTINEL 7F3D",
    "docx": "DSH DOCX SENTINEL 7F3D",
    "xlsx": "DSH XLSX SENTINEL 7F3D",
    "pptx": "DSH PPTX SENTINEL 7F3D",
    "png": "DSH OCR 2026",
    "scannedPdf": "DSH OCR 2026",
    # Generated only on Windows, where the standard-library GDI renderer can
    # use the built-in Microsoft YaHei fallback. This keeps the cross-platform
    # fixture generator dependency-free while giving the Windows runtime a
    # real chi_sim offline smoke test.
    "chinesePng": "中文 OCR 验证 金额 128 状态 通过",
}


def _write_zip(path: Path, files: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)


def _pdf_bytes(text: str) -> bytes:
    # A tiny valid PDF with one Helvetica text page.  The xref offsets are
    # calculated rather than hard-coded so the sentinel can remain readable.
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 24 Tf 72 720 Td ({escaped}) Tj ET\n".encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref_start = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF\n".encode("ascii")
    )
    return bytes(output)


# A compact 5x7 monospace glyph set.  It is scaled into a lossless PNG so the
# OCR fixture is generated from source instead of committed as a binary file.
GLYPHS = {
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "6": ("01110", "10000", "11110", "10001", "10001", "10001", "01110"),
    "C": ("01110", "10001", "10000", "10000", "10000", "10001", "01110"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
}


def _raster_text_bitmap(text: str, scale: int = 24, margin: int = 32) -> tuple[int, int, bytes]:
    glyph_width, glyph_height, gap = 5, 7, 2
    width = margin * 2 + sum((glyph_width + gap) * scale if char != " " else (glyph_width + gap) * scale for char in text)
    height = margin * 2 + glyph_height * scale
    pixels = bytearray([255]) * (width * height)
    x = margin
    for char in text:
        if char != " ":
            glyph = GLYPHS[char]
            for row, row_bits in enumerate(glyph):
                for col, bit in enumerate(row_bits):
                    if bit == "1":
                        for y in range(row * scale, (row + 1) * scale):
                            start = (margin + y) * width + x + col * scale
                            pixels[start:start + scale] = b"\0" * scale
        x += (glyph_width + gap) * scale
    return width, height, bytes(pixels)


def _raster_text_windows(text: str) -> tuple[int, int, bytes]:
    """Render legible anti-aliased text with Windows GDI, without Pillow.

    The fallback bitmap font remains useful for non-Windows fixture smoke tests.
    The real Harness target is Windows, though, and using a system font gives
    Tesseract a reliable actual-OCR assertion rather than merely asserting a
    non-empty image result.
    """
    import ctypes
    from ctypes import wintypes

    class BitmapInfoHeader(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD),
            ("biWidth", ctypes.c_long),
            ("biHeight", ctypes.c_long),
            ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD),
            ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD),
            ("biXPelsPerMeter", ctypes.c_long),
            ("biYPelsPerMeter", ctypes.c_long),
            ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    class RgbQuad(ctypes.Structure):
        _fields_ = [
            ("rgbBlue", ctypes.c_byte),
            ("rgbGreen", ctypes.c_byte),
            ("rgbRed", ctypes.c_byte),
            ("rgbReserved", ctypes.c_byte),
        ]

    class BitmapInfo(ctypes.Structure):
        _fields_ = [("bmiHeader", BitmapInfoHeader), ("bmiColors", RgbQuad * 1)]

    class Size(ctypes.Structure):
        _fields_ = [("cx", ctypes.c_long), ("cy", ctypes.c_long)]

    gdi = ctypes.WinDLL("gdi32", use_last_error=True)
    user = ctypes.WinDLL("user32", use_last_error=True)
    user.GetDC.argtypes = [wintypes.HWND]
    user.GetDC.restype = wintypes.HDC
    user.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    gdi.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi.CreateCompatibleDC.restype = wintypes.HDC
    gdi.CreateDIBSection.argtypes = [
        wintypes.HDC,
        ctypes.POINTER(BitmapInfo),
        wintypes.UINT,
        ctypes.POINTER(ctypes.c_void_p),
        wintypes.HANDLE,
        wintypes.DWORD,
    ]
    gdi.CreateDIBSection.restype = wintypes.HBITMAP
    gdi.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi.SelectObject.restype = wintypes.HGDIOBJ
    gdi.CreateFontW.argtypes = [ctypes.c_int] * 5 + [wintypes.DWORD] * 8 + [wintypes.LPCWSTR]
    gdi.CreateFontW.restype = wintypes.HFONT
    gdi.GetTextExtentPoint32W.argtypes = [
        wintypes.HDC,
        wintypes.LPCWSTR,
        ctypes.c_int,
        ctypes.POINTER(Size),
    ]
    gdi.GetTextExtentPoint32W.restype = wintypes.BOOL
    gdi.SetBkMode.argtypes = [wintypes.HDC, ctypes.c_int]
    gdi.SetTextColor.argtypes = [wintypes.HDC, wintypes.COLORREF]
    gdi.TextOutW.argtypes = [
        wintypes.HDC,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.LPCWSTR,
        ctypes.c_int,
    ]
    gdi.TextOutW.restype = wintypes.BOOL
    gdi.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi.DeleteDC.argtypes = [wintypes.HDC]

    screen = user.GetDC(None)
    if not screen:
        raise OSError(ctypes.get_last_error(), "GetDC failed")
    dc = gdi.CreateCompatibleDC(screen)
    if not dc:
        user.ReleaseDC(None, screen)
        raise OSError(ctypes.get_last_error(), "CreateCompatibleDC failed")
    font = None
    bitmap = None
    old_font = None
    old_bitmap = None
    try:
        # Negative height asks GDI for a character height.  Microsoft YaHei is
        # bundled with supported Chinese Windows editions; Arial remains a
        # broadly available Latin fallback.  GDI still performs last-resort
        # font fallback if a minimal test image lacks either face.
        font_name = "Microsoft YaHei" if any(ord(character) > 127 for character in text) else "Arial"
        font = gdi.CreateFontW(-120, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, font_name)
        if not font:
            raise OSError(ctypes.get_last_error(), "CreateFontW failed")
        old_font = gdi.SelectObject(dc, font)
        size = Size()
        if not gdi.GetTextExtentPoint32W(dc, text, len(text), ctypes.byref(size)):
            raise OSError(ctypes.get_last_error(), "GetTextExtentPoint32W failed")
        width, height = size.cx + 80, size.cy + 80
        bitmap_info = BitmapInfo()
        bitmap_info.bmiHeader.biSize = ctypes.sizeof(BitmapInfoHeader)
        bitmap_info.bmiHeader.biWidth = width
        # A negative height makes a top-down DIB, matching PNG row order.
        bitmap_info.bmiHeader.biHeight = -height
        bitmap_info.bmiHeader.biPlanes = 1
        bitmap_info.bmiHeader.biBitCount = 32
        bitmap_info.bmiHeader.biCompression = 0  # BI_RGB
        raw_pointer = ctypes.c_void_p()
        bitmap = gdi.CreateDIBSection(dc, ctypes.byref(bitmap_info), 0, ctypes.byref(raw_pointer), None, 0)
        if not bitmap or not raw_pointer:
            raise OSError(ctypes.get_last_error(), "CreateDIBSection failed")
        old_bitmap = gdi.SelectObject(dc, bitmap)
        ctypes.memset(raw_pointer, 255, width * height * 4)
        gdi.SetBkMode(dc, 1)  # TRANSPARENT
        gdi.SetTextColor(dc, 0)  # RGB(0, 0, 0)
        if not gdi.TextOutW(dc, 40, 40, text, len(text)):
            raise OSError(ctypes.get_last_error(), "TextOutW failed")
        raw_bgra = ctypes.string_at(raw_pointer, width * height * 4)
    finally:
        if old_bitmap:
            gdi.SelectObject(dc, old_bitmap)
        if old_font:
            gdi.SelectObject(dc, old_font)
        if bitmap:
            gdi.DeleteObject(bitmap)
        if font:
            gdi.DeleteObject(font)
        gdi.DeleteDC(dc)
        user.ReleaseDC(None, screen)

    # Xberg accepts grayscale PNG and the compact image helps keep test startup
    # fast.  GDI gives BGRA pixels; convert them after releasing GDI resources.
    pixels = bytearray(width * height)
    for index in range(width * height):
        blue, green, red, _alpha = raw_bgra[index * 4:index * 4 + 4]
        pixels[index] = (red * 299 + green * 587 + blue * 114) // 1000
    return width, height, bytes(pixels)


def _raster_text(text: str) -> tuple[int, int, bytes]:
    if os.name == "nt":
        try:
            return _raster_text_windows(text)
        except OSError:
            # Fixture generation should remain runnable in minimal CI images
            # without a desktop/GDI session.  OCR semantic checks are Windows
            # runtime tests; non-Windows CI still validates the bridge safely.
            pass
    return _raster_text_bitmap(text)


def _png_bytes(width: int, height: int, pixels: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)

    rows = b"".join(b"\0" + pixels[row * width:(row + 1) * width] for row in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def _scanned_pdf_bytes(width: int, height: int, pixels: bytes) -> bytes:
    compressed = zlib.compress(pixels, 9)
    contents = f"q\n{width} 0 0 {height} 0 0 cm\n/Im0 Do\nQ\n".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] "
            f"/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"
        ).encode("ascii"),
        b"<< /Length " + str(len(contents)).encode("ascii") + b" >>\nstream\n" + contents + b"endstream",
        (
            f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} "
            f"/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length {len(compressed)} >>\nstream\n"
        ).encode("ascii") + compressed + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref_start = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF\n".encode("ascii")
    )
    return bytes(output)


def _docx_files(text: str) -> dict[str, str]:
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:body><w:p><w:r><w:t>{escape(text)}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'
    )
    return {
        "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": document,
    }


def _xlsx_files(text: str) -> dict[str, str]:
    return {
        "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": f'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{escape(text)}</t></is></c><c r="B1"><v>2026</v></c></row></sheetData></worksheet>',
    }


def _pptx_files(text: str) -> dict[str, str]:
    slide = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        '<p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>'
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{escape(text)}</a:t></a:r></a:p></p:txBody></p:sp>'
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    )
    return {
        "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
        "ppt/presentation.xml": '<?xml version="1.0"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
        "ppt/_rels/presentation.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
        "ppt/slides/slide1.xml": slide,
    }


def generate(output: Path) -> dict[str, object]:
    output.mkdir(parents=True, exist_ok=True)
    (output / "native.pdf").write_bytes(_pdf_bytes(SENTINELS["pdf"]))
    _write_zip(output / "document.docx", _docx_files(SENTINELS["docx"]))
    _write_zip(output / "workbook.xlsx", _xlsx_files(SENTINELS["xlsx"]))
    _write_zip(output / "slides.pptx", _pptx_files(SENTINELS["pptx"]))
    width, height, pixels = _raster_text(SENTINELS["png"])
    (output / "scanned.png").write_bytes(_png_bytes(width, height, pixels))
    (output / "scanned.pdf").write_bytes(_scanned_pdf_bytes(width, height, pixels))
    files = {
        "pdf": "native.pdf",
        "docx": "document.docx",
        "xlsx": "workbook.xlsx",
        "pptx": "slides.pptx",
        "png": "scanned.png",
        "scannedPdf": "scanned.pdf",
    }
    if os.name == "nt":
        chinese_width, chinese_height, chinese_pixels = _raster_text(SENTINELS["chinesePng"])
        (output / "chinese.png").write_bytes(_png_bytes(chinese_width, chinese_height, chinese_pixels))
        files["chinesePng"] = "chinese.png"
    manifest: dict[str, object] = {
        "directory": str(output),
        "sentinels": SENTINELS,
        "files": files,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="A disposable output directory. Defaults to a system-temp directory.")
    arguments = parser.parse_args()
    output = arguments.output
    if output is None:
        output = Path(tempfile.mkdtemp(prefix="dsh-docling-fixtures-"))
    manifest = generate(output.resolve())
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
