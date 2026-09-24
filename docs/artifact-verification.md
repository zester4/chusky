# Generated Office and PDF artifact verification

Chusky runs verification in Daytona before an artifact is promoted into the durable artifact registry. A failed structural, content, calculation, or rendering check prevents registration and delivery.

## What is checked

- **DOCX and PDF builders:** the generated title must appear in text extracted from the rendered PDF. The file is parsed and every page is rasterized and checked for blank output. DOCX package structure is also validated. This is an automated content-presence and renderability check, not a proof that every section is complete or factually correct.
- **XLSX:** the OOXML package is structurally validated and rendered. LibreOffice Calc opens and re-saves the workbook as XLSX; Chusky then inspects that recalculated package. Every formula must have a non-error cached result. Formula errors and missing formula results fail verification. The optional `expectedValue` on a formula cell is compared with the independently recalculated value (numeric values use a small floating-point tolerance).
- **Other Office types:** package structure and page rendering are checked. They do not currently receive the generated-title or formula-value comparisons described above.

Verification evidence is returned with successful generated-artifact results as bounded metadata: artifact type, rendered page count, extracted character count, whether a generated title was checked/matched, formula-cell and formula-value counts, expected-value comparison count, and formula-error count. Full extracted contents and workbook cell values are not copied into durable artifact metadata or logs.

## Spreadsheet formula inputs

`CHUCK_CREATE_SPREADSHEET` accepts an optional `formulas` array on each sheet. The `cell` address must target an unmerged data-row cell in that sheet's table. Use JSON numbers and booleans in source rows when they are numeric/logical inputs; string cells remain text. `formula` may include a leading equals sign and is limited to basic arithmetic plus `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `IF`, `ROUND`, `ABS`, `AND`, and `OR`. External references, volatile functions, and unsupported syntax are rejected. `expectedValue` is optional and may be a string, finite number, or boolean.

Example:

```json
{
  "name": "Overview",
  "rows": {
    "headers": ["Item", "Amount", "Total"],
    "rows": [["Revenue", 100, ""]]
  },
  "formulas": [
    { "cell": "C4", "formula": "SUM(B4:B4)", "expectedValue": 100 }
  ]
}
```

The expectation is a verification assertion, not evidence that the business rule or expected number is correct. Chusky independently checks what the formula calculates; users should still review assumptions, source data, and model logic. Formula checks require the configured Office renderer to include LibreOffice Calc; verification fails closed if calculation or inspection is unavailable.

For arbitrary files passed through `CHUCK_ARTIFACT`, Chusky has no trusted source manifest to compare against. It validates structure and renderability and reports extracted-text counts, but does not claim semantic equivalence to an intended document. Image-only PDFs remain valid when no generated title baseline is supplied.
