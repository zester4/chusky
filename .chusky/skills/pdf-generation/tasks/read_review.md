# Read and review a PDF

Use text extraction for content questions, but use page rendering for layout questions.

## Review sequence
1. Inspect metadata, encryption, page count, and page dimensions.
2. Extract text to understand document structure.
3. Render all relevant pages to images.
4. Inspect for overflow, clipping, blank pages, broken glyphs, tiny text, bad page breaks, table splits, and image failures.
5. If the user asks for a full quality review, check every page rather than sampling.

Do not use OCR when normal text extraction works. OCR is a fallback for scans or image-only pages.
