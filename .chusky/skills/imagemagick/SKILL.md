---
name: imagemagick
description: Image manipulation using ImageMagick. Use for resizing, cropping, converting formats, applying effects, compositing, batch processing, creating montages, adding text/watermarks, and other image transformations.
---

# ImageMagick Skill

Use the `magick` (or `convert`) command for powerful image processing.

## Common operations

### Resize
```bash
magick input.jpg -resize 800x600 output.jpg
magick input.jpg -resize 50% output.jpg
```

### Convert format
```bash
magick input.png output.jpg
```

### Crop
```bash
magick input.jpg -crop 400x300+100+50 output.jpg
```

### Add text / watermark
```bash
magick input.jpg -gravity southeast -pointsize 24 -fill white -annotate +20+20 "Watermark" output.jpg
```

### Create montage
```bash
magick montage img1.jpg img2.jpg img3.jpg -geometry +4+4 montage.jpg
```

### Batch process
```bash
magick mogrify -resize 50% -path ./resized *.jpg
```

## Tips
- Prefer `magick` over the older `convert` command
- Use `-quality` for JPEG compression control
- For transparency, prefer PNG or WebP
- Always preserve aspect ratio unless intentionally distorting
