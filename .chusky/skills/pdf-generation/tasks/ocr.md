# OCR scanned PDFs

Use OCR only when native extraction is absent or unusable.

Recommended flow:
1. detect pages with little/no extractable text;
2. render only those pages at suitable DPI;
3. OCR once per page;
4. preserve page order;
5. store OCR text separately unless the user explicitly wants a searchable PDF layer;
6. mark low-confidence or ambiguous text.

Avoid repeatedly OCRing the same page. OCR can introduce substitutions, especially for numbers, tables, and non-English text.
