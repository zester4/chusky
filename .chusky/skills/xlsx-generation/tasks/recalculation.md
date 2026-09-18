# Recalculation and formula caches

Some `.xlsx` writers store formulas but do not compute cached values.

If downstream consumers need computed values immediately:
1. set formulas correctly;
2. save/export;
3. open/re-save with a compatible calculation engine such as LibreOffice when appropriate;
4. re-import/inspect or render to confirm results.

Do not replace formulas with values merely to make caches look current unless the user asks for a static workbook.
