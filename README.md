# PhotoStitch

Browser-only tool that stitches overlapping screenshots (e.g. Google Maps / satellite tiles) into one montage PNG.

Images never leave your machine. Order does not matter — tiles are matched by edge overlap, shown live in the montage, and (optionally) accepted or rejected one at a time.

## Use it

1. Open [index.html](index.html) locally, or visit the GitHub Pages URL.
2. Drop PNG/JPEG screenshots (same zoom, generous overlap).
3. Use the **crop preview**: raise **Crop edges** until map UI chrome (logo, buttons, scale) sits in the hatched discard zone. Crop is a fixed trim on all four sides — it is **not** overlap detection.
4. Keep **Review each tile** on (recommended). Click **Stitch**.
5. Watch the montage build. When a dashed outline appears, **Accept (A)** or **Reject (R)** that join. Use **Accept rest** to finish automatically, or **Stop** to keep what you have.
6. **Download PNG**.

While searching, the preview refreshes about every **5 seconds** so you can see progress on large batches.

### Tips

- Prefer PNG screenshots at the **same zoom level**.
- Aim for ~20–40% overlap between neighboring shots.
- **Crop:** only as much as needed to remove chrome. Too much crop can remove the unique strip that neighbors share.
- **Confidence:** default ~0.85 works for near-identical overlaps. Lower it only if true neighbors fail to link; very low values risk wrong joins on repetitive terrain (fairways, water) — review mode catches those.
- **Search scale:** Balanced is the usual choice. Fast for large batches; Accurate when pairs are missed.
- Mixed zooms or rotated shots will not line up.

## How it works

1. Crops a fixed margin from each image (see crop preview).
2. Starts from the largest tile as the seed montage.
3. Finds the best unmatched tile via **edge-strip** matching against already-accepted tiles (multi-patch consensus + overlap verification).
4. Shows the candidate on the live montage (dashed outline) for Accept/Reject.
5. Rejected joins are skipped; the search tries another attachment. Unmatched tiles are marked at the end.

## Develop

No build step. Serve statically if you want modules over `file://` without browser quirks:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## License

MIT
