# Cross-renderer parity

For production documents, a PDF that renders only in one library is risky.

When possible, compare:
- PyMuPDF render;
- Poppler (`pdftoppm`);
- LibreOffice conversion result for Office-originated documents.

Investigate missing fonts, transparency, malformed images, page-box differences, and unsupported objects when renderers disagree.
