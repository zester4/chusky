# Footnotes and endnotes

`python-docx` does not fully support creating true footnotes/endnotes through its high-level API.

For real notes:
- use targeted OOXML parts and relationships;
- assign unique note IDs;
- add references in document XML;
- update content types/relationships as necessary;
- verify in Word-compatible rendering.

For simple reports where true notes are unnecessary, end-of-document notes may be more robust.
