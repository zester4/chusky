---
name: ffmpeg
description: Use this skill for media processing with ffmpeg/ffprobe — inspect, convert, trim, resize, compress, extract frames/audio, replace audio, mute, make GIFs, add subtitles/overlays, and combine videos. Triggers on 'combine these videos', 'merge my clips', 'join these videos together', 'put them end to end', 'stitch the clips into one video', 'concatenate these files', 'make one long video from these parts', 'append the second video to the first', 'chain these videos', 'compress video', 'extract audio', 'resize video', 'make gif', 'remove audio', 'thumbnail', 'storyboard', 'slideshow', 'social-media crop', 'codec settings', 'crf', 'preset', 'stream mapping', 'ffmpeg troubleshooting'.
---

# FFmpeg Skill

Powerful media processing using ffmpeg and ffprobe.

## Common tasks

### Inspect media
```bash
ffprobe -hide_banner -show_format -show_streams input.mp4
```

### Convert / compress
```bash
ffmpeg -i input.mp4 -c:v libx264 -crf 23 -preset medium -c:a aac output.mp4
```

### Trim
```bash
ffmpeg -ss 00:00:10 -to 00:00:30 -i input.mp4 -c copy trimmed.mp4
```

### Extract audio
```bash
ffmpeg -i input.mp4 -vn -c:a copy audio.aac
```

### Create GIF
```bash
ffmpeg -i input.mp4 -vf "fps=10,scale=480:-1:flags=lanczos" -loop 0 output.gif
```

### Concatenate videos
```bash
# Create a file list.txt with: file 'clip1.mp4' etc.
ffmpeg -f concat -safe 0 -i list.txt -c copy combined.mp4
```

### Extract frames
```bash
ffmpeg -i input.mp4 -vf fps=1 frame_%04d.png
```

## Best practices
- Prefer stream copy (`-c copy`) when no re-encoding is needed
- Use CRF for quality-based encoding (lower = better quality, larger file)
- Always check input properties with ffprobe first
- For social media, pay attention to resolution, aspect ratio, and duration limits
