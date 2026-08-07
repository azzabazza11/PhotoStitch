# PhotoStitch

Browser-only tool that stitches overlapping screenshots (e.g. Google Maps / satellite tiles) into one montage PNG.

Images never leave your machine. Order does not matter — each tile is matched by pixel overlap.

## Use it

1. Open [index.html](index.html) locally, or visit the GitHub Pages URL once published.
2. Drop PNG/JPEG screenshots (same zoom, generous overlap).
3. Set **Crop edges** high enough to remove map UI chrome (logo, buttons, scale bar).
4. Click **Stitch**, then **Download PNG**.

### Tips

- Prefer PNG screenshots at the **same zoom level**.
- Aim for ~20–40% overlap between neighboring shots.
- If some tiles fail: lower **Match confidence**, try **Accurate** search scale, or reduce crop if you cropped into unique map content.
- Mixed zooms or rotated shots will not line up.

## How it works

1. Crops a fixed margin from each image.
2. Starts from the largest tile as the base mosaic.
3. For every remaining tile, searches for near-identical patches with multi-scale normalized cross-correlation (NCC).
4. Pastes the best match above the confidence threshold and repeats until nothing else fits.

## Develop

No build step. Serve statically if you want modules over `file://` without browser quirks:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## License

MIT
