---
name: xlsx-generation
description: "Create, edit, analyze, format, validate, recalculate, chart, dashboard, compare, and visually verify professional Microsoft Excel XLSX workbooks. Use whenever the user asks to create or modify a spreadsheet, financial model, tracker, dashboard, table, chart, budget, schedule, calculator, data-cleaning workbook, or Excel export."
---

# XLSX Generation and Verification

Treat spreadsheets as executable business artifacts, not painted grids. A workbook is not finished merely because an `.xlsx` file was written successfully.

## Preferred Chusky workflow

Use the available spreadsheet artifact/workbook API for workbook edits. Prefer block writes, formulas, tables, validation, conditional formatting, charts, and compact verification over per-cell loops.

For a normal workbook:
1. Understand the requested sheets, inputs, calculations, outputs, and audience.
2. Create or import the workbook.
3. Build the model with real formulas and explicit references.
4. Apply number/date formats, widths, wrapping, hierarchy, freeze panes, validation, and conditional formatting.
5. Add tables/charts/dashboard elements only when they improve usability.
6. Inspect key ranges including values and formulas.
7. Scan for formula errors.
8. Render important sheets/ranges and inspect them visually.
9. Export a single final `.xlsx`.
10. Deliver only the verified workbook.

When editing an uploaded/template workbook, inspect and preserve its existing structure and visual language unless the user explicitly requests a redesign.

## Routing

- Create/edit workbooks: `tasks/create_edit.md`
- Read/review/analyze: `tasks/read_review.md`
- Formulas and references: `tasks/formulas.md`
- Formatting/layout: `tasks/formatting.md`
- Tables: `tasks/tables.md`
- Charts: `tasks/charts.md`
- Dashboards/KPIs: `tasks/dashboards.md`
- Pivot-table strategy: `tasks/pivots.md`
- Data validation: `tasks/data_validation.md`
- Conditional formatting: `tasks/conditional_formatting.md`
- Named ranges: `tasks/named_ranges.md`
- Dates/numbers/currency: `tasks/dates_numbers.md`
- Import/export/CSV: `tasks/import_export.md`
- Recalculation/formula caches: `tasks/recalculation.md`
- Render/visual QA: `tasks/render_verify.md`
- Financial models: `tasks/financial_models.md`
- Protection and locked cells: `tasks/protection.md`
- Notes/comments: `tasks/comments_notes.md`
- Hyperlinks and source columns: `tasks/hyperlinks_sources.md`
- Large datasets: `tasks/large_data.md`
- Templates/style preservation: `tasks/templates.md`
- Compare workbooks: `tasks/compare.md`
- Merge/consolidate workbooks: `tasks/merge_consolidate.md`
- Privacy/metadata: `tasks/privacy_metadata.md`

Troubleshooting guides live under `troubleshooting/`. Helper scripts live under `scripts/`.

## Quality floor

A production-facing spreadsheet should have:
- meaningful sheet names;
- no accidental blank default sheets;
- formulas for derived values rather than hard-coded outputs;
- correct relative/absolute references;
- sensible number/date/currency/percentage formats;
- readable widths and row heights;
- no unconstrained autofit that creates extreme dimensions;
- frozen headers for long tables where useful;
- validation for editable categorical inputs where practical;
- conditional formatting only when it communicates something useful;
- unique table/chart names;
- no obvious `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, or unexpected `#N/A`;
- at least one visual summary for trackers/plans when it meaningfully helps;
- source URLs in cells or comments when researched/financial inputs depend on external sources.

## Formula discipline

Prefer formulas over manual values for derived logic. Keep important assumptions in dedicated input cells instead of hiding magic numbers inside formulas.

Examples:
- Good: `=H6*(1+$B$3)`
- Weak: `=H6*1.15`

Use absolute references for assumptions that must stay fixed when formulas are filled.

When a formula function is unsupported by the workbook engine, use a compatible equivalent rather than leaving broken formulas.

## Verification

Before delivery:
1. Inspect key ranges with values and formulas.
2. Scan the workbook for formula-error tokens.
3. Render important sheets/ranges after style changes.
4. Check charts do not overlap data.
5. Confirm editable cells, dropdowns, dates, and formulas behave as intended.
6. Export exactly one final `.xlsx` unless the user asks for variants.

## Security

Do not put passwords, API keys, access tokens, private credentials, or unrelated private memory in a workbook. For external research, store normal source URLs, not authenticated URLs or secrets.

## Safe defaults

When the user does not specify:
- headers: bold, clear fill, readable contrast;
- body font: normal spreadsheet default or a compatible sans-serif;
- content columns: roughly 10–24 characters wide;
- text-heavy columns: cap around 32–40;
- titles may be larger; body text should remain compact;
- dates should be real dates with formats such as `yyyy-mm-dd`;
- percentages and currency should use proper number formats;
- wrap text for long text columns;
- freeze the header row for long tables;
- use light borders and restrained fills rather than decorating every cell.

## Helper scripts

The bundled scripts focus on structural inspection, LibreOffice recalculation/rendering, and ZIP/XML diagnostics. They do not replace the spreadsheet artifact/workbook API for authoring.
