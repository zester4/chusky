# Run splitting and text replacement

Word may split visible text across multiple `<w:r>` runs because of formatting, revisions, fields, bookmarks, or proofing metadata.

A naive `paragraph.text.replace(...)` can destroy formatting or fail to find text.

For sensitive replacements:
1. concatenate visible run text;
2. map character offsets back to runs;
3. replace only the affected spans;
4. preserve formatting where possible;
5. inspect headers, footers, tables, text boxes, comments, and other parts separately.

For complex documents, prefer OOXML-aware replacement.
