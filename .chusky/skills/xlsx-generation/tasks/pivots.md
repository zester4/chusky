# Pivot-table strategy

Pivot APIs can vary by workbook engine. Prefer a pivot only when the workbook API supports it reliably.

If pivot creation is unsupported or brittle:
- create a formula-driven summary table using `SUMIFS`, `COUNTIFS`, or equivalent;
- build charts from that summary.

Never leave a half-created or stale pivot cache. If using a template with existing pivots, preserve them unless the user requests a change and the engine supports it.
