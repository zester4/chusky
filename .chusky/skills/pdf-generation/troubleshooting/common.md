# Common PDF failures

## Clipped text or tables
Reduce width pressure, use weighted columns, wrap cells, repeat headers, and avoid unbreakable strings.

## Orphan heading
Insert a deliberate page break or keep heading with the following paragraph/table.

## Missing image/logo
Verify the exact workspace-relative path before generation. Regenerate without the asset if it is unavailable.

## Missing glyphs
Use a known-safe font or embed a font with the required character coverage.

## Blank output
Check source content, renderer stderr, page boxes, transparency, and whether generation silently failed.

## Corrupt PDF
Recreate with a real PDF library. Do not patch arbitrary bytes.

## Form value invisible
Inspect appearance streams and `/NeedAppearances`.

## PDF opens but artifact registration fails
Treat registration as a quality gate. Inspect renderer/preflight output, recreate the artifact, then retry with the corrected file.
