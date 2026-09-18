# Compare two DOCX files

Compare at two levels:
- structural/text difference;
- rendered-page difference.

Text diffs find wording changes. Render diffs find layout drift.

Use `scripts/render_and_diff.py` for page-image comparison. Treat pixel differences as signals; font rasterization can create harmless noise.
