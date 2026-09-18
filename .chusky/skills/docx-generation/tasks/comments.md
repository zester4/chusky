# Comments

Comments are review metadata and may not appear in headless PDF rendering.

For comment workflows:
1. inspect `word/comments.xml`;
2. map comments to range start/end/reference anchors;
3. preserve author/date only when appropriate;
4. add/modify/remove comments through OOXML carefully;
5. validate relationships/content types;
6. re-open the DOCX and render for general layout;
7. separately verify comment XML/anchors structurally.

Use `scripts/comments_extract.py` and `scripts/comments_strip.py` for common operations.
