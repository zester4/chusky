# Create or edit a DOCX

## Golden path
1. Gather title, audience, purpose, source material, and any requested template/brand.
2. Create/edit with `python-docx`.
3. Define styles before writing large amounts of content.
4. Use semantic headings (`Heading 1`, `Heading 2`, etc.).
5. Use real tables for tabular material.
6. Use section/page breaks intentionally.
7. Add headers, footers, page numbers, and metadata only when useful.
8. Save to a new output path.
9. Run package inspection.
10. Render to page images and inspect every page.
11. Fix and repeat.
12. Deliver only the verified DOCX.

## Layout rules
Do not simulate spacing with repeated blank paragraphs. Avoid fixed-width hacks that break under another renderer. Use paragraph spacing, keep rules, table widths, and section properties.

## Long documents
Use a clear hierarchy, repeat table headers, keep headings with following content, and split major parts with deliberate page breaks.
