# PDF smoke test

Use this minimal end-to-end test after changing PDF behavior.

1. Create a 3-page PDF with:
   - title and body text;
   - a multi-row table that can cross a page boundary;
   - one chart or image;
   - header/footer and page numbers.
2. Reopen with pypdf.
3. Assert page count is 3 or the intentionally expected value.
4. Run `scripts/pdf_preflight.py`.
5. Run `scripts/render_pdf.py`.
6. Confirm every page image exists and is non-empty.
7. Inspect every page for clipping, missing content, table/header problems, and unreadable chart labels.
8. Extract text with `scripts/pdf_extract.py` and confirm key phrases are present.
9. If any gate fails, do not register/deliver the artifact.
