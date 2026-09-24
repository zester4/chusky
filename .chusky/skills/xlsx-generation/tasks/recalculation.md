# Recalculation and formula caches

Some `.xlsx` writers store formulas but do not compute cached values.

If downstream consumers need computed values immediately:
1. set formulas correctly;
2. save/export;
3. open/re-save with a compatible calculation engine such as LibreOffice when appropriate;
4. re-import/inspect or render to confirm results.

Do not replace formulas with values merely to make caches look current unless the user asks for a static workbook.

When using Chusky's `CHUCK_CREATE_SPREADSHEET` builder, provide formula cells in each sheet's optional `formulas` array (`cell`, `formula`, optional `expectedValue`). The Daytona registration gate recalculates XLSX through LibreOffice Calc and checks that each formula has a non-error cached result. Declared expected values are compared with that independently calculated result. This validates the calculation result against the supplied expectation; it does not validate the business assumption, source data, or formula design. See `docs/artifact-verification.md` for supported formula syntax and the evidence returned to callers.
