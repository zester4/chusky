# Non-fillable forms

If the PDF is a static form with no interactive fields:
1. render the page;
2. identify target regions;
3. map image coordinates back to PDF points;
4. overlay text/checkmarks/signatures carefully;
5. regenerate;
6. inspect the final rendered page at readable zoom.

Keep a copy of the untouched original.
