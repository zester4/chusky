# XLSX end-to-end smoke test

Use this after changing spreadsheet generation or artifact handling.

1. Create a workbook with:
   - `Inputs` sheet containing editable assumptions and validation;
   - `Data` sheet with at least 25 rows in a real table;
   - formula columns using relative and absolute references;
   - date, currency, percentage, and integer formats;
   - one conditional-format rule;
   - `Dashboard` sheet with at least three KPIs and one chart.
2. Inspect `Dashboard!A1:H20` including values and formulas.
3. Inspect a representative `Data` range.
4. Scan for formula errors.
5. Render the Dashboard and the top of the Data sheet.
6. Confirm chart labels and table headers are readable and no drawing covers data.
7. Export one final `.xlsx`.
8. Run `scripts/xlsx_inspect.py` and `scripts/xlsx_error_token_scan.py`.
9. If downstream cached results matter, run LibreOffice recalculation in a copy and inspect again.
10. Do not deliver if a key formula, layout, or structural check fails.
