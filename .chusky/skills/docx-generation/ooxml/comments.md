# OOXML: comments

Comments require:
- `/word/comments.xml`;
- relationship from document part;
- content-type declaration;
- anchors in the document (`commentRangeStart`, `commentRangeEnd`, `commentReference`).

IDs must be unique and anchors must be balanced. Headless renderers may omit comments, so structural validation is required in addition to visual QA.
