# Disposable document fixtures

Run the generator when exercising a real parser runtime:

```powershell
python test/helpers/generate-document-fixtures.py
```

It prints a JSON manifest and writes to a newly-created system temporary
directory by default.  Tests should use their own temporary directory via
`--output`, then remove it in `afterEach`/`finally`.  Do not set its output to a
tracked fixture directory and do not add its PDF/Office/image output to Git.

The generated cases are deliberately small and contain stable sentinels:

| File | Capability asserted |
| --- | --- |
| `native.pdf` | PDF text extraction |
| `document.docx` | Word OOXML extraction |
| `workbook.xlsx` | Spreadsheet and Markdown table extraction |
| `slides.pptx` | PowerPoint OOXML extraction |
| `scanned.png` | Actual raster OCR |
| `scanned.pdf` | OCR fallback for an image-only PDF |

On Windows, the OCR image is rendered with GDI and an installed system font so
the Tesseract assertion can check the complete `DSH OCR 2026` sentinel.  Other
platforms use a deterministic bitmap-font fallback; their normal CI should
exercise protocol and format coverage, while the Windows runtime suite owns the
semantic OCR assertion.
