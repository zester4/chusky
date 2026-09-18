# Merge multiple DOCX files

Naive paragraph copying can lose styles, numbering, images, relationships, headers/footers, and section behavior.

For simple documents, append paragraphs/tables with `python-docx` carefully.
For complex source documents, prefer a robust package-aware merge method.

Always preserve source files, write a new output, inspect section boundaries, then render every page.

Use `scripts/merge_docx_append.py` only for simple merges.
