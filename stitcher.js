/**
 * User-driven pair match + local drag-snap for overlapping screenshots.
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
  return (sumIT - n * meanI * meanT) / Math.sqrt(varI * varT);
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
  const score = Math.min(madScore, nccScore) * 0.7 + ((madScore + nccScore) / 2) * 0.3;
  return { score, area, mad, ncc: nccScore };
}

/**
 * Fast alignment score at an exact offset (no search).
 * dx/dy = moving origin in reference canvas coords.
 * @param {HTMLCanvasElement} refCanvas
 * @param {{ canvas: HTMLCanvasElement }} moving
 * @param {number} dx
 * @param {number} dy
 */
export function scoreOverlapAt(refCanvas, moving, dx, dy) {
  const refFull = toGrayFull(refCanvas);
  const movFull = toGrayFull(moving.canvas);
  return overlapSimilarity(
    refFull.gray,
    refFull.w,
    refFull.h,
    movFull.gray,
    movFull.w,
    movFull.h,
    Math.round(dx),
    Math.round(dy)
  );
}

/**
 * Paint agreement tint into overlay canvas (same size as ref).
 * Green-ish where pixels agree, red-ish where they differ — coarse blocks for speed.
 * @param {HTMLCanvasElement} refCanvas
 * @param {{ canvas: HTMLCanvasElement }} moving
 * @param {number} dx
 * @param {number} dy
 * @param {HTMLCanvasElement} [target]
 */
export function paintAgreementOverlay(refCanvas, moving, dx, dy, target) {
  const out = target || document.createElement("canvas");
  out.width = refCanvas.width;
  out.height = refCanvas.height;
  const ctx = out.getContext("2d");
  ctx.clearRect(0, 0, out.width, out.height);

  const refFull = toGrayFull(refCanvas);
  const movFull = toGrayFull(moving.canvas);
  dx = Math.round(dx);
  dy = Math.round(dy);

  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(refFull.w, dx + movFull.w);
  const y1 = Math.min(refFull.h, dy + movFull.h);
  if (x1 - x0 < 8 || y1 - y0 < 8) return out;

  const block = Math.max(8, Math.floor(Math.min(x1 - x0, y1 - y0) / 24));
  const img = ctx.createImageData(out.width, out.height);

  for (let by = y0; by < y1; by += block) {
    for (let bx = x0; bx < x1; bx += block) {
      const bw = Math.min(block, x1 - bx);
      const bh = Math.min(block, y1 - by);
      let sum = 0;
      let n = 0;
      const step = Math.max(1, Math.floor(block / 4));
      for (let y = by; y < by + bh; y += step) {
        for (let x = bx; x < bx + bw; x += step) {
          const mx = x - dx;
          const my = y - dy;
          if (mx < 0 || my < 0 || mx >= movFull.w || my >= movFull.h) continue;
          sum += Math.abs(refFull.gray[y * refFull.w + x] - movFull.gray[my * movFull.w + mx]);
          n++;
        }
      }
      if (!n) continue;
      const mad = sum / n;
      // mad 0 → green agree; mad 40+ → red disagree
      const agree = Math.max(0, Math.min(1, 1 - mad / 40));
      const r = Math.round(240 * (1 - agree));
      const g = Math.round(220 * agree);
      const b = 60;
      const a = Math.round(90 + 80 * Math.abs(agree - 0.5) * 2);
      for (let y = by; y < by + bh; y++) {
        for (let x = bx; x < bx + bw; x++) {
          const i = (y * out.width + x) * 4;
          img.data[i] = r;
          img.data[i + 1] = g;
          img.data[i + 2] = b;
          img.data[i + 3] = a;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
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

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

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
    [Math.floor(movFull.w * 0.5 - tw / 2), Math.floor(movFull.h * 0.5 - th / 2)],
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
        const s = nccAt(
          refFull.gray,
          refFull.w,
          refFull.h,
          patch,
          tw,
          th,
          dx + ox + ppx,
          dy + oy + ppy
        );
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

function scoreCandidate(refFull, movFull, dx, dy, patchScore, edge) {
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
  if (overlap.mad > 22) return null;
  if (overlap.ncc < 0.85) return null;
  if (overlap.score < 0.78) return null;
  const finalScore = (patchScore ?? overlap.ncc) * 0.3 + overlap.score * 0.7;
  if (finalScore < 0.75) return null;
  return {
    dx,
    dy,
    score: finalScore,
    patchScore: patchScore ?? overlap.ncc,
    overlapScore: overlap.score,
    edge: edge || "local",
  };
}

function matchPair(refScaled, movScaled, refFull, movFull, coarseScale) {
  const tw = Math.min(40, Math.floor(movScaled.w * 0.28), movScaled.w);
  const th = Math.min(40, Math.floor(movScaled.h * 0.28), movScaled.h);
  if (tw < 12 || th < 12) return null;

  const step = Math.max(1, Math.floor(Math.min(tw, th) / 7));
  const edges = /** @type {const} */ (["left", "right", "top", "bottom"]);
  /** @type {{ dx: number, dy: number, score: number, edge: string }[]} */
  const votes = [];
  const fullBand = { x0: 0, y0: 0, x1: refScaled.w, y1: refScaled.h };

  for (const edge of edges) {
    for (const [px, py] of edgePatchOrigins(edge, movScaled.w, movScaled.h, tw, th)) {
      const patch = extractPatch(movScaled.gray, movScaled.w, movScaled.h, px, py, tw, th);
      if (patchVariance(patch) < 40) continue;
      const hit = searchPatchInBand(refScaled, patch, tw, th, fullBand, step);
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

  return scoreCandidate(refFull, movFull, dx, dy, consensus.patchScore, consensus.edge);
}

/**
 * @typedef {{ canvas: HTMLCanvasElement, width: number, height: number, name: string, id: string }} Tile
 */

/**
 * Full pair match: offset of B's origin in A's coordinate system.
 * @param {Tile} tileA
 * @param {Tile} tileB
 * @param {{ threshold?: number, searchScale?: number }} [options]
 */
export function matchTwoTiles(tileA, tileB, options = {}) {
  const threshold = options.threshold ?? 0.85;
  const searchScale = options.searchScale ?? 0.2;
  const gA = {
    coarse: toGrayScaled(tileA.canvas, searchScale),
    full: toGrayFull(tileA.canvas),
  };
  const gB = {
    coarse: toGrayScaled(tileB.canvas, searchScale),
    full: toGrayFull(tileB.canvas),
  };

  const ab = matchPair(gA.coarse, gB.coarse, gA.full, gB.full, searchScale);
  const ba = matchPair(gB.coarse, gA.coarse, gB.full, gA.full, searchScale);

  /** @type {ReturnType<typeof scoreCandidate> & { dx: number, dy: number } | null} */
  let best = ab;

  if (ba) {
    const asAb = { ...ba, dx: -ba.dx, dy: -ba.dy };
    if (!best || asAb.score > best.score) best = asAb;
  }

  if (ab && ba) {
    const consX = Math.abs(ab.dx + ba.dx);
    const consY = Math.abs(ab.dy + ba.dy);
    if (consX <= 4 && consY <= 4) {
      best = {
        dx: Math.round((ab.dx - ba.dx) / 2),
        dy: Math.round((ab.dy - ba.dy) / 2),
        score: Math.min(1, Math.min(ab.score, ba.score) + 0.02),
        patchScore: Math.min(ab.patchScore, ba.patchScore),
        overlapScore: Math.min(ab.overlapScore, ba.overlapScore),
        edge: `${ab.edge}/${ba.edge}`,
      };
    }
  }

  if (!best || best.score < threshold) return null;
  return best;
}

/**
 * Local snap around a user drop guess (moving origin in reference coords).
 * @param {Tile|{ canvas: HTMLCanvasElement }} reference
 * @param {Tile} moving
 * @param {number} guessDx
 * @param {number} guessDy
 * @param {{ radius?: number, searchScale?: number, threshold?: number }} [options]
 */
export function snapNearOffset(reference, moving, guessDx, guessDy, options = {}) {
  const radius = options.radius ?? 100;
  const searchScale = options.searchScale ?? 0.25;
  const threshold = options.threshold ?? 0.8;

  const refCanvas = "canvas" in reference ? reference.canvas : reference;
  const refFull = toGrayFull(refCanvas);
  const movFull = toGrayFull(moving.canvas);
  const refScaled = toGrayScaled(refCanvas, searchScale);
  const movScaled = toGrayScaled(moving.canvas, searchScale);

  const gx = Math.round(guessDx * searchScale);
  const gy = Math.round(guessDy * searchScale);
  const r = Math.max(8, Math.round(radius * searchScale));

  const tw = Math.min(36, Math.floor(movScaled.w * 0.28), movScaled.w);
  const th = Math.min(36, Math.floor(movScaled.h * 0.28), movScaled.h);
  if (tw < 12 || th < 12) return null;

  const step = Math.max(1, Math.floor(Math.min(tw, th) / 6));
  /** @type {{ dx: number, dy: number, score: number, edge: string }[]} */
  const votes = [];

  for (const edge of /** @type {const} */ (["left", "right", "top", "bottom"])) {
    for (const [px, py] of edgePatchOrigins(edge, movScaled.w, movScaled.h, tw, th)) {
      const patch = extractPatch(movScaled.gray, movScaled.w, movScaled.h, px, py, tw, th);
      if (patchVariance(patch) < 30) continue;
      const localBand = {
        x0: gx + px - r,
        y0: gy + py - r,
        x1: gx + px + r + tw,
        y1: gy + py + r + th,
      };
      const hit = searchPatchInBand(refScaled, patch, tw, th, localBand, step);
      if (!hit) continue;
      votes.push({
        dx: hit.x - px,
        dy: hit.y - py,
        score: hit.score,
        edge,
      });
    }
  }

  let dx = Math.round(guessDx);
  let dy = Math.round(guessDy);
  let patchScore = 0.5;
  let edge = "drop";

  const consensus = bestConsensus(votes, Math.max(2, Math.ceil(r / 4)));
  if (consensus) {
    const inv = 1 / searchScale;
    dx = Math.round(consensus.dx * inv);
    dy = Math.round(consensus.dy * inv);
    patchScore = consensus.patchScore;
    edge = consensus.edge;
  }

  const refined = refinePairFull(refFull, movFull, dx, dy, Math.min(radius, 24));
  if (refined) {
    dx = refined.dx;
    dy = refined.dy;
    patchScore = Math.max(patchScore, refined.score);
  }

  const strict = scoreCandidate(refFull, movFull, dx, dy, patchScore, edge);
  if (strict && strict.score >= threshold) return strict;

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
  if (overlap.area >= 24 * 24 && overlap.ncc >= 0.7 && overlap.mad <= 35) {
    return {
      dx,
      dy,
      score: Math.max(threshold * 0.95, overlap.score * 0.9),
      patchScore,
      overlapScore: overlap.score,
      edge: `${edge}+soft`,
      weak: false,
    };
  }

  return {
    dx: Math.round(guessDx),
    dy: Math.round(guessDy),
    score: overlap.score || 0.5,
    patchScore: 0,
    overlapScore: overlap.score || 0,
    edge: "unsapped",
    weak: true,
  };
}

/**
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
  if (!entries.length) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    return { canvas, placed: [], pendingRect: null, origin: { minX: 0, minY: 0 } };
  }

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
 * Surround a tight montage with empty room so tiles can be dragged fully around edges.
 * @param {HTMLCanvasElement} tight
 * @param {number} padX
 * @param {number} padY
 */
export function padWorkspace(tight, padX, padY) {
  const px = Math.max(0, Math.ceil(padX));
  const py = Math.max(0, Math.ceil(padY));
  if (!px && !py) {
    return { canvas: tight, padX: 0, padY: 0 };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, tight.width + px * 2);
  canvas.height = Math.max(1, tight.height + py * 2);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0a120e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Subtle frame for the content bounds
  ctx.strokeStyle = "rgba(196, 232, 106, 0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(px - 0.5, py - 0.5, tight.width + 1, tight.height + 1);
  ctx.drawImage(tight, px, py);
  return { canvas, padX: px, padY: py };
}

/**
 * Pad size so a full tile can sit entirely outside each edge of the montage.
 * @param {{ width: number, height: number }[]} tiles
 * @param {number} [movingIndex]
 */
export function workspacePadFor(tiles, movingIndex = -1) {
  let maxW = 320;
  let maxH = 320;
  for (const t of tiles) {
    if (!t) continue;
    maxW = Math.max(maxW, t.width);
    maxH = Math.max(maxH, t.height);
  }
  if (movingIndex >= 0 && tiles[movingIndex]) {
    maxW = Math.max(maxW, tiles[movingIndex].width);
    maxH = Math.max(maxH, tiles[movingIndex].height);
  }
  // Enough room to drag around edges without drowning the photo in empty pad
  return {
    x: Math.ceil(maxW * 0.45),
    y: Math.ceil(maxH * 0.45),
  };
}
