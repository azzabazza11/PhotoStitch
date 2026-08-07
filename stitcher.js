/**
 * Pixel-overlap montage stitcher.
 * Assumes same zoom / near-identical overlap regions (e.g. map screenshots).
 */

const GRAY_WEIGHTS = [0.299, 0.587, 0.114];

/**
 * @param {HTMLImageElement|ImageBitmap} source
 * @param {number} cropPx
 * @returns {{ canvas: HTMLCanvasElement, width: number, height: number, name: string }}
 */
export function cropImage(source, cropPx, name = "image") {
  const w = source.width;
  const h = source.height;
  const c = Math.max(0, Math.min(cropPx, Math.floor(Math.min(w, h) / 2) - 8));
  const cw = w - c * 2;
  const ch = h - c * 2;
  if (cw < 32 || ch < 32) {
    throw new Error(`${name}: crop too large for image size ${w}×${h}`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, c, c, cw, ch, 0, 0, cw, ch);
  return { canvas, width: cw, height: ch, name };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} scale
 */
function toGrayScaled(canvas, scale) {
  const w = Math.max(8, Math.round(canvas.width * scale));
  const h = Math.max(8, Math.round(canvas.height * scale));
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] =
      data[i] * GRAY_WEIGHTS[0] +
      data[i + 1] * GRAY_WEIGHTS[1] +
      data[i + 2] * GRAY_WEIGHTS[2];
  }
  return { gray, w, h };
}

/**
 * Normalized cross-correlation of template against image at (ox, oy).
 * Returns score in roughly [-1, 1]; higher is better.
 */
function nccAt(image, iw, ih, template, tw, th, ox, oy) {
  if (ox < 0 || oy < 0 || ox + tw > iw || oy + th > ih) return -1;

  let sumI = 0;
  let sumT = 0;
  let sumII = 0;
  let sumTT = 0;
  let sumIT = 0;
  const n = tw * th;

  for (let y = 0; y < th; y++) {
    let ii = (oy + y) * iw + ox;
    let ti = y * tw;
    for (let x = 0; x < tw; x++, ii++, ti++) {
      const iv = image[ii];
      const tv = template[ti];
      sumI += iv;
      sumT += tv;
      sumII += iv * iv;
      sumTT += tv * tv;
      sumIT += iv * tv;
    }
  }

  const meanI = sumI / n;
  const meanT = sumT / n;
  const varI = sumII - n * meanI * meanI;
  const varT = sumTT - n * meanT * meanT;
  if (varI < 1e-3 || varT < 1e-3) return -1;
  const cov = sumIT - n * meanI * meanT;
  return cov / Math.sqrt(varI * varT);
}

/**
 * Extract a patch from gray buffer.
 */
function extractPatch(gray, w, h, x, y, tw, th) {
  const patch = new Float32Array(tw * th);
  for (let row = 0; row < th; row++) {
    const src = (y + row) * w + x;
    patch.set(gray.subarray(src, src + tw), row * tw);
  }
  return patch;
}

/**
 * Coarse search: try several distinctive patches from candidate against mosaic.
 * @returns {{ dx: number, dy: number, score: number } | null} offset in full-res mosaic coords
 *   such that candidate (0,0) maps to mosaic (dx, dy).
 */
function findOffset(mosaicCanvas, candidateCanvas, searchScale) {
  const m = toGrayScaled(mosaicCanvas, searchScale);
  const c = toGrayScaled(candidateCanvas, searchScale);

  const patchW = Math.min(48, Math.floor(c.w * 0.35), c.w);
  const patchH = Math.min(48, Math.floor(c.h * 0.35), c.h);
  if (patchW < 12 || patchH < 12 || m.w < patchW || m.h < patchH) {
    return null;
  }

  const marginX = Math.max(2, Math.floor(c.w * 0.08));
  const marginY = Math.max(2, Math.floor(c.h * 0.08));
  const centers = [
    [marginX, marginY],
    [c.w - patchW - marginX, marginY],
    [marginX, c.h - patchH - marginY],
    [c.w - patchW - marginX, c.h - patchH - marginY],
    [Math.floor((c.w - patchW) / 2), marginY],
    [Math.floor((c.w - patchW) / 2), c.h - patchH - marginY],
    [marginX, Math.floor((c.h - patchH) / 2)],
    [c.w - patchW - marginX, Math.floor((c.h - patchH) / 2)],
    [Math.floor((c.w - patchW) / 2), Math.floor((c.h - patchH) / 2)],
  ].filter(([x, y]) => x >= 0 && y >= 0 && x + patchW <= c.w && y + patchH <= c.h);

  const step = Math.max(1, Math.floor(Math.min(patchW, patchH) / 8));
  /** @type {{ score: number, dx: number, dy: number, votes: number }[]} */
  const peaks = [];

  for (const [px, py] of centers) {
    const patch = extractPatch(c.gray, c.w, c.h, px, py, patchW, patchH);
    let bestScore = -1;
    let bestX = 0;
    let bestY = 0;

    for (let y = 0; y <= m.h - patchH; y += step) {
      for (let x = 0; x <= m.w - patchW; x += step) {
        const score = nccAt(m.gray, m.w, m.h, patch, patchW, patchH, x, y);
        if (score > bestScore) {
          bestScore = score;
          bestX = x;
          bestY = y;
        }
      }
    }

    // Local refine around best coarse hit
    const refine = Math.max(step, 4);
    for (let y = Math.max(0, bestY - refine); y <= Math.min(m.h - patchH, bestY + refine); y++) {
      for (let x = Math.max(0, bestX - refine); x <= Math.min(m.w - patchW, bestX + refine); x++) {
        const score = nccAt(m.gray, m.w, m.h, patch, patchW, patchH, x, y);
        if (score > bestScore) {
          bestScore = score;
          bestX = x;
          bestY = y;
        }
      }
    }

    if (bestScore < 0.5) continue;

    // Offset of candidate origin in mosaic (scaled space)
    const dxS = bestX - px;
    const dyS = bestY - py;

    let merged = false;
    for (const p of peaks) {
      if (Math.abs(p.dx - dxS) <= step * 2 && Math.abs(p.dy - dyS) <= step * 2) {
        p.votes += 1;
        if (bestScore > p.score) {
          p.score = bestScore;
          p.dx = dxS;
          p.dy = dyS;
        }
        merged = true;
        break;
      }
    }
    if (!merged) {
      peaks.push({ score: bestScore, dx: dxS, dy: dyS, votes: 1 });
    }
  }

  if (!peaks.length) return null;

  peaks.sort((a, b) => b.votes - a.votes || b.score - a.score);
  const top = peaks[0];

  // Full-resolution refine using a medium patch near the candidate center-top
  const inv = 1 / searchScale;
  let dx = Math.round(top.dx * inv);
  let dy = Math.round(top.dy * inv);

  const refined = refineFullRes(mosaicCanvas, candidateCanvas, dx, dy, 6);
  if (refined) {
    dx = refined.dx;
    dy = refined.dy;
    return { dx, dy, score: Math.max(top.score, refined.score) };
  }

  return { dx, dy, score: top.score };
}

function refineFullRes(mosaicCanvas, candidateCanvas, dx, dy, radius) {
  const mCtx = mosaicCanvas.getContext("2d", { willReadFrequently: true });
  const cCtx = candidateCanvas.getContext("2d", { willReadFrequently: true });
  const mw = mosaicCanvas.width;
  const mh = mosaicCanvas.height;
  const cw = candidateCanvas.width;
  const ch = candidateCanvas.height;

  const tw = Math.min(64, Math.floor(cw * 0.3));
  const th = Math.min(64, Math.floor(ch * 0.3));
  const px = Math.floor((cw - tw) / 2);
  const py = Math.max(4, Math.floor(ch * 0.12));

  const cData = cCtx.getImageData(px, py, tw, th).data;
  const template = new Float32Array(tw * th);
  for (let i = 0, p = 0; i < cData.length; i += 4, p++) {
    template[p] =
      cData[i] * GRAY_WEIGHTS[0] +
      cData[i + 1] * GRAY_WEIGHTS[1] +
      cData[i + 2] * GRAY_WEIGHTS[2];
  }

  // Read mosaic region large enough for search
  const searchX0 = dx + px - radius;
  const searchY0 = dy + py - radius;
  const searchW = tw + radius * 2;
  const searchH = th + radius * 2;

  // Clamp: if entirely outside, skip refine
  if (searchX0 + searchW < 0 || searchY0 + searchH < 0 || searchX0 >= mw || searchY0 >= mh) {
    return null;
  }

  let bestScore = -1;
  let bestDx = dx;
  let bestDy = dy;

  for (let oy = -radius; oy <= radius; oy++) {
    for (let ox = -radius; ox <= radius; ox++) {
      const mx = dx + px + ox;
      const my = dy + py + oy;
      if (mx < 0 || my < 0 || mx + tw > mw || my + th > mh) continue;

      const mData = mCtx.getImageData(mx, my, tw, th).data;
      const image = new Float32Array(tw * th);
      for (let i = 0, p = 0; i < mData.length; i += 4, p++) {
        image[p] =
          mData[i] * GRAY_WEIGHTS[0] +
          mData[i + 1] * GRAY_WEIGHTS[1] +
          mData[i + 2] * GRAY_WEIGHTS[2];
      }
      const score = nccAt(image, tw, th, template, tw, th, 0, 0);
      if (score > bestScore) {
        bestScore = score;
        bestDx = dx + ox;
        bestDy = dy + oy;
      }
    }
  }

  if (bestScore < 0) return null;
  return { dx: bestDx, dy: bestDy, score: bestScore };
}

/**
 * Paste candidate onto mosaic at (dx, dy), expanding canvas as needed.
 * Uses source-over; overlapping pixels keep existing content (first wins)
 * except we average slightly for smoother seams via lighter composite.
 */
function pasteExpanded(mosaicCanvas, candidateCanvas, dx, dy) {
  const left = Math.min(0, dx);
  const top = Math.min(0, dy);
  const right = Math.max(mosaicCanvas.width, dx + candidateCanvas.width);
  const bottom = Math.max(mosaicCanvas.height, dy + candidateCanvas.height);
  const newW = right - left;
  const newH = bottom - top;

  const next = document.createElement("canvas");
  next.width = newW;
  next.height = newH;
  const ctx = next.getContext("2d");
  ctx.drawImage(mosaicCanvas, -left, -top);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(candidateCanvas, dx - left, dy - top);

  return {
    canvas: next,
    originShiftX: -left,
    originShiftY: -top,
  };
}

/**
 * @typedef {{ canvas: HTMLCanvasElement, width: number, height: number, name: string, id: string }} Tile
 */

/**
 * @param {Tile[]} tiles
 * @param {{ threshold?: number, searchScale?: number, onProgress?: (msg: string, placedIds: string[], failedIds: string[]) => void }} options
 */
export async function stitchTiles(tiles, options = {}) {
  const threshold = options.threshold ?? 0.88;
  const searchScale = options.searchScale ?? 0.25;
  const onProgress = options.onProgress ?? (() => {});

  if (!tiles.length) {
    throw new Error("No images to stitch");
  }

  // Start with the largest tile (more context for matching)
  const remaining = [...tiles].sort((a, b) => b.width * b.height - a.width * a.height);
  const first = remaining.shift();
  let mosaic = first.canvas;
  const placed = [{ id: first.id, dx: 0, dy: 0 }];
  const placedIds = [first.id];
  const failedIds = [];

  onProgress(`Base: ${first.name}`, placedIds, failedIds);
  await yieldToUi();

  let guard = 0;
  while (remaining.length && guard < tiles.length + 2) {
    guard += 1;
    let best = null;
    let bestIdx = -1;

    for (let i = 0; i < remaining.length; i++) {
      const tile = remaining[i];
      onProgress(
        `Trying ${tile.name} (${remaining.length} left)…`,
        placedIds,
        failedIds
      );
      await yieldToUi();

      const hit = findOffset(mosaic, tile.canvas, searchScale);
      if (!hit) continue;
      if (!best || hit.score > best.score) {
        best = { ...hit, tile };
        bestIdx = i;
      }
    }

    if (!best || best.score < threshold) {
      // Mark leftovers as failed for this round
      for (const t of remaining) {
        if (!failedIds.includes(t.id)) failedIds.push(t.id);
      }
      onProgress(
        best
          ? `Stopped: best remaining score ${best.score.toFixed(3)} below ${threshold}`
          : "Stopped: no overlap match found for remaining images",
        placedIds,
        failedIds
      );
      break;
    }

    const { canvas: expanded, originShiftX, originShiftY } = pasteExpanded(
      mosaic,
      best.tile.canvas,
      best.dx,
      best.dy
    );
    mosaic = expanded;

    // Shift recorded placements when canvas origin moves
    for (const p of placed) {
      p.dx += originShiftX;
      p.dy += originShiftY;
    }
    placed.push({
      id: best.tile.id,
      dx: best.dx + originShiftX,
      dy: best.dy + originShiftY,
    });
    placedIds.push(best.tile.id);
    remaining.splice(bestIdx, 1);

    // Remove from failed if it was tentatively listed
    const fi = failedIds.indexOf(best.tile.id);
    if (fi >= 0) failedIds.splice(fi, 1);

    onProgress(
      `Placed ${best.tile.name} (score ${best.score.toFixed(3)})`,
      placedIds,
      failedIds
    );
    await yieldToUi();
  }

  return {
    canvas: mosaic,
    placed,
    placedIds,
    failedIds: remaining.map((t) => t.id),
  };
}

function yieldToUi() {
  return new Promise((r) => setTimeout(r, 0));
}
