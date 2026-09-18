---
name: docx-generation
description: "Create, edit, review, redline, comment on, merge, validate, render, and visually verify professional Microsoft Word DOCX artifacts. Use whenever the user asks to create or modify a Word document, report, proposal, contract, letter, manual, template, form, redline, tracked-change document, or DOCX conversion."
---

# DOCX Generation and Verification

Treat Word documents as rendered artifacts, not just ZIP/XML packages. A DOCX is not finished merely because `python-docx` saved it successfully.

## Preferred Chusky workflow

For normal Word documents:
1. Author or edit with `python-docx`.
2. Define page size, margins, styles, headings, tables, headers/footers, spacing, and numbering deliberately.
3. Save to a new DOCX.
4. Inspect the package structure.
5. Render the DOCX to PDF/PNG using LibreOffice or another deterministic Word-compatible renderer.
6. Inspect every rendered page for layout defects.
7. Fix and re-render until clean.
8. Register/deliver only the latest verified DOCX.

For comments, tracked changes, content controls, true fields, advanced hyperlinks, or other unsupported Word features, use targeted OOXML patches only after ordinary `python-docx` editing is complete.

## Routing

- Create/edit documents: `tasks/create_edit.md`
- Read/review existing DOCX: `tasks/read_review.md`
- Render and visually verify: `tasks/verify_render.md`
- Accessibility: `tasks/accessibility.md`
- Comments: `tasks/comments.md`
- Tracked changes/redlines: `tasks/tracked_changes.md`
- Styles and normalization: `tasks/styles.md`
- Tables and spreadsheet imports: `tasks/tables.md`
- Headings, numbering, TOC: `tasks/headings_toc.md`
- Sections/page layout: `tasks/sections_layout.md`
- Images/figures/captions: `tasks/images_figures.md`
- Hyperlinks/bookmarks/fields: `tasks/navigation_fields.md`
- Forms/content controls: `tasks/forms_content_controls.md`
- Privacy/metadata scrubbing: `tasks/privacy_metadata.md`
- Redaction/anonymization: `tasks/redaction.md`
- Merge multiple DOCX files: `tasks/merge.md`
- Compare two DOCXs: `tasks/compare.md`
- Templates/style packs: `tasks/templates.md`
- Watermarks/protection: `tasks/watermarks_protection.md`
- Footnotes/endnotes: `tasks/footnotes_endnotes.md`

OOXML notes live under `ooxml/`. Helper scripts live under `scripts/`.

## Non-negotiable quality gate

Before delivering a meaningful DOCX:
- confirm the file is a valid OOXML ZIP;
- confirm required parts exist;
- render it;
- inspect every rendered page at readable scale;
- fix clipping, overlap, broken tables, bad page breaks, orphan headings, missing glyphs, missing images, bad headers/footers, and inconsistent numbering;
- re-render after every layout-sensitive or OOXML-level patch.

Do not claim visual quality from XML inspection alone.

## Content integrity

Do not invent facts or expand thin source material merely to make a document look substantial. Keep estimates, dates, citations, metric definitions, and uncertainty clear.

## Security

Never place passwords, API keys, private tokens, unrelated private memory, or secret configuration into generated documents. Scrub personal metadata when requested. Redaction must remove or replace content, not merely cover it visually.

## Safe defaults

Prefer:
- Letter or A4 as appropriate;
- 0.7–1.0 inch margins unless the user specifies otherwise;
- built-in fonts with broad compatibility;
- 10.5–12 pt body text;
- Word heading styles instead of manual bold text;
- table header repetition for long tables;
- `keep_with_next` for headings;
- explicit page breaks between major parts, not repeated blank paragraphs;
- verified image dimensions and aspect ratios;
- restrained headers/footers and page numbers.

## Optional dependencies

Useful tools include Python 3, `python-docx`, `lxml`, Pillow, LibreOffice/soffice, Poppler, PyMuPDF, `openpyxl`, and standard ZIP/XML tools. Detect dependencies before relying on them and fail with a useful message rather than silently degrading.
