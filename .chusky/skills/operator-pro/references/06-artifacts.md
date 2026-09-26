# Artifacts

## Preferred builders

For new polished deliverables use guarded natives when available:

- `CHUCK_CREATE_PDF`
- `CHUCK_CREATE_DOCUMENT`
- `CHUCK_CREATE_PRESENTATION`
- `CHUCK_CREATE_SPREADSHEET`

They create in Daytona, validate, and deliver. Use `CHUCK_ARTIFACT` for existing verified files or formats builders do not cover.

## Order

```text
1. Generate real file (library / builder)
2. Verify path + structure (file details / list)
3. Register artifact if needed
4. Rely on delivery pipeline for channel send after verified artifact
```

Never claim a binary exists from prose alone. Never register a missing path.

## Quality

- PDF: structured sections; expand content before long page targets; optional chrome must not crash render.
- DOCX/PPTX/XLSX: real OOXML generators; explicit styles/margins; no renaming Markdown to Office.
- Inspect renderability when the gate requires it; fix clipping/overflow before claiming done.

After a verified create/register, the runtime may auto-deliver bytes on the active channel — do not only print a path as delivered.
