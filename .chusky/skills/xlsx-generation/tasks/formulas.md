# Formulas and references

Use formulas for all derived values.

## Rules
- Use `$` absolute references for fixed assumptions.
- Use relative references for row/column logic that should fill.
- Prefer dedicated assumption cells to constants embedded in formulas.
- Seed one formula then fill down/right where possible.
- Keep formulas readable and auditable.
- Avoid volatile functions unless necessary.
- Watch for off-by-one totals and ranges that stop before new data.

## Error scan
Search for:
`#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#N/A`.

An intentional `#N/A` used to suppress chart points should be documented.
