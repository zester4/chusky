# Extract content from PDFs

Prefer native PDF text extraction first.

Capture as needed:
- text by page;
- document metadata;
- links/annotations;
- form fields;
- images;
- page dimensions;
- tables where structure can be inferred reliably.

For tables, preserve row/column semantics and mark uncertain extraction instead of silently reshaping data.

For image-only pages, route to OCR. For mixed pages, use native text where possible and OCR only the missing regions/pages.
