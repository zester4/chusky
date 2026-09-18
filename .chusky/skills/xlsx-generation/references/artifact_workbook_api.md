# Workbook API operating principles

Use the workbook artifact API for edits.

High-value patterns:
- create workbook, then add sheets explicitly;
- write rectangular blocks;
- seed formulas once then fill down/right;
- style ranges rather than individual cells;
- use real date/numeric values;
- use tables with unique names;
- position charts so they do not cover data;
- inspect key ranges with values/formulas;
- scan for formula errors;
- render only the relevant region/sheet for QA;
- export one final `.xlsx`.

When an advanced feature is unclear, use targeted API help rather than broad experimentation.
