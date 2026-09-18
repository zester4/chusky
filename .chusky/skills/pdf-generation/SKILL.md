---
name: pdf-generation
description: "Create, convert, inspect, edit, extract, compare, redact, OCR, preflight, and visually verify professional PDF artifacts. Use whenever the user asks to create or modify a PDF, convert a document to PDF, review PDF layout, extract PDF content, fill or debug PDF forms, redact sensitive content, or verify a generated PDF before delivery."
---

# PDF Generation and Verification

Treat PDF work as an artifact pipeline, not a single render command. The goal is a document that is structurally valid, visually readable on every page, faithful to the user's source material, and honestly described.

## Preferred Chusky path

For a new structured PDF, prefer `CHUCK_CREATE_PDF`. It already supports headings, body text, bullets, tables, charts, images, page breaks, branding, headers, footers, page numbers, structural validation, and page-by-page rendering.

Before calling it:
1. Expand the source into substantive sections. Do not pad a thin outline merely to hit a requested page count.
2. Choose page size, margins, hierarchy, table widths, and deliberate page breaks.
3. Use verified workspace-relative image/logo paths only.
4. Keep metrics, dates, units, citations, and uncertainty labels explicit.

After creation:
1. Inspect exact output-file details.
2. Render every page and inspect the rendered pages visually.
3. Fix clipping, overflow, missing glyphs/images, broken table rows, orphan headings, unreadable charts, and bad page breaks.
4. Run structural preflight.
5. Register/deliver only the verified artifact.

For an existing PDF, conversion workflow, forms, OCR, redaction, or comparison, read the matching file under `tasks/`.

## Routing

- New polished report/playbook: `tasks/create.md`
- Convert DOCX/HTML/Markdown/LaTeX: `tasks/convert.md`
- Read/review layout: `tasks/read_review.md`
- Extract text/tables/images: `tasks/extract.md`
- Coordinate-sensitive stamping: `tasks/coords.md`
- Merge/split/crop/watermark/reorder: `tasks/edit.md`
- Visual regression: `tasks/compare.md`
- Fillable forms: `tasks/forms_annotations.md`
- Form debugging: `tasks/forms_debugging.md`
- Non-fillable forms: `tasks/forms_nonfillable.md`
- OCR scanned PDFs: `tasks/ocr.md`
- Structural checks: `tasks/preflight.md`
- True redaction: `tasks/redact.md`
- Cross-renderer parity: `tasks/parity.md`
- Batch operations: `tasks/batch.md`
- Node PDF.js/pdf-lib notes: `tasks/js_tools.md`
- Common failures: `troubleshooting/common.md`
- Minimal end-to-end check: `examples/smoke_test.md`

Helper scripts are in `scripts/`. They are fallbacks and diagnostics; native Chusky artifact tools remain preferred when available.

## Quality gates

Never call a PDF "done" solely because a library wrote bytes successfully. A production-facing PDF passes only when:
- the file reopens;
- page count and page sizes are plausible;
- no unexpected encryption or malformed objects are present;
- fonts/images required for readability render;
- all pages render successfully;
- every rendered page has been inspected for clipping/overflow;
- tables repeat headers when needed and rows do not split badly;
- charts have legible labels and units;
- links/annotations/forms behave as expected;
- sensitive redaction removes underlying content rather than covering it visually;
- the delivered filename/path is the verified file.

## Content integrity

Do not invent source facts to make a document look complete. Preserve distinctions such as actual revenue vs ARR/run-rate, WAU vs MAU, estimate vs audited figure, and observed fact vs inference. If a requested value is unknown, say so in the artifact.

## Security

Do not embed credentials, secrets, private keys, session tokens, or unrelated private memory into documents. Use temporary working files inside the scoped workspace. For redaction, verify that removed text is no longer extractable.

## Dependencies

Useful optional tools include Python 3, ReportLab, pypdf, PyMuPDF (`fitz`), Pillow, LibreOffice/soffice, Poppler (`pdfinfo`, `pdftoppm`), WeasyPrint, Pandoc, Tectonic/pdflatex, PDF.js, and pdf-lib. Detect availability before relying on them and fail with an actionable message rather than silently degrading.
