# Merge and consolidate workbooks

Prefer consolidation into a new workbook.

For same-schema files:
- append rows with a source-file/source-period column;
- deduplicate only with an explicit rule;
- keep raw consolidated data separate from summaries.

For different schemas:
- map columns explicitly;
- do not guess silently;
- record transformations in a README/Notes sheet when useful.
