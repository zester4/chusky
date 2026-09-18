# PDF coordinates

PDF coordinate systems vary by library. Confirm origin and units before stamping, annotating, cropping, or redacting.

Common facts:
- PDF points are normally 72 points per inch.
- Some APIs use bottom-left origin; rendered images often use top-left.
- Rotation and CropBox/MediaBox can change apparent coordinates.

Before a coordinate-sensitive edit:
1. inspect page boxes and rotation;
2. render a page with test markers;
3. transform coordinates explicitly;
4. verify final output visually.
