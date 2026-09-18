# Create or edit an XLSX workbook

## New workbook
1. Create the workbook and explicitly add the required sheets.
2. Write data in blocks, not one cell at a time.
3. Create formulas once and fill down/right.
4. Format headers, numbers, dates, widths, wrapping, and alignment.
5. Add validation/conditional formatting where it improves data entry or interpretation.
6. Add tables/charts only after the core ranges are stable.
7. Inspect key ranges.
8. Scan for formula errors.
9. Render the important area(s).
10. Export one final `.xlsx`.

## Existing workbook
Import the original workbook, inspect its sheets/ranges, and preserve formulas and style unless the user asks to change them. Do not rebuild the workbook from scratch unless necessary.
