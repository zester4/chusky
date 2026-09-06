# Editing Existing Word Documents / Templates

**Read this entire file before editing any .docx or .dotx template.**

## Workflow Overview

1. **Unpack** the document
2. **Edit** using the provided scripts (never hand-edit XML if a script exists)
3. **Pack** and validate

```bash
python scripts/office/unpack.py input.docx unpacked/
# ... make changes ...
python scripts/office/pack.py unpacked/ output.docx --original input.docx
```

## Critical Rules

- Always edit the **unpacked** version
- Prefer the helper scripts over raw XML edits
- After packing, the output is validated automatically
- Use smart quotes (`&#x201C;` `&#x201D;` `&#x2018;` `&#x2019;`) for professional typography
- Keep original formatting (copy `<w:rPr>` blocks when doing tracked changes)

## Available Scripts

| Script | Purpose |
|--------|---------|
| `scripts/office/unpack.py` | Extract and pretty-print a .docx/.dotx |
| `scripts/office/pack.py` | Repack + validate + auto-repair |
| `scripts/office/validate.py` | Standalone validation |
| `scripts/replace_text.py` | Find-and-replace text while preserving runs |
| `scripts/replace_field.py` | Replace content control / field values |
| `scripts/delete_sections.py` | Remove sections by heading or bookmark |
| `scripts/comment.py` | Add comments / replies |
| `scripts/accept_changes.py` | Accept all tracked changes |
| `scripts/list_sections.py` | List document structure |
| `scripts/inspect_*.py` | Inspect tables, headers, etc. |

## Common Editing Patterns

### Simple Text Replacement
```bash
python scripts/replace_text.py unpacked/ "Old text" "New text"
```

### Adding a Comment
```bash
python scripts/comment.py unpacked/ 0 "This needs review"
# Then manually add the commentRange markers in document.xml if needed
```

### Accepting Tracked Changes
```bash
python scripts/accept_changes.py input.docx clean.docx
```

## Pitfalls to Avoid

- Do **not** create a new document from scratch when a template exists
- Do **not** edit the original .docx binary directly
- Do **not** forget to re-pack after changes
- Watch for smart-quote entities when inserting new text
- When deleting an entire paragraph, also delete the paragraph mark

For the full technical reference (XML patterns, tracked changes, comments, images), see the main `SKILL.md`.
