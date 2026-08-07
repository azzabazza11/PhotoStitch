# PhotoStitch

Browser-only tool that stitches overlapping screenshots (e.g. Google Maps / satellite tiles) into one montage PNG.

**You choose every join** — no automatic seed or full-batch search.

## Use it

1. Open [index.html](index.html) locally, or the GitHub Pages URL.
2. Drop PNG/JPEG screenshots into the **left photo rail** (hover to expand; collapses while you drag into a workspace).
3. Tune **Crop** with the hatched preview until map UI chrome is discarded.
4. Use **Workspace A** (above) and **Workspace B** (below) for two montages at once. Click a pane to focus it; scroll wheel zooms. **Download** exports the focused pane.
5. Join tiles with either method:

### Click pair

Click two thumbs you know overlap. The app matches **only that pair**, shows a dashed proposal — **Accept (A)** or **Reject (R)**.

### Drag snap

Drag a free thumb onto a workspace, rough-align where it belongs, release. The app **snaps locally** around your drop. Accept, or drag again for a better snap.

6. Placed tiles show group badges (`G1`, …). Keep attaching free tiles, or merge groups by click-pairing one tile from each.

### Tips

- Same zoom level; ~20–40% overlap.
- Crop only enough to remove chrome.
- Lower confidence if true neighbors fail; use drag-snap when you can see the join but auto pair is unsure.
- Changing crop rebuilds tiles and clears placements.

## How it works

- **Pair match:** multi-patch consensus + overlap verification on the two tiles you selected.
- **Drag snap:** same scoring in a window around your drop (±~120px), so you guide the search.
- Accepted joins form connected components; download exports the active montage.

## Develop

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## License

MIT
