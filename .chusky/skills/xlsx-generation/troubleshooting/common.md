# Common spreadsheet failures

## Formula shows as text
The cell may be text-formatted or the formula was written as a value. Write it through the formula API and use an appropriate number format.

## `#REF!`
A referenced row/column/sheet was deleted or moved. Repair the formula references; do not hide the error with formatting.

## `#DIV/0!`
Guard the denominator when zero is legitimate, or fix missing inputs.

## Unexpected `#N/A`
Check lookup keys, whitespace, data types, and lookup ranges. Intentional chart `#N/A` should be documented.

## Dates sort incorrectly
They may be strings. Convert to real date values and apply a date format.

## Columns become huge after autofit
Cap widths after autofit, especially for URLs and long descriptions.

## Chart is blank
Confirm source cells are numeric and chart references point to populated rows.

## Dropdown does not work
Check the validation range/list and whether the edited cell is inside the validation target.

## Workbook opens with repair warning
Treat it as a structural failure. Recreate or repair the affected object rather than shipping it.
