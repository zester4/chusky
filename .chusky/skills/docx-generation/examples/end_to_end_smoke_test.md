# DOCX end-to-end smoke test

Use this after changing DOCX generation or artifact handling.

1. Create a 4-page test DOCX containing:
   - a title page;
   - Heading 1/2 hierarchy;
   - body paragraphs;
   - a table long enough to cross a page;
   - one image;
   - header/footer and page numbers;
   - a page break and at least one section break.
2. Run `scripts/docx_inspect.py`.
3. Render with `scripts/render_docx.py`.
4. Confirm every expected PNG exists.
5. Inspect every page for clipping, table splits, missing images, numbering drift, and orphan headings.
6. Run `scripts/style_lint.py`.
7. If comments/tracked changes are involved, run their structural checks too.
8. Do not register/deliver if any gate fails.
