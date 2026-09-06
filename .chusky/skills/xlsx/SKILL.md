---
name: xlsx
description: Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user mentions 'Excel', 'spreadsheet', 'xlsx', 'workbook', or references a spreadsheet file by name or path — even casually (like 'the xlsx in my downloads') — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved.
---

# XLSX / Spreadsheet Skill

## When to use

- Creating new .xlsx workbooks
- Reading / analyzing existing spreadsheets
- Editing, cleaning, or transforming data
- Adding formulas, charts, formatting
- Converting between CSV / TSV / XLSX

## Core approach

Prefer the `openpyxl` library for .xlsx files and the standard `csv` module for CSV/TSV.

### Reading
```python
from openpyxl import load_workbook
wb = load_workbook("file.xlsx")
ws = wb.active
for row in ws.iter_rows(values_only=True):
    print(row)
```

### Creating
```python
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill

wb = Workbook()
ws = wb.active
ws.title = "Sheet1"
ws["A1"] = "Header"
ws["A1"].font = Font(bold=True)
wb.save("output.xlsx")
```

### Best practices
- Always set proper column widths
- Use typed values (numbers, dates) instead of strings when possible
- Prefer formulas over calculated static values when the spreadsheet will be used interactively
- Clean headers and remove empty rows/columns
- Validate data types and handle missing values explicitly
