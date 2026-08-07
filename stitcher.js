/**
 * Progressive edge-overlap montage stitcher with live preview + optional review.
 * Assumes same zoom / near-identical translation overlaps (e.g. map screenshots).
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
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} cropPx
 */
export function effectiveCrop(imgW, imgH, cropPx) {
  return Math.max(0, Math.min(cropPx, Math.floor(Math.min(imgW, imgH) / 2) - 8));
}

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
  return { gray, w, h, scale };
}

function toGrayFull(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] =
      data[i] * GRAY_WEIGHTS[0] +
      data[i + 1] * GRAY_WEIGHTS[1] +
      data[i + 2] * GRAY_WEIGHTS[2];
  }
  return { gray, w, h, scale: 1 };
}

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

function extractPatch(gray, w, _h, x, y, tw, th) {
  const patch = new Float32Array(tw * th);
  for (let row = 0; row < th; row++) {
    const src = (y + row) * w + x;
    patch.set(gray.subarray(src, src + tw), row * tw);
  }
  return patch;
}

function patchVariance(patch) {
  let sum = 0;
  for (let i = 0; i < patch.length; i++) sum += patch[i];
  const mean = sum / patch.length;
  let v = 0;
  for (let i = 0; i < patch.length; i++) {
    const d = patch[i] - mean;
    v += d * d;
  }
  return v / patch.length;
}

function overlapSimilarity(aGray, aw, ah, bGray, bw, bh, dx, dy) {
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(aw, dx + bw);
  const y1 = Math.min(ah, dy + bh);
  const ow = x1 - x0;
  const oh = y1 - y0;
  if (ow < 24 || oh < 24) return { score: 0, area: 0, mad: 999, ncc: 0 };

  const minArea = Math.min(aw * ah, bw * bh);
  const area = ow * oh;
  if (area < minArea * 0.08) return { score: 0, area, mad: 999, ncc: 0 };

  const step = Math.max(1, Math.floor(Math.min(ow, oh) / 80));
  let sum = 0;
  let count = 0;
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;

  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const bx = x - dx;
      const by = y - dy;
      if (bx < 0 || by < 0 || bx >= bw || by >= bh) continue;
      const av = aGray[y * aw + x];
      const bv = bGray[by * bw + bx];
      sum += Math.abs(av - bv);
      sumA += av;
      sumB += bv;
      sumAA += av * av;
      sumBB += bv * bv;
      sumAB += av * bv;
      count++;
    }
  }
  if (count < 16) return { score: 0, area, mad: 999, ncc: 0 };

  const mad = sum / count;
  const madScore = Math.max(0, 1 - mad / 55);
  const meanA = sumA / count;
  const meanB = sumB / count;
  const varA = sumAA - count * meanA * meanA;
  const varB = sumBB - count * meanB * meanB;
  let ncc = 0;
  if (varA > 1e-3 && varB > 1e-3) {
    ncc = (sumAB - count * meanA * meanB) / Math.sqrt(varA * varB);
  }
  const nccScore = Math.max(0, Math.min(1, ncc));
  // Both must look good — MAD catches wrong joins that NCC can still rate high
  const score = Math.min(madScore, nccScore) * 0.7 + ((madScore + nccScore) / 2) * 0.3;
  return { score, area, mad, ncc: nccScore };
}

function searchPatchInBand(ref, patch, tw, th, band, step) {
  const x0 = Math.max(0, band.x0);
  const y0 = Math.max(0, band.y0);
  const x1 = Math.min(ref.w - tw, band.x1 - tw);
  const y1 = Math.min(ref.h - th, band.y1 - th);
  if (x1 < x0 || y1 < y0) return null;

  let bestScore = -1;
  let bestX = x0;
  let bestY = y0;

  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const score = nccAt(ref.gray, ref.w, ref.h, patch, tw, th, x, y);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  const refine = Math.max(step, 3);
  for (let y = Math.max(y0, bestY - refine); y <= Math.min(y1, bestY + refine); y++) {
    for (let x = Math.max(x0, bestX - refine); x <= Math.min(x1, bestX + refine); x++) {
      const score = nccAt(ref.gray, ref.w, ref.h, patch, tw, th, x, y);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  if (bestScore < 0.5) return null;
  return { x: bestX, y: bestY, score: bestScore };
}

/** @param {"left"|"right"|"top"|"bottom"} edge */
function edgePatchOrigins(edge, w, h, tw, th) {
  const inset = Math.max(2, Math.floor(Math.min(w, h) * 0.03));
  /** @type {[number, number][]} */
  const pts = [];

  if (edge === "left" || edge === "right") {
    const x = edge === "left" ? inset : w - tw - inset;
    for (const y of [
      inset,
      Math.floor((h - th) / 2),
      h - th - inset,
      Math.floor(h * 0.25) - Math.floor(th / 2),
      Math.floor(h * 0.75) - Math.floor(th / 2),
    ]) {
      const yy = Math.max(0, Math.min(h - th, y));
      if (x >= 0 && x + tw <= w) pts.push([x, yy]);
    }
  } else {
    const y = edge === "top" ? inset : h - th - inset;
    for (const x of [
      inset,
      Math.floor((w - tw) / 2),
      w - tw - inset,
      Math.floor(w * 0.25) - Math.floor(tw / 2),
      Math.floor(w * 0.75) - Math.floor(tw / 2),
    ]) {
      const xx = Math.max(0, Math.min(w - tw, x));
      if (y >= 0 && y + th <= h) pts.push([xx, y]);
    }
  }

  const seen = new Set();
  return pts.filter(([x, y]) => {
    const k = `${x},${y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** @param {"left"|"right"|"top"|"bottom"} edge */
function oppositeBand(_edge, refW, refH, _maxOverlapFrac) {
  // Full-frame search at coarse scale. Edge labels only choose where patches
  // are sampled on the moving tile — with 30–60% map overlap the true hit
  // often sits well inside the reference, not only on the far border strip.
  return { x0: 0, y0: 0, x1: refW, y1: refH };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {{ dx: number, dy: number, score: number, edge: string }[]} votes
 * @param {number} tol
 */
function bestConsensus(votes, tol) {
  if (!votes.length) return null;

  /** @type {{ dx: number, dy: number, scores: number[], edges: Set<string>, votes: number }[]} */
  const clusters = [];

  for (const v of votes) {
    let hit = null;
    for (const c of clusters) {
      if (Math.abs(c.dx - v.dx) <= tol && Math.abs(c.dy - v.dy) <= tol) {
        hit = c;
        break;
      }
    }
    if (hit) {
      hit.votes += 1;
      hit.scores.push(v.score);
      hit.edges.add(v.edge);
      hit.dx = (hit.dx * (hit.votes - 1) + v.dx) / hit.votes;
      hit.dy = (hit.dy * (hit.votes - 1) + v.dy) / hit.votes;
    } else {
      clusters.push({
        dx: v.dx,
        dy: v.dy,
        scores: [v.score],
        edges: new Set([v.edge]),
        votes: 1,
      });
    }
  }

  const pool = clusters.filter((c) => c.votes >= 2);
  if (!pool.length) return null;

  pool.sort((a, b) => {
    const medA = median(a.scores) + (a.edges.size > 1 ? 0.03 : 0) + a.votes * 0.01;
    const medB = median(b.scores) + (b.edges.size > 1 ? 0.03 : 0) + b.votes * 0.01;
    return medB - medA || b.votes - a.votes;
  });

  const top = pool[0];
  return {
    dx: Math.round(top.dx),
    dy: Math.round(top.dy),
    patchScore: median(top.scores),
    votes: top.votes,
    edge: [...top.edges].join("+"),
  };
}

function refinePairFull(refFull, movFull, dx, dy, radius) {
  const tw = Math.min(48, Math.floor(movFull.w * 0.2));
  const th = Math.min(48, Math.floor(movFull.h * 0.2));
  if (tw < 12 || th < 12) return null;

  const samples = [
    [Math.floor(movFull.w * 0.08), Math.floor(movFull.h * 0.5 - th / 2)],
    [Math.floor(movFull.w * 0.92 - tw), Math.floor(movFull.h * 0.5 - th / 2)],
    [Math.floor(movFull.w * 0.5 - tw / 2), Math.floor(movFull.h * 0.08)],
    [Math.floor(movFull.w * 0.5 - tw / 2), Math.floor(movFull.h * 0.92 - th)],
  ];

  let bestDx = dx;
  let bestDy = dy;
  let bestScore = -1;

  for (let oy = -radius; oy <= radius; oy++) {
    for (let ox = -radius; ox <= radius; ox++) {
      let sum = 0;
      let n = 0;
      for (const [px, py] of samples) {
        const ppx = Math.max(0, Math.min(movFull.w - tw, px));
        const ppy = Math.max(0, Math.min(movFull.h - th, py));
        const patch = extractPatch(movFull.gray, movFull.w, movFull.h, ppx, ppy, tw, th);
        const rx = dx + ox + ppx;
        const ry = dy + oy + ppy;
        const s = nccAt(refFull.gray, refFull.w, refFull.h, patch, tw, th, rx, ry);
        if (s >= 0) {
          sum += s;
          n++;
        }
      }
      if (!n) continue;
      const avg = sum / n;
      if (avg > bestScore) {
        bestScore = avg;
        bestDx = dx + ox;
        bestDy = dy + oy;
      }
    }
  }

  if (bestScore < 0) return null;
  return { dx: bestDx, dy: bestDy, score: bestScore };
}

/**
 * Match moving tile B against reference A.
 * Returns offset of B's origin in A's coordinate system.
 */
function matchPair(refScaled, movScaled, refFull, movFull, coarseScale) {
  const maxOverlapFrac = 0.5;
  const tw = Math.min(40, Math.floor(movScaled.w * 0.28), movScaled.w);
  const th = Math.min(40, Math.floor(movScaled.h * 0.28), movScaled.h);
  if (tw < 12 || th < 12) return null;

  const step = Math.max(1, Math.floor(Math.min(tw, th) / 7));
  const edges = /** @type {const} */ (["left", "right", "top", "bottom"]);
  /** @type {{ dx: number, dy: number, score: number, edge: string }[]} */
  const votes = [];

  for (const edge of edges) {
    const origins = edgePatchOrigins(edge, movScaled.w, movScaled.h, tw, th);
    const band = oppositeBand(edge, refScaled.w, refScaled.h, maxOverlapFrac);

    for (const [px, py] of origins) {
      const patch = extractPatch(movScaled.gray, movScaled.w, movScaled.h, px, py, tw, th);
      if (patchVariance(patch) < 40) continue;
      const hit = searchPatchInBand(refScaled, patch, tw, th, band, step);
      if (!hit) continue;
      votes.push({
        dx: hit.x - px,
        dy: hit.y - py,
        score: hit.score,
        edge,
      });
    }
  }

  const tol = Math.max(2, Math.ceil(3 * coarseScale * 4));
  const consensus = bestConsensus(votes, tol);
  if (!consensus) return null;

  const inv = 1 / coarseScale;
  let dx = Math.round(consensus.dx * inv);
  let dy = Math.round(consensus.dy * inv);

  const refined = refinePairFull(refFull, movFull, dx, dy, 8);
  if (refined) {
    dx = refined.dx;
    dy = refined.dy;
  }

  const overlap = overlapSimilarity(
    refFull.gray,
    refFull.w,
    refFull.h,
    movFull.gray,
    movFull.w,
    movFull.h,
    dx,
    dy
  );

  if (overlap.area < 24 * 24) return null;
  // Near-identical map pixels should be close after integer refine
  if (overlap.mad > 22) return null;
  if (overlap.ncc < 0.85) return null;
  if (overlap.score < 0.78) return null;

  const finalScore = consensus.patchScore * 0.3 + overlap.score * 0.7;
  if (finalScore < 0.75) return null;

  return {
    dx,
    dy,
    score: finalScore,
    patchScore: consensus.patchScore,
    overlapScore: overlap.score,
    votes: consensus.votes,
    edge: consensus.edge,
  };
}

/**
 * @typedef {{ canvas: HTMLCanvasElement, width: number, height: number, name: string, id: string }} Tile
 */

/**
 * Composite placed tiles into a montage canvas.
 * @param {Tile[]} tiles
 * @param {Map<number, { dx: number, dy: number }>} abs
 * @param {{ index: number, dx: number, dy: number } | null} pending
 */
export function compositeMontage(tiles, abs, pending = null) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const entries = [...abs.entries()];
  if (pending) entries.push([pending.index, { dx: pending.dx, dy: pending.dy }]);

  for (const [i, p] of entries) {
    const t = tiles[i];
    minX = Math.min(minX, p.dx);
    minY = Math.min(minY, p.dy);
    maxX = Math.max(maxX, p.dx + t.width);
    maxY = Math.max(maxY, p.dy + t.height);
  }

  const outW = Math.max(1, Math.ceil(maxX - minX));
  const outH = Math.max(1, Math.ceil(maxY - minY));
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");

  const drawOrder = [...abs.entries()].sort(
    (a, b) => a[1].dx + a[1].dy - (b[1].dx + b[1].dy)
  );
  /** @type {{ id: string, dx: number, dy: number }[]} */
  const placed = [];
  for (const [i, p] of drawOrder) {
    const x = p.dx - minX;
    const y = p.dy - minY;
    ctx.drawImage(tiles[i].canvas, x, y);
    placed.push({ id: tiles[i].id, dx: x, dy: y });
  }

  let pendingRect = null;
  if (pending) {
    const x = pending.dx - minX;
    const y = pending.dy - minY;
    const t = tiles[pending.index];
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.drawImage(t.canvas, x, y);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#c4e86a";
    ctx.lineWidth = Math.max(3, Math.round(Math.min(outW, outH) / 200));
    ctx.setLineDash([10, 6]);
    ctx.strokeRect(x + 1, y + 1, t.width - 2, t.height - 2);
    ctx.restore();
    pendingRect = { x, y, w: t.width, h: t.height, id: t.id };
  }

  return { canvas, placed, pendingRect, origin: { minX, minY } };
}

/**
 * Progressive stitch: grow from a seed, optionally pause for Accept/Reject.
 *
 * @param {Tile[]} tiles
 * @param {{
 *   threshold?: number,
 *   searchScale?: number,
 *   previewIntervalMs?: number,
 *   onProgress?: (info: object) => void,
 *   onPreview?: (info: { canvas: HTMLCanvasElement, placedIds: string[], failedIds: string[], pendingId: string|null, msg: string }) => void,
 *   onPropose?: (info: {
 *     tile: Tile,
 *     anchor: Tile,
 *     score: number,
 *     edge: string,
 *     canvas: HTMLCanvasElement,
 *     placedIds: string[],
 *     remaining: number,
 *   }) => Promise<'accept'|'reject'|'accept-rest'|'stop'>,
 * }} options
 */
export async function stitchTiles(tiles, options = {}) {
  const threshold = options.threshold ?? 0.85;
  const searchScale = options.searchScale ?? 0.2;
  const previewIntervalMs = options.previewIntervalMs ?? 5000;
  const onProgress = options.onProgress ?? (() => {});
  const onPreview = options.onPreview ?? (() => {});
  const onPropose = options.onPropose;

  if (!tiles.length) throw new Error("No images to stitch");

  /** @type {Map<string, { coarse: ReturnType<typeof toGrayScaled>, full: ReturnType<typeof toGrayFull> }>} */
  const grayCache = new Map();
  for (const t of tiles) {
    grayCache.set(t.id, {
      coarse: toGrayScaled(t.canvas, searchScale),
      full: toGrayFull(t.canvas),
    });
  }

  let seed = 0;
  for (let i = 1; i < tiles.length; i++) {
    if (tiles[i].width * tiles[i].height > tiles[seed].width * tiles[seed].height) {
      seed = i;
    }
  }

  /** @type {Map<number, { dx: number, dy: number }>} */
  const abs = new Map();
  abs.set(seed, { dx: 0, dy: 0 });

  /** @type {Set<string>} */
  const rejected = new Set();
  /** @type {Record<string, string>} */
  const matchHints = { [tiles[seed].id]: "seed" };
  /** @type {{ a: string, b: string, score: number, edge: string, dx: number, dy: number }[]} */
  const matches = [];

  let autoAccept = !onPropose;
  let stopped = false;
  let lastPreviewAt = 0;

  const placedIds = () => [...abs.keys()].map((i) => tiles[i].id);
  const failedIds = () =>
    tiles.filter((_, i) => !abs.has(i)).map((t) => t.id);

  const emitPreview = async (msg, pending = null, force = false) => {
    const now = Date.now();
    if (!force && now - lastPreviewAt < previewIntervalMs && !pending) return;
    lastPreviewAt = now;
    const { canvas } = compositeMontage(tiles, abs, pending);
    onPreview({
      canvas,
      placedIds: placedIds(),
      failedIds: failedIds(),
      pendingId: pending ? tiles[pending.index].id : null,
      msg,
    });
    onProgress({
      msg,
      placedIds: placedIds(),
      failedIds: failedIds(),
      matchHints,
      pendingId: pending ? tiles[pending.index].id : null,
    });
    await yieldToUi();
  };

  await emitPreview(`Seed: ${tiles[seed].name}`, null, true);

  if (tiles.length === 1) {
    const { canvas, placed } = compositeMontage(tiles, abs);
    return {
      canvas,
      placed,
      placedIds: placedIds(),
      failedIds: [],
      matches: [],
    };
  }

  while (!stopped && abs.size < tiles.length) {
    /** @type {null | {
     *   cand: number,
     *   anchor: number,
     *   dx: number,
     *   dy: number,
     *   score: number,
     *   edge: string,
     * }} */
    let best = null;
    const unmatched = [];
    for (let i = 0; i < tiles.length; i++) {
      if (!abs.has(i)) unmatched.push(i);
    }

    let checks = 0;
    const checkTotal = unmatched.length * abs.size;

    for (const cand of unmatched) {
      for (const anchor of abs.keys()) {
        const key = `${cand}:${anchor}`;
        if (rejected.has(key)) continue;
        checks += 1;

        if (checks % 3 === 0) {
          onProgress({
            msg: `Searching… ${abs.size} placed, ${unmatched.length} left (${checks}/${checkTotal})`,
            placedIds: placedIds(),
            failedIds: failedIds(),
            matchHints,
          });
          await emitPreview(
            `Searching… ${abs.size} placed · ${unmatched.length} remaining`,
            null,
            false
          );
          await yieldToUi();
        }

        const gA = grayCache.get(tiles[anchor].id);
        const gB = grayCache.get(tiles[cand].id);
        const hit = matchPair(gA.coarse, gB.coarse, gA.full, gB.full, searchScale);
        if (!hit || hit.score < threshold) continue;

        const ap = abs.get(anchor);
        const absDx = ap.dx + hit.dx;
        const absDy = ap.dy + hit.dy;

        if (!best || hit.score > best.score) {
          best = {
            cand,
            anchor,
            dx: absDx,
            dy: absDy,
            score: hit.score,
            edge: hit.edge,
            relDx: hit.dx,
            relDy: hit.dy,
          };
        }
      }
    }

    if (!best) break;

    const pending = { index: best.cand, dx: best.dx, dy: best.dy };
    const { canvas: proposalCanvas } = compositeMontage(tiles, abs, pending);

    onProgress({
      msg: `Review: ${tiles[best.cand].name} → ${tiles[best.anchor].name} (${best.score.toFixed(3)}, ${best.edge})`,
      placedIds: placedIds(),
      failedIds: failedIds(),
      matchHints,
      pendingId: tiles[best.cand].id,
    });
    await emitPreview(
      `Proposed ${tiles[best.cand].name} (score ${best.score.toFixed(3)})`,
      pending,
      true
    );

    /** @type {'accept'|'reject'|'accept-rest'|'stop'} */
    let decision = "accept";
    if (!autoAccept && onPropose) {
      decision = await onPropose({
        tile: tiles[best.cand],
        anchor: tiles[best.anchor],
        score: best.score,
        edge: best.edge,
        canvas: proposalCanvas,
        placedIds: placedIds(),
        remaining: unmatched.length,
      });
    }

    if (decision === "stop") {
      stopped = true;
      break;
    }

    if (decision === "reject") {
      rejected.add(`${best.cand}:${best.anchor}`);
      matchHints[tiles[best.cand].id] = `rejected vs ${tiles[best.anchor].name}`;
      await emitPreview(`Rejected ${tiles[best.cand].name}`, null, true);
      continue;
    }

    if (decision === "accept-rest") {
      autoAccept = true;
    }

    abs.set(best.cand, { dx: best.dx, dy: best.dy });
    matchHints[tiles[best.cand].id] =
      `${best.score.toFixed(3)} via ${tiles[best.anchor].name} [${best.edge}]`;
    matches.push({
      a: tiles[best.anchor].id,
      b: tiles[best.cand].id,
      score: best.score,
      edge: best.edge,
      dx: best.relDx,
      dy: best.relDy,
    });

    await emitPreview(
      `Accepted ${tiles[best.cand].name} · ${abs.size}/${tiles.length}`,
      null,
      true
    );
  }

  const { canvas, placed } = compositeMontage(tiles, abs);
  const pIds = placedIds();
  const fIds = failedIds();

  onProgress({
    msg: `Done — ${pIds.length}/${tiles.length} placed`,
    placedIds: pIds,
    failedIds: fIds,
    matchHints,
  });
  await emitPreview(`Done — ${pIds.length}/${tiles.length} placed`, null, true);

  return {
    canvas,
    placed,
    placedIds: pIds,
    failedIds: fIds,
    matches,
  };
}

function yieldToUi() {
  return new Promise((r) => setTimeout(r, 0));
}
