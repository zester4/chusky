# Import/export and CSV

For large flat datasets, CSV import can be faster than many cell writes.

When importing:
- preserve headers;
- detect dates/numbers deliberately;
- avoid silently converting IDs with leading zeros;
- keep source/raw data separate from transformed output when useful.

When exporting:
- deliver `.xlsx` by default;
- export CSV only when the user requests a flat file or interoperability requires it.
