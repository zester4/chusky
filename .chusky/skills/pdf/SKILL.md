---
name: pdf
description: Read, create, and transform PDF files. Covers pulling text and tables out of PDFs, generating new PDFs, merging and splitting documents, rotating pages, watermarking, encrypting or removing passwords, extracting embedded images, running OCR on scanned documents, and filling out PDF forms including official tax forms. Apply this skill whenever a task involves a .pdf file as input or deliverable.
---

# PDF Skill

This skill covers reading, creating, editing, and transforming PDF files.

## When to use

Use this skill for any task involving PDF files:
- Extracting text or tables
- Creating new PDFs
- Merging / splitting
- Rotating, watermarking, encrypting
- OCR on scanned documents
- Filling PDF forms

See companion files:
- `forms.md` for form filling
- `reference.md` for detailed technical reference

## Core tools

- `pdftotext`, `pdftoppm`, `pdfinfo` (poppler)
- `qpdf` for structural operations
- Python libraries: `pypdf`, `reportlab`, `pdf2image`, `pytesseract` for OCR
- LibreOffice for conversions via `scripts/office/soffice.py`

## Common workflows

### Extract text
```bash
pdftotext -layout input.pdf output.txt
```

### Convert to images
```bash
pdftoppm -jpeg -r 150 input.pdf page
```

### Merge PDFs
```bash
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf
```

### Create new PDF
Use reportlab or similar in Python for full control over layout, fonts, and graphics.

### Form filling
See `forms.md` for detailed guidance on AcroForm and XFA forms.

## Best practices

- Always validate the resulting PDF
- Prefer lossless operations when possible
- For scanned documents, run OCR before text extraction
- Keep original files when doing destructive operations
