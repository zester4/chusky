# Render and visually verify DOCX

The final QA loop is:
1. render DOCX to PDF using LibreOffice/soffice;
2. rasterize PDF pages to PNG;
3. inspect every page;
4. fix source DOCX;
5. repeat until clean.

Inspect for:
- clipped/overlapping text;
- blank or duplicated pages;
- orphan headings;
- broken tables and split rows;
- tiny text;
- missing fonts/glyphs;
- missing or distorted images;
- page-number/header/footer drift;
- unexpected landscape/portrait switches;
- bad numbering or TOC alignment.

Use `scripts/render_docx.py`.
