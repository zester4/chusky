# Compare PDFs

Use both structural and visual comparison.

Structural checks:
- page count and page sizes;
- metadata if relevant;
- text extraction differences;
- annotations/forms/links count.

Visual checks:
1. render both PDFs at the same DPI;
2. normalize image sizes;
3. compare page by page;
4. flag pages with meaningful pixel differences;
5. inspect flagged pages manually.

Pixel differences are signals, not conclusions: font rasterization and antialiasing can create harmless noise.
