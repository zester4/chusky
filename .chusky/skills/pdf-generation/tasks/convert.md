# Convert to PDF

Choose the source-native path:
- DOCX/PPTX/XLSX: use LibreOffice/soffice headless when available.
- HTML: prefer Chromium print or WeasyPrint.
- Markdown: render through HTML or Pandoc.
- LaTeX: use Tectonic or pdflatex.

After conversion, do not trust success status alone. Reopen the PDF, run preflight, render every page, and inspect output.

When fidelity matters, compare the source rendering and PDF rendering for:
- page breaks;
- fonts and missing glyphs;
- table widths;
- images;
- headers/footers;
- links;
- charts.

Never overwrite the source unless the user explicitly asks.
