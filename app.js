import {
  cropImage,
  effectiveCrop,
  matchTwoTiles,
  snapNearOffset,
  compositeMontage,
} from "./stitcher.js";

const drop = document.getElementById("drop");
const fileInput = document.getElementById("fileInput");
const thumbs = document.getElementById("thumbs");
const statusEl = document.getElementById("status");
const countsEl = document.getElementById("counts");
const clearBtn = document.getElementById("clearBtn");
const downloadBtn = document.getElementById("downloadBtn");
const cropInput = document.getElementById("crop");
const thresholdInput = document.getElementById("threshold");
const thresholdOut = document.getElementById("thresholdOut");
const scaleSelect = document.getElementById("scale");
const preview = document.getElementById("preview");
const previewWrap = document.getElementById("previewWrap");
const cropPreview = document.getElementById("cropPreview");
const cropCanvas = document.getElementById("cropCanvas");
const reviewBar = document.getElementById("reviewBar");
const reviewMsg = document.getElementById("reviewMsg");
const acceptBtn = document.getElementById("acceptBtn");
const rejectBtn = document.getElementById("rejectBtn");
const dragGhost = document.getElementById("dragGhost");

/** @type {{ id: string, file: File, url: string, img: HTMLImageElement }[]} */
let loaded = [];
/** @type {import('./stitcher.js').Tile[] | { canvas: HTMLCanvasElement, width: number, height: number, name: string, id: string }[]} */
let tiles = [];

/**
 * groups: groupId -> Map(tileIndex -> {dx,dy})
 * @type {Map<string, Map<number, { dx: number, dy: number }>>}
 */
let groups = new Map();
/** @type {Map<number, string>} tileIndex -> groupId */
let tileGroup = new Map();
let nextGroup = 1;
/** @type {string | null} */
let activeGroupId = null;

/** @type {string[]} selected loaded ids (max 2 for click-pair) */
let selection = [];

/**
 * @type {null | {
 *   movingIndex: number,
 *   abs: Map<number, { dx: number, dy: number }>,
 *   pending: { index: number, dx: number, dy: number },
 *   score: number,
 *   edge: string,
 *   weak?: boolean,
 *   targetGroupId: string | null,
 *   mergeGroupId: string | null,
 * }}
 */
let pending = null;

/** @type {HTMLCanvasElement | null} */
let resultCanvas = null;
let busy = false;

/** Drag state */
let dragIndex = null;
let dragMoved = false;
let pointerId = null;

thresholdInput.addEventListener("input", () => {
  thresholdOut.textContent = Number(thresholdInput.value).toFixed(2);
});
cropInput.addEventListener("input", () => {
  rebuildTiles();
  updateCropPreview();
});

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function opts() {
  return {
    threshold: Number(thresholdInput.value),
    searchScale: Number(scaleSelect.value),
  };
}

function updateButtons() {
  clearBtn.disabled = busy || (loaded.length === 0 && !resultCanvas);
  downloadBtn.disabled = busy || !resultCanvas;
}

function updateCounts() {
  const placed = tileGroup.size;
  countsEl.textContent = loaded.length
    ? `${loaded.length} loaded · ${placed} placed · ${groups.size} group${groups.size === 1 ? "" : "s"}`
    : "";
}

function indexById(id) {
  return tiles.findIndex((t) => t.id === id);
}

function rebuildTiles() {
  const cropPx = Number(cropInput.value) || 0;
  tiles = loaded.map((item) => {
    const cropped = cropImage(item.img, cropPx, item.file.name);
    return { ...cropped, id: item.id };
  });
  // Invalidate groups if crop changed dimensions — clear placements
  groups = new Map();
  tileGroup = new Map();
  nextGroup = 1;
  activeGroupId = null;
  pending = null;
  hideReview();
  selection = [];
  refreshPreview();
  renderThumbs();
}

function showPreviewCanvas(canvas) {
  const ctx = preview.getContext("2d");
  preview.width = canvas.width;
  preview.height = canvas.height;
  ctx.clearRect(0, 0, preview.width, preview.height);
  ctx.drawImage(canvas, 0, 0);
  previewWrap.classList.add("has-result");
  resultCanvas = canvas;
  updateButtons();
}

function largestGroupId() {
  let best = null;
  let bestN = 0;
  for (const [gid, abs] of groups) {
    if (abs.size > bestN) {
      bestN = abs.size;
      best = gid;
    }
  }
  return best;
}

function refreshPreview() {
  const gid = activeGroupId && groups.has(activeGroupId) ? activeGroupId : largestGroupId();
  if (!gid) {
    if (pending) {
      const abs = pending.abs;
      const { canvas } = compositeMontage(tiles, abs, pending.pending);
      showPreviewCanvas(canvas);
      return;
    }
    preview.width = 0;
    preview.height = 0;
    previewWrap.classList.remove("has-result");
    resultCanvas = null;
    updateButtons();
    return;
  }
  const abs = new Map(groups.get(gid));
  const pend =
    pending && (pending.targetGroupId === gid || !pending.targetGroupId)
      ? pending.pending
      : pending && !pending.targetGroupId
        ? pending.pending
        : null;
  // Always show pending on active preview when proposing into this group or new group from this view
  let usePending = null;
  if (pending) {
    if (!pending.targetGroupId || pending.targetGroupId === gid) {
      usePending = pending.pending;
    }
  }
  const { canvas } = compositeMontage(tiles, abs, usePending);
  showPreviewCanvas(canvas);
}

function hideReview() {
  reviewBar.hidden = true;
}

function showReview(msg) {
  reviewMsg.textContent = msg;
  reviewBar.hidden = false;
  acceptBtn.focus();
}

function renderThumbs() {
  thumbs.replaceChildren();
  for (const item of loaded) {
    const idx = indexById(item.id);
    const wrap = document.createElement("div");
    wrap.className = "thumb-wrap";
    wrap.dataset.id = item.id;
    wrap.dataset.index = String(idx);
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "button");

    if (selection.includes(item.id)) wrap.classList.add("selected");
    const gid = tileGroup.get(idx);
    if (gid) {
      wrap.classList.add("placed");
      wrap.dataset.group = gid;
    }
    if (pending && pending.movingIndex === idx) wrap.classList.add("pending");

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.url;
    img.alt = item.file.name;
    img.draggable = false;

    const meta = document.createElement("span");
    meta.className = "thumb-meta";
    if (pending && pending.movingIndex === idx) meta.textContent = "review";
    else if (gid) meta.textContent = gid;
    else if (selection.includes(item.id)) meta.textContent = selection[0] === item.id ? "1st" : "2nd";
    else meta.textContent = item.file.name;

    if (gid) {
      const badge = document.createElement("span");
      badge.className = "group-badge";
      badge.textContent = gid;
      wrap.appendChild(badge);
    }

    wrap.appendChild(img);
    wrap.appendChild(meta);
    wrap.title = item.file.name;

    wrap.addEventListener("click", (e) => {
      if (dragMoved) {
        dragMoved = false;
        return;
      }
      onThumbClick(item.id);
    });

    wrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const i = indexById(item.id);
      if (tileGroup.has(i) && !pending) return; // placed tiles: click-only for pair merge
      // Allow drag of free tiles (or pending moving tile to re-snap)
      if (tileGroup.has(i) && !(pending && pending.movingIndex === i)) return;
      startDrag(e, i);
    });

    thumbs.appendChild(wrap);
  }
}

function onThumbClick(id) {
  if (busy) return;
  if (pending) {
    setStatus("Accept or Reject the current proposal first.", "error");
    return;
  }

  if (selection.includes(id)) {
    selection = selection.filter((x) => x !== id);
    renderThumbs();
    setStatus(selection.length ? "Select a second image to match." : "Click two images, or drag one onto the montage.");
    return;
  }

  if (selection.length >= 2) selection = [];
  selection.push(id);
  renderThumbs();

  if (selection.length === 1) {
    setStatus("Select a second overlapping image (or drag this one onto the montage).");
    return;
  }

  runPairMatch(selection[0], selection[1]);
}

async function runPairMatch(idA, idB) {
  const iA = indexById(idA);
  const iB = indexById(idB);
  if (iA < 0 || iB < 0) return;

  busy = true;
  updateButtons();
  setStatus("Matching pair…", "busy");

  try {
    await yieldUi();
    const hit = matchTwoTiles(tiles[iA], tiles[iB], opts());
    if (!hit) {
      setStatus("No confident match for that pair — try drag-snap or lower confidence.", "error");
      selection = [];
      renderThumbs();
      return;
    }

    const gA = tileGroup.get(iA);
    const gB = tileGroup.get(iB);

    /** @type {Map<number, { dx: number, dy: number }>} */
    let abs;
    /** @type {string | null} */
    let targetGroupId = null;
    /** @type {string | null} */
    let mergeGroupId = null;
    let movingIndex;
    let pendingPos;

    if (!gA && !gB) {
      // New group: A at origin, B at hit offset
      abs = new Map([[iA, { dx: 0, dy: 0 }]]);
      movingIndex = iB;
      pendingPos = { index: iB, dx: hit.dx, dy: hit.dy };
      targetGroupId = null;
    } else if (gA && !gB) {
      abs = new Map(groups.get(gA));
      const aPos = abs.get(iA);
      movingIndex = iB;
      pendingPos = { index: iB, dx: aPos.dx + hit.dx, dy: aPos.dy + hit.dy };
      targetGroupId = gA;
    } else if (!gA && gB) {
      // Attach A using inverse: A origin in B coords = -hit of B in A...
      // hit is B in A coords. We matched A as ref, B as mov. So B = A_pos + hit.
      // Here B is placed; we want A. From B = A + hit => A = B - hit.
      abs = new Map(groups.get(gB));
      const bPos = abs.get(iB);
      movingIndex = iA;
      pendingPos = { index: iA, dx: bPos.dx - hit.dx, dy: bPos.dy - hit.dy };
      targetGroupId = gB;
    } else if (gA && gB && gA !== gB) {
      // Merge gB into gA via link at iA/iB
      abs = new Map(groups.get(gA));
      const aPos = abs.get(iA);
      const bAbs = groups.get(gB);
      const bPos = bAbs.get(iB);
      // Desired: bPos' = aPos + hit. Shift for all of gB: delta = (aPos+hit) - bPos
      const deltaX = aPos.dx + hit.dx - bPos.dx;
      const deltaY = aPos.dy + hit.dy - bPos.dy;
      // Preview: show gA + shifted gB as pending isn't one tile — commit on accept by merging
      for (const [ti, p] of bAbs) {
        abs.set(ti, { dx: p.dx + deltaX, dy: p.dy + deltaY });
      }
      movingIndex = iB;
      pendingPos = { index: iB, dx: aPos.dx + hit.dx, dy: aPos.dy + hit.dy };
      targetGroupId = gA;
      mergeGroupId = gB;
      // Store merge shift on pending via abs already containing both
      pending = {
        movingIndex,
        abs: new Map(groups.get(gA)), // base only; accept will merge
        pending: pendingPos,
        score: hit.score,
        edge: hit.edge,
        targetGroupId,
        mergeGroupId,
        mergeDelta: { dx: deltaX, dy: deltaY },
      };
      selection = [];
      const { canvas } = compositeMontage(
        tiles,
        (() => {
          const m = new Map(groups.get(gA));
          for (const [ti, p] of groups.get(gB)) {
            m.set(ti, { dx: p.dx + deltaX, dy: p.dy + deltaY });
          }
          return m;
        })(),
        null
      );
      showPreviewCanvas(canvas);
      showReview(
        `Merge ${gB} → ${gA}? score ${hit.score.toFixed(3)} · ${hit.edge}`
      );
      setStatus(`Merge groups via ${tiles[iA].name} + ${tiles[iB].name}`, "busy");
      renderThumbs();
      return;
    } else {
      setStatus("Those two are already in the same group.", "error");
      selection = [];
      renderThumbs();
      return;
    }

    pending = {
      movingIndex,
      abs,
      pending: pendingPos,
      score: hit.score,
      edge: hit.edge,
      targetGroupId,
      mergeGroupId: null,
    };
    selection = [];
    activeGroupId = targetGroupId;
    refreshPreview();
    showReview(
      `Join “${tiles[movingIndex].name}”? score ${hit.score.toFixed(3)} · ${hit.edge}`
    );
    setStatus("Accept to lock this join, or Reject to try another pair.", "busy");
    renderThumbs();
  } finally {
    busy = false;
    updateButtons();
  }
}

function acceptPending() {
  if (!pending) return;
  const p = pending;

  if (p.mergeGroupId && p.targetGroupId) {
    const target = groups.get(p.targetGroupId);
    const other = groups.get(p.mergeGroupId);
    const delta = p.mergeDelta;
    for (const [ti, pos] of other) {
      target.set(ti, { dx: pos.dx + delta.dx, dy: pos.dy + delta.dy });
      tileGroup.set(ti, p.targetGroupId);
    }
    groups.delete(p.mergeGroupId);
    activeGroupId = p.targetGroupId;
  } else if (!p.targetGroupId) {
    const gid = `G${nextGroup++}`;
    const abs = new Map(p.abs);
    abs.set(p.pending.index, { dx: p.pending.dx, dy: p.pending.dy });
    groups.set(gid, abs);
    for (const ti of abs.keys()) tileGroup.set(ti, gid);
    activeGroupId = gid;
  } else {
    const abs = groups.get(p.targetGroupId);
    abs.set(p.pending.index, { dx: p.pending.dx, dy: p.pending.dy });
    // Also ensure base tiles from p.abs seed if any missing (shouldn't)
    tileGroup.set(p.pending.index, p.targetGroupId);
    activeGroupId = p.targetGroupId;
  }

  pending = null;
  hideReview();
  refreshPreview();
  renderThumbs();
  updateCounts();
  setStatus(`Locked. ${tileGroup.size} tiles placed. Click another pair or drag to snap.`);
}

function rejectPending() {
  if (!pending) return;
  pending = null;
  hideReview();
  selection = [];
  refreshPreview();
  renderThumbs();
  setStatus("Rejected. Click two images or drag a free tile onto the montage.");
}

acceptBtn.addEventListener("click", acceptPending);
rejectBtn.addEventListener("click", rejectPending);

window.addEventListener("keydown", (e) => {
  if (!pending) return;
  if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  const key = e.key.toLowerCase();
  if (key === "a") {
    e.preventDefault();
    acceptPending();
  } else if (key === "r") {
    e.preventDefault();
    rejectPending();
  }
});

function startDrag(e, index) {
  if (busy) return;
  if (pending && pending.movingIndex !== index) {
    setStatus("Accept or Reject the current proposal first.", "error");
    return;
  }
  // Free tiles, or re-drag the pending tile
  if (tileGroup.has(index) && !(pending && pending.movingIndex === index)) return;

  dragIndex = index;
  dragMoved = false;
  pointerId = e.pointerId;
  const originEl = e.currentTarget;
  try {
    originEl.setPointerCapture(e.pointerId);
  } catch (_) {}

  const loadedIdx = loaded.findIndex((l) => l.id === tiles[index].id);

  const onMove = (ev) => {
    if (ev.pointerId !== pointerId) return;
    dragMoved = true;
    dragGhost.hidden = false;
    dragGhost.style.backgroundImage = `url(${loaded[loadedIdx].url})`;
    const size = 96;
    dragGhost.style.width = `${size}px`;
    dragGhost.style.height = `${size}px`;
    dragGhost.style.left = `${ev.clientX - size / 2}px`;
    dragGhost.style.top = `${ev.clientY - size / 2}px`;
  };

  const onUp = (ev) => {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    dragGhost.hidden = true;

    const i = dragIndex;
    dragIndex = null;
    pointerId = null;

    if (!dragMoved) return;
    const rect = previewWrap.getBoundingClientRect();
    const over =
      ev.clientX >= rect.left &&
      ev.clientX <= rect.right &&
      ev.clientY >= rect.top &&
      ev.clientY <= rect.bottom;

    if (!over) {
      setStatus("Drop on the montage to snap. Or click two thumbs to pair-match.");
      setTimeout(() => {
        dragMoved = false;
      }, 0);
      return;
    }

    finishDragSnap(i, ev.clientX, ev.clientY, preview.getBoundingClientRect());
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

async function finishDragSnap(movingIndex, clientX, clientY, rect) {
  busy = true;
  updateButtons();
  setStatus("Snapping…", "busy");

  try {
    await yieldUi();

    // Ensure there is a base montage — if empty, place this tile as new seed at 0,0 without snap
    let gid = activeGroupId && groups.has(activeGroupId) ? activeGroupId : largestGroupId();

    if (!gid) {
      // Start group with this tile alone — user can then attach others
      const newG = `G${nextGroup++}`;
      groups.set(newG, new Map([[movingIndex, { dx: 0, dy: 0 }]]));
      tileGroup.set(movingIndex, newG);
      activeGroupId = newG;
      pending = null;
      hideReview();
      refreshPreview();
      renderThumbs();
      updateCounts();
      setStatus(`Started ${newG} with “${tiles[movingIndex].name}”. Drag another tile onto it to snap.`);
      return;
    }

    if (tileGroup.has(movingIndex) && tileGroup.get(movingIndex) === gid) {
      setStatus("That tile is already in this group.", "error");
      return;
    }

    const abs = groups.get(gid);
    const { canvas: montageCanvas, origin } = compositeMontage(tiles, abs, null);

    // Map pointer to montage pixel coords (account for CSS scaling)
    const scaleX = preview.width / rect.width;
    const scaleY = preview.height / rect.height;
    const localX = (clientX - rect.left) * scaleX;
    const localY = (clientY - rect.top) * scaleY;

    // Drop = center of moving tile roughly under cursor
    const guessDx = origin.minX + localX - tiles[movingIndex].width / 2;
    const guessDy = origin.minY + localY - tiles[movingIndex].height / 2;

    // Snap against composite montage in origin-shifted space: convert guess to montage-local
    const guessInMontage = {
      dx: guessDx - origin.minX,
      dy: guessDy - origin.minY,
    };

    const hit = snapNearOffset(
      { canvas: montageCanvas },
      tiles[movingIndex],
      guessInMontage.dx,
      guessInMontage.dy,
      { ...opts(), radius: 120 }
    );

    if (!hit) {
      setStatus("Snap failed — try a closer drop or click-pair instead.", "error");
      return;
    }

    const absDx = origin.minX + hit.dx;
    const absDy = origin.minY + hit.dy;

    pending = {
      movingIndex,
      abs: new Map(abs),
      pending: { index: movingIndex, dx: absDx, dy: absDy },
      score: hit.score,
      edge: hit.edge,
      weak: !!hit.weak,
      targetGroupId: gid,
      mergeGroupId: null,
    };
    activeGroupId = gid;
    selection = [];
    refreshPreview();
    const weakNote = hit.weak ? " (weak — nudge & re-drop if needed)" : "";
    showReview(
      `Snap “${tiles[movingIndex].name}”? score ${hit.score.toFixed(3)} · ${hit.edge}${weakNote}`
    );
    setStatus(
      hit.weak
        ? "Weak snap at drop position — Accept, Reject, or drag again for a better fit."
        : "Snapped. Accept to lock, or drag again to re-snap.",
      "busy"
    );
    renderThumbs();
  } finally {
    busy = false;
    updateButtons();
    // Keep dragMoved true until click handler consumes it
    setTimeout(() => {
      dragMoved = false;
    }, 0);
  }
}

function updateCropPreview() {
  if (!loaded.length) {
    cropPreview.hidden = true;
    return;
  }
  const item = loaded[0];
  const cropPx = Number(cropInput.value) || 0;
  const c = effectiveCrop(item.img.width, item.img.height, cropPx);
  const srcW = item.img.width;
  const srcH = item.img.height;
  const maxW = 420;
  const maxH = 260;
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  const dw = Math.round(srcW * scale);
  const dh = Math.round(srcH * scale);
  cropCanvas.width = dw;
  cropCanvas.height = dh;
  const ctx = cropCanvas.getContext("2d");
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(item.img, 0, 0, dw, dh);
  const cx = c * scale;
  const cy = c * scale;
  ctx.fillStyle = "rgba(10, 18, 14, 0.55)";
  ctx.fillRect(0, 0, dw, cy);
  ctx.fillRect(0, dh - cy, dw, cy);
  ctx.fillRect(0, cy, cx, dh - cy * 2);
  ctx.fillRect(dw - cx, cy, cx, dh - cy * 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, dw, cy);
  ctx.rect(0, dh - cy, dw, cy);
  ctx.rect(0, cy, cx, dh - cy * 2);
  ctx.rect(dw - cx, cy, cx, dh - cy * 2);
  ctx.clip();
  ctx.strokeStyle = "rgba(240, 160, 144, 0.35)";
  for (let i = -dh; i < dw + dh; i += 8) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + dh, dh);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(196, 232, 106, 0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(cx + 1, cy + 1, dw - cx * 2 - 2, dh - cy * 2 - 2);
  cropPreview.hidden = false;
}

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/"));
  if (!list.length) {
    setStatus("No image files found.", "error");
    return;
  }
  for (const file of list) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(`Failed to load ${file.name}`));
      img.src = url;
    });
    loaded.push({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
      file,
      url,
      img,
    });
  }
  rebuildTiles();
  updateCropPreview();
  updateCounts();
  updateButtons();
  setStatus("Click two overlapping shots, or drag a free tile onto the montage.");
}

function clearAll() {
  for (const item of loaded) URL.revokeObjectURL(item.url);
  loaded = [];
  tiles = [];
  groups = new Map();
  tileGroup = new Map();
  nextGroup = 1;
  activeGroupId = null;
  pending = null;
  selection = [];
  resultCanvas = null;
  preview.width = 0;
  preview.height = 0;
  previewWrap.classList.remove("has-result");
  cropPreview.hidden = true;
  hideReview();
  renderThumbs();
  updateCounts();
  updateButtons();
  setStatus("Waiting for images.");
  fileInput.value = "";
}

function downloadPng() {
  if (!resultCanvas) return;
  resultCanvas.toBlob((blob) => {
    if (!blob) {
      setStatus("Could not export PNG.", "error");
      return;
    }
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `photostitch-${resultCanvas.width}x${resultCanvas.height}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

function yieldUi() {
  return new Promise((r) => setTimeout(r, 0));
}

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) addFiles(fileInput.files);
});
["dragenter", "dragover"].forEach((type) => {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((type) => {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
  });
});
drop.addEventListener("drop", (e) => {
  const files = e.dataTransfer?.files;
  if (files?.length) addFiles(files);
});

clearBtn.addEventListener("click", clearAll);
downloadBtn.addEventListener("click", downloadPng);

updateButtons();
