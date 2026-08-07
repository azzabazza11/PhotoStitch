import {
  cropImage,
  effectiveCrop,
  matchTwoTiles,
  snapNearOffset,
  scoreOverlapAt,
  paintAgreementOverlay,
  compositeMontage,
} from "./stitcher.js?v=7";

const drop = document.getElementById("drop");
const fileInput = document.getElementById("fileInput");
const thumbs = document.getElementById("thumbs");
const photoRail = document.getElementById("photoRail");
const railInner = photoRail.querySelector(".rail-inner");
const statusEl = document.getElementById("status");
const countsEl = document.getElementById("counts");
const clearBtn = document.getElementById("clearBtn");
const undoBtn = document.getElementById("undoBtn");
const downloadBtn = document.getElementById("downloadBtn");
const cropInput = document.getElementById("crop");
const thresholdInput = document.getElementById("threshold");
const thresholdOut = document.getElementById("thresholdOut");
const scaleSelect = document.getElementById("scale");
const cropPreview = document.getElementById("cropPreview");
const cropCanvas = document.getElementById("cropCanvas");
const reviewBar = document.getElementById("reviewBar");
const reviewMsg = document.getElementById("reviewMsg");
const acceptBtn = document.getElementById("acceptBtn");
const rejectBtn = document.getElementById("rejectBtn");
const dragGhost = document.getElementById("dragGhost");
const liveConf = document.getElementById("liveConf");
const liveConfFill = document.getElementById("liveConfFill");
const liveConfValue = document.getElementById("liveConfValue");

const panes = {
  a: {
    id: "a",
    el: document.getElementById("paneA"),
    wrap: document.getElementById("previewWrapA"),
    stage: document.getElementById("stageA"),
    canvas: document.getElementById("previewA"),
    zoomEl: document.getElementById("zoomA"),
    zoom: 1,
    /** @type {string | null} */
    groupId: null,
    /** @type {HTMLCanvasElement | null} */
    result: null,
  },
  b: {
    id: "b",
    el: document.getElementById("paneB"),
    wrap: document.getElementById("previewWrapB"),
    stage: document.getElementById("stageB"),
    canvas: document.getElementById("previewB"),
    zoomEl: document.getElementById("zoomB"),
    zoom: 1,
    /** @type {string | null} */
    groupId: null,
    /** @type {HTMLCanvasElement | null} */
    result: null,
  },
};

/** @type {"a" | "b"} */
let focusedPane = "a";

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

/** @type {{ placements: Map<string, { gid: string, dx: number, dy: number }>, nextGroup: number, paneGroups: { a: string | null, b: string | null } }[]} */
let history = [];

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
 *   mergeDelta?: { dx: number, dy: number },
 *   paneId: "a" | "b",
 * }}
 */
let pending = null;

let busy = false;

/** Drag state */
let dragIndex = null;
let dragMoved = false;
let pointerId = null;
/** @type {HTMLCanvasElement | null} */
let dragBaseCanvas = null;
/** @type {{ minX: number, minY: number } | null} */
let dragBaseOrigin = null;
/** @type {"a" | "b" | null} */
let dragTargetPane = null;
let dragScoreTimer = 0;
/** @type {HTMLCanvasElement | null} */
let agreementCanvas = null;
let railScrollRaf = 0;

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

function pane(id = focusedPane) {
  return panes[id];
}

function setFocusedPane(id, { fit = false } = {}) {
  focusedPane = id;
  for (const p of Object.values(panes)) {
    p.el.classList.toggle("focused", p.id === id);
  }
  if (fit) fitPaneZoom(id);
  updateButtons();
}

function applyPaneZoom(id) {
  const p = panes[id];
  p.stage.style.transform = `scale(${p.zoom})`;
  p.zoomEl.textContent = `${Math.round(p.zoom * 100)}%`;
}

function fitPaneZoom(id) {
  const p = panes[id];
  if (!p.result || !p.result.width) {
    p.zoom = 1;
    applyPaneZoom(id);
    return;
  }
  const availW = Math.max(40, p.wrap.clientWidth - 24);
  const availH = Math.max(40, p.wrap.clientHeight - 24);
  const sx = availW / p.result.width;
  const sy = availH / p.result.height;
  p.zoom = Math.min(1.25, Math.max(0.12, Math.min(sx, sy) * 0.92));
  applyPaneZoom(id);
}

function focusZoomOnDrag(id) {
  const p = panes[id];
  if (!p.result || !p.result.width) {
    p.zoom = 1;
    applyPaneZoom(id);
    return;
  }
  // Prefer larger tiles for matching: aim ~70% of wrap height for typical tile
  const tileH = tiles[0]?.height || 400;
  const target = (p.wrap.clientHeight * 0.72) / tileH;
  p.zoom = Math.min(1.4, Math.max(0.2, target));
  applyPaneZoom(id);
}

function updateButtons() {
  const hasResult = Boolean(pane().result);
  clearBtn.disabled = busy || (loaded.length === 0 && !hasResult && history.length === 0);
  undoBtn.disabled = busy || history.length === 0;
  downloadBtn.disabled = busy || !hasResult;
}

function updateCounts() {
  const placed = tileGroup.size;
  countsEl.textContent = loaded.length
    ? `${loaded.length} loaded · ${placed} placed · ${groups.size} group${groups.size === 1 ? "" : "s"}`
    : "";
}

function updateThumbSize() {
  const n = Math.max(1, loaded.length);
  // Priority: photo size for visibility, balanced with nearby count
  // Few photos → large; many → still readable but denser
  let size;
  if (n <= 4) size = 200;
  else if (n <= 8) size = 160;
  else if (n <= 14) size = 130;
  else if (n <= 22) size = 108;
  else size = 88;
  document.documentElement.style.setProperty("--thumb-size", `${size}px`);
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
  groups = new Map();
  tileGroup = new Map();
  nextGroup = 1;
  panes.a.groupId = null;
  panes.b.groupId = null;
  pending = null;
  history = [];
  selection = [];
  refreshAllPreviews();
  renderThumbs();
  updateThumbSize();
}

function showPreviewOnPane(id, canvas) {
  const p = panes[id];
  const ctx = p.canvas.getContext("2d");
  p.canvas.width = canvas.width;
  p.canvas.height = canvas.height;
  ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
  ctx.drawImage(canvas, 0, 0);
  p.wrap.classList.add("has-result");
  p.result = canvas;
  applyPaneZoom(id);
  updateButtons();
}

function clearPanePreview(id) {
  const p = panes[id];
  p.canvas.width = 0;
  p.canvas.height = 0;
  p.wrap.classList.remove("has-result");
  p.result = null;
  p.zoom = 1;
  applyPaneZoom(id);
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

function groupForPane(id) {
  const p = panes[id];
  if (p.groupId && groups.has(p.groupId)) return p.groupId;
  return null;
}

function refreshPane(id) {
  const p = panes[id];
  let gid = groupForPane(id);

  // Pending preview belongs on the pane that owns the proposal
  if (pending && pending.paneId === id) {
    if (pending.mergeGroupId && pending.targetGroupId) {
      const m = new Map(groups.get(pending.targetGroupId) || []);
      const other = groups.get(pending.mergeGroupId);
      const delta = pending.mergeDelta;
      if (other && delta) {
        for (const [ti, pos] of other) {
          m.set(ti, { dx: pos.dx + delta.dx, dy: pos.dy + delta.dy });
        }
      }
      const { canvas } = compositeMontage(tiles, m, null);
      showPreviewOnPane(id, canvas);
      return;
    }
    const abs = pending.abs;
    const { canvas } = compositeMontage(tiles, abs, pending.pending);
    showPreviewOnPane(id, canvas);
    return;
  }

  if (!gid) {
    clearPanePreview(id);
    updateButtons();
    return;
  }

  const abs = new Map(groups.get(gid));
  const { canvas } = compositeMontage(tiles, abs, null);
  showPreviewOnPane(id, canvas);
}

function refreshAllPreviews() {
  refreshPane("a");
  refreshPane("b");
  // Fit empty-ish panes once; keep user zoom on focused if they already zoomed
  for (const id of /** @type {const} */ (["a", "b"])) {
    if (panes[id].result) fitPaneZoom(id);
  }
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

    wrap.addEventListener("click", () => {
      if (dragMoved) {
        dragMoved = false;
        return;
      }
      onThumbClick(item.id);
    });

    wrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const i = indexById(item.id);
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
    setStatus(selection.length ? "Select a second image to match." : "Click two images, or drag one onto a workspace.");
    return;
  }

  if (selection.length >= 2) selection = [];
  selection.push(id);
  renderThumbs();

  if (selection.length === 1) {
    setStatus("Select a second overlapping image (or drag this one onto a workspace).");
    return;
  }

  runPairMatch(selection[0], selection[1]);
}

async function runPairMatch(idA, idB) {
  const iA = indexById(idA);
  const iB = indexById(idB);
  if (iA < 0 || iB < 0) return;

  const paneId = focusedPane;

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
      abs = new Map(groups.get(gB));
      const bPos = abs.get(iB);
      movingIndex = iA;
      pendingPos = { index: iA, dx: bPos.dx - hit.dx, dy: bPos.dy - hit.dy };
      targetGroupId = gB;
    } else if (gA && gB && gA !== gB) {
      abs = new Map(groups.get(gA));
      const aPos = abs.get(iA);
      const bAbs = groups.get(gB);
      const bPos = bAbs.get(iB);
      const deltaX = aPos.dx + hit.dx - bPos.dx;
      const deltaY = aPos.dy + hit.dy - bPos.dy;
      movingIndex = iB;
      pendingPos = { index: iB, dx: aPos.dx + hit.dx, dy: aPos.dy + hit.dy };
      targetGroupId = gA;
      mergeGroupId = gB;
      pending = {
        movingIndex,
        abs: new Map(groups.get(gA)),
        pending: pendingPos,
        score: hit.score,
        edge: hit.edge,
        targetGroupId,
        mergeGroupId,
        mergeDelta: { dx: deltaX, dy: deltaY },
        paneId,
      };
      selection = [];
      panes[paneId].groupId = gA;
      refreshAllPreviews();
      fitPaneZoom(paneId);
      showReview(`Merge ${gB} → ${gA}? score ${hit.score.toFixed(3)} · ${hit.edge}`);
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
      paneId,
    };
    selection = [];
    if (targetGroupId) panes[paneId].groupId = targetGroupId;
    refreshAllPreviews();
    fitPaneZoom(paneId);
    showReview(`Join “${tiles[movingIndex].name}”? score ${hit.score.toFixed(3)} · ${hit.edge}`);
    setStatus("Accept to lock this join, or Reject to try another pair.", "busy");
    renderThumbs();
  } finally {
    busy = false;
    updateButtons();
  }
}

function acceptPending() {
  if (!pending) return;
  pushHistory();
  const p = pending;
  const paneId = p.paneId || focusedPane;

  if (p.mergeGroupId && p.targetGroupId) {
    const target = groups.get(p.targetGroupId);
    const other = groups.get(p.mergeGroupId);
    const delta = p.mergeDelta;
    for (const [ti, pos] of other) {
      target.set(ti, { dx: pos.dx + delta.dx, dy: pos.dy + delta.dy });
      tileGroup.set(ti, p.targetGroupId);
    }
    groups.delete(p.mergeGroupId);
    for (const pan of Object.values(panes)) {
      if (pan.groupId === p.mergeGroupId) pan.groupId = p.targetGroupId;
    }
    panes[paneId].groupId = p.targetGroupId;
  } else if (!p.targetGroupId) {
    const gid = `G${nextGroup++}`;
    const abs = new Map(p.abs);
    abs.set(p.pending.index, { dx: p.pending.dx, dy: p.pending.dy });
    groups.set(gid, abs);
    for (const ti of abs.keys()) tileGroup.set(ti, gid);
    panes[paneId].groupId = gid;
  } else {
    const abs = groups.get(p.targetGroupId);
    abs.set(p.pending.index, { dx: p.pending.dx, dy: p.pending.dy });
    tileGroup.set(p.pending.index, p.targetGroupId);
    panes[paneId].groupId = p.targetGroupId;
  }

  pending = null;
  hideReview();
  refreshAllPreviews();
  fitPaneZoom(paneId);
  renderThumbs();
  updateCounts();
  updateButtons();
  setStatus(`Locked. ${tileGroup.size} tiles placed. Undo to unaccept, or keep joining.`);
}

function rejectPending() {
  if (!pending) return;
  pending = null;
  hideReview();
  selection = [];
  refreshAllPreviews();
  renderThumbs();
  setStatus("Rejected. Click two images or drag a free tile onto a workspace.");
}

function snapshotPlacementsById() {
  /** @type {Map<string, { gid: string, dx: number, dy: number }>} */
  const placements = new Map();
  for (const [gid, abs] of groups) {
    for (const [idx, pos] of abs) {
      placements.set(tiles[idx].id, { gid, dx: pos.dx, dy: pos.dy });
    }
  }
  return placements;
}

function restorePlacementsById(placements) {
  groups = new Map();
  tileGroup = new Map();
  for (const [id, p] of placements) {
    const idx = indexById(id);
    if (idx < 0) continue;
    if (!groups.has(p.gid)) groups.set(p.gid, new Map());
    groups.get(p.gid).set(idx, { dx: p.dx, dy: p.dy });
    tileGroup.set(idx, p.gid);
  }
}

function pushHistory() {
  const placements = snapshotPlacementsById();
  /** @type {Map<string, { gid: string, dx: number, dy: number }>} */
  const clone = new Map();
  for (const [id, p] of placements) {
    clone.set(id, { gid: p.gid, dx: p.dx, dy: p.dy });
  }
  history.push({
    placements: clone,
    nextGroup,
    paneGroups: { a: panes.a.groupId, b: panes.b.groupId },
  });
  if (history.length > 80) history.shift();
  updateButtons();
}

function undoLast() {
  if (!history.length || busy) return;
  if (pending) {
    pending = null;
    hideReview();
  }
  const snap = history.pop();
  nextGroup = snap.nextGroup;
  panes.a.groupId = snap.paneGroups.a;
  panes.b.groupId = snap.paneGroups.b;
  restorePlacementsById(snap.placements);
  for (const pan of Object.values(panes)) {
    if (pan.groupId && !groups.has(pan.groupId)) pan.groupId = null;
  }
  selection = [];
  refreshAllPreviews();
  renderThumbs();
  updateCounts();
  updateButtons();
  setStatus(
    history.length
      ? `Undid last accept. ${tileGroup.size} tiles placed.`
      : "Undid last accept. Montage cleared — join again when ready."
  );
}

acceptBtn.addEventListener("click", acceptPending);
rejectBtn.addEventListener("click", rejectPending);

window.addEventListener("keydown", (e) => {
  if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "z") {
    e.preventDefault();
    undoLast();
    return;
  }
  if (!pending) return;
  if (key === "a") {
    e.preventDefault();
    acceptPending();
  } else if (key === "r") {
    e.preventDefault();
    rejectPending();
  }
});

function reorderThumbs(fromId, beforeId) {
  if (fromId === beforeId) return false;
  const from = loaded.findIndex((l) => l.id === fromId);
  if (from < 0) return false;

  const placements = snapshotPlacementsById();
  const pendingMovingId = pending ? tiles[pending.movingIndex].id : null;
  const pendingAbsIds = pending
    ? [...pending.abs.entries()].map(([i, pos]) => [tiles[i].id, pos])
    : null;
  const pendingPosId = pending ? tiles[pending.pending.index].id : null;
  const pendingPos = pending ? { ...pending.pending } : null;

  const next = [...loaded];
  const [moved] = next.splice(from, 1);
  let insertAt = beforeId ? next.findIndex((l) => l.id === beforeId) : next.length;
  if (insertAt < 0) insertAt = next.length;
  next.splice(insertAt, 0, moved);
  loaded = next;
  tiles = loaded.map((l) => tiles.find((t) => t.id === l.id));

  restorePlacementsById(placements);

  if (pending && pendingMovingId && pendingAbsIds && pendingPosId) {
    const abs = new Map();
    for (const [id, pos] of pendingAbsIds) {
      const idx = indexById(id);
      if (idx >= 0) abs.set(idx, pos);
    }
    pending = {
      ...pending,
      movingIndex: indexById(pendingMovingId),
      abs,
      pending: {
        index: indexById(pendingPosId),
        dx: pendingPos.dx,
        dy: pendingPos.dy,
      },
    };
  }

  return true;
}

function hideLiveConf() {
  liveConf.hidden = true;
  liveConfFill.style.width = "0%";
  liveConfFill.className = "live-conf-fill";
  liveConfValue.textContent = "—";
}

function setLiveConf(score, weakArea = false) {
  liveConf.hidden = false;
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  liveConfFill.style.width = `${pct}%`;
  liveConfFill.className = "live-conf-fill";
  if (weakArea) {
    liveConfValue.textContent = "low overlap";
    return;
  }
  if (pct >= 80) liveConfFill.classList.add("ok");
  else if (pct >= 55) liveConfFill.classList.add("mid");
  liveConfValue.textContent = `${score.toFixed(2)}`;
}

function paneAtPoint(clientX, clientY) {
  for (const id of /** @type {const} */ (["a", "b"])) {
    const rect = panes[id].wrap.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return id;
    }
  }
  return null;
}

function prepareDragBase(paneId) {
  const gid = groupForPane(paneId);
  if (!gid) {
    dragBaseCanvas = null;
    dragBaseOrigin = null;
    return null;
  }
  const { canvas, origin } = compositeMontage(tiles, groups.get(gid), null);
  dragBaseCanvas = canvas;
  dragBaseOrigin = origin;
  return gid;
}

function canvasPointerToLocal(p, clientX, clientY) {
  const rect = p.canvas.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return null;
  const scaleX = p.canvas.width / rect.width;
  const scaleY = p.canvas.height / rect.height;
  return {
    localX: (clientX - rect.left) * scaleX,
    localY: (clientY - rect.top) * scaleY,
    rect,
  };
}

function updateMontageDragPreview(movingIndex, clientX, clientY, paneId) {
  const p = panes[paneId];
  if (!dragBaseCanvas || !dragBaseOrigin) return false;
  if (!p.canvas.width) {
    showPreviewOnPane(paneId, dragBaseCanvas);
  }

  const mapped = canvasPointerToLocal(p, clientX, clientY);
  if (!mapped) return false;
  const { localX, localY } = mapped;
  const drawX = localX - tiles[movingIndex].width / 2;
  const drawY = localY - tiles[movingIndex].height / 2;

  const ctx = p.canvas.getContext("2d");
  p.canvas.width = dragBaseCanvas.width;
  p.canvas.height = dragBaseCanvas.height;
  ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
  ctx.drawImage(dragBaseCanvas, 0, 0);

  if (agreementCanvas) {
    ctx.drawImage(agreementCanvas, 0, 0);
  }

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.drawImage(tiles[movingIndex].canvas, drawX, drawY);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(196, 232, 106, 0.95)";
  ctx.lineWidth = Math.max(2, Math.round(Math.min(p.canvas.width, p.canvas.height) / 250));
  ctx.setLineDash([8, 5]);
  ctx.strokeRect(drawX + 1, drawY + 1, tiles[movingIndex].width - 2, tiles[movingIndex].height - 2);
  ctx.restore();

  p.wrap.classList.add("has-result");

  const now = performance.now();
  if (now - dragScoreTimer < 120) return true;
  dragScoreTimer = now;

  const score = scoreOverlapAt(dragBaseCanvas, tiles[movingIndex], drawX, drawY);
  const weakArea = score.area < 24 * 24;
  setLiveConf(score.score, weakArea);
  setStatus(
    weakArea
      ? "Drag so the tile overlaps the montage — confidence needs shared pixels."
      : `Live alignment ${score.score.toFixed(2)} (NCC ${score.ncc.toFixed(2)}) — release to snap.`,
    "busy"
  );

  if (!weakArea && score.score > 0.35) {
    agreementCanvas = paintAgreementOverlay(
      dragBaseCanvas,
      tiles[movingIndex],
      drawX,
      drawY,
      agreementCanvas || undefined
    );
  } else {
    agreementCanvas = null;
  }

  return true;
}

function clearMontageDragPreview() {
  hideLiveConf();
  agreementCanvas = null;
  dragBaseCanvas = null;
  dragBaseOrigin = null;
  dragScoreTimer = 0;
  dragTargetPane = null;
  for (const p of Object.values(panes)) p.el.classList.remove("drop-hot");
}

function clearDropHighlights() {
  thumbs.classList.remove("reorder-active");
  for (const el of thumbs.querySelectorAll(".drop-target, .drag-source")) {
    el.classList.remove("drop-target", "drag-source");
  }
}

function thumbAtPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  return el?.closest?.(".thumb-wrap") || null;
}

function autoScrollRail(clientY) {
  const rect = railInner.getBoundingClientRect();
  const edge = 48;
  let dy = 0;
  if (clientY < rect.top + edge) dy = -Math.ceil((edge - (clientY - rect.top)) / 4);
  else if (clientY > rect.bottom - edge) dy = Math.ceil((edge - (rect.bottom - clientY)) / 4);
  if (!dy) return;
  if (railScrollRaf) return;
  railScrollRaf = requestAnimationFrame(() => {
    railInner.scrollTop += dy;
    railScrollRaf = 0;
  });
}

function startDrag(e, index) {
  if (busy) return;

  const fromId = tiles[index].id;
  dragIndex = index;
  dragMoved = false;
  pointerId = e.pointerId;
  const originEl = e.currentTarget;
  try {
    originEl.setPointerCapture(e.pointerId);
  } catch (_) {}

  const loadedIdx = loaded.findIndex((l) => l.id === fromId);
  let lastHover = null;
  const canLiveSnap =
    !tileGroup.has(index) || (pending && pending.movingIndex === index);

  document.body.classList.add("dragging-work");

  const onMove = (ev) => {
    if (ev.pointerId !== pointerId) return;
    if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 6) {
      dragMoved = true;
    }
    if (!dragMoved) return;

    originEl.classList.add("drag-source");
    autoScrollRail(ev.clientY);

    const overPane = paneAtPoint(ev.clientX, ev.clientY);
    for (const p of Object.values(panes)) {
      p.el.classList.toggle("drop-hot", p.id === overPane);
    }

    if (overPane && canLiveSnap) {
      if (dragTargetPane !== overPane) {
        dragTargetPane = overPane;
        setFocusedPane(overPane);
        prepareDragBase(overPane);
        focusZoomOnDrag(overPane);
      }

      if (dragBaseCanvas) {
        dragGhost.hidden = true;
        thumbs.classList.remove("reorder-active");
        if (lastHover) {
          lastHover.classList.remove("drop-target");
          lastHover = null;
        }
        updateMontageDragPreview(index, ev.clientX, ev.clientY, overPane);
        return;
      }

      // Empty pane: show ghost, ready to seed
      dragGhost.hidden = false;
      dragGhost.style.backgroundImage = `url(${loaded[loadedIdx].url})`;
      const size = Math.min(200, Math.max(100, tiles[index].width * panes[overPane].zoom * 0.35));
      dragGhost.style.width = `${size}px`;
      dragGhost.style.height = `${size}px`;
      dragGhost.style.left = `${ev.clientX - size / 2}px`;
      dragGhost.style.top = `${ev.clientY - size / 2}px`;
      hideLiveConf();
      setStatus(`Drop to start a montage in Workspace ${overPane.toUpperCase()}.`, "busy");
      return;
    }

    // Left preview mid-drag — restore base on last target
    if (dragTargetPane && dragBaseCanvas) {
      const prev = panes[dragTargetPane];
      if (prev.canvas.width) {
        const ctx = prev.canvas.getContext("2d");
        ctx.clearRect(0, 0, prev.canvas.width, prev.canvas.height);
        ctx.drawImage(dragBaseCanvas, 0, 0);
      }
    }
    hideLiveConf();
    dragTargetPane = null;

    dragGhost.hidden = false;
    dragGhost.style.backgroundImage = `url(${loaded[loadedIdx].url})`;
    const size = 148;
    dragGhost.style.width = `${size}px`;
    dragGhost.style.height = `${size}px`;
    dragGhost.style.left = `${ev.clientX - size / 2}px`;
    dragGhost.style.top = `${ev.clientY - size / 2}px`;

    thumbs.classList.add("reorder-active");

    const hover = thumbAtPoint(ev.clientX, ev.clientY);
    if (lastHover && lastHover !== hover) lastHover.classList.remove("drop-target");
    if (hover && hover !== originEl) {
      hover.classList.add("drop-target");
      lastHover = hover;
    } else {
      lastHover = null;
    }
  };

  const onUp = (ev) => {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    dragGhost.hidden = true;
    clearDropHighlights();
    hideLiveConf();
    document.body.classList.remove("dragging-work");

    const i = dragIndex;
    dragIndex = null;
    pointerId = null;

    if (!dragMoved) {
      clearMontageDragPreview();
      return;
    }

    const thumbsRect = thumbs.getBoundingClientRect();
    const overThumbs =
      ev.clientX >= thumbsRect.left &&
      ev.clientX <= thumbsRect.right &&
      ev.clientY >= thumbsRect.top &&
      ev.clientY <= thumbsRect.bottom;

    const hover = thumbAtPoint(ev.clientX, ev.clientY);
    if (overThumbs || (hover && hover.dataset.id && hover.dataset.id !== fromId)) {
      clearMontageDragPreview();
      refreshAllPreviews();
      const beforeId = hover && hover.dataset.id !== fromId ? hover.dataset.id : null;
      if (reorderThumbs(fromId, beforeId)) {
        selection = selection.filter((id) => loaded.some((l) => l.id === id));
        renderThumbs();
        updateCounts();
        setStatus("Shuffled. Click two neighbors to match, or drag a free tile onto a workspace.");
      }
      setTimeout(() => {
        dragMoved = false;
      }, 0);
      return;
    }

    const overPane = paneAtPoint(ev.clientX, ev.clientY);
    if (overPane) {
      if (pending && pending.movingIndex !== i) {
        clearMontageDragPreview();
        refreshAllPreviews();
        setStatus("Accept or Reject the current proposal first.", "error");
        setTimeout(() => {
          dragMoved = false;
        }, 0);
        return;
      }
      if (tileGroup.has(i) && !(pending && pending.movingIndex === i)) {
        clearMontageDragPreview();
        refreshAllPreviews();
        setStatus("That tile is already placed — drag a free tile onto a workspace to snap.", "error");
        setTimeout(() => {
          dragMoved = false;
        }, 0);
        return;
      }
      setFocusedPane(overPane);
      const rect = panes[overPane].canvas.getBoundingClientRect();
      finishDragSnap(i, ev.clientX, ev.clientY, rect, overPane).finally(() => {
        clearMontageDragPreview();
      });
      return;
    }

    clearMontageDragPreview();
    refreshAllPreviews();
    setStatus("Drop on the photo rail to shuffle, or on a workspace to snap.");
    setTimeout(() => {
      dragMoved = false;
    }, 0);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

async function finishDragSnap(movingIndex, clientX, clientY, rect, paneId) {
  busy = true;
  updateButtons();
  setStatus("Snapping…", "busy");

  try {
    await yieldUi();

    let gid = groupForPane(paneId);

    if (!gid) {
      pushHistory();
      const newG = `G${nextGroup++}`;
      groups.set(newG, new Map([[movingIndex, { dx: 0, dy: 0 }]]));
      tileGroup.set(movingIndex, newG);
      panes[paneId].groupId = newG;
      pending = null;
      hideReview();
      refreshAllPreviews();
      fitPaneZoom(paneId);
      renderThumbs();
      updateCounts();
      updateButtons();
      setStatus(
        `Started ${newG} in Workspace ${paneId.toUpperCase()} with “${tiles[movingIndex].name}”. Drag another tile onto it.`
      );
      return;
    }

    if (tileGroup.has(movingIndex) && tileGroup.get(movingIndex) === gid) {
      setStatus("That tile is already in this group.", "error");
      return;
    }

    const abs = groups.get(gid);
    const { canvas: montageCanvas, origin } = compositeMontage(tiles, abs, null);

    const p = panes[paneId];
    // Prefer live canvas rect if available (accounts for zoom)
    const liveRect = p.canvas.width ? p.canvas.getBoundingClientRect() : rect;
    const scaleX = (p.canvas.width || montageCanvas.width) / Math.max(1, liveRect.width);
    const scaleY = (p.canvas.height || montageCanvas.height) / Math.max(1, liveRect.height);
    const localX = (clientX - liveRect.left) * scaleX;
    const localY = (clientY - liveRect.top) * scaleY;

    const guessDx = origin.minX + localX - tiles[movingIndex].width / 2;
    const guessDy = origin.minY + localY - tiles[movingIndex].height / 2;

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
      refreshAllPreviews();
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
      paneId,
    };
    panes[paneId].groupId = gid;
    selection = [];
    refreshAllPreviews();
    fitPaneZoom(paneId);
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
  const maxW = 320;
  const maxH = 180;
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
  setStatus("Click two overlapping shots, or drag a free tile onto a workspace.");
}

function clearAll() {
  for (const item of loaded) URL.revokeObjectURL(item.url);
  loaded = [];
  tiles = [];
  groups = new Map();
  tileGroup = new Map();
  nextGroup = 1;
  panes.a.groupId = null;
  panes.b.groupId = null;
  pending = null;
  history = [];
  selection = [];
  clearPanePreview("a");
  clearPanePreview("b");
  cropPreview.hidden = true;
  hideReview();
  renderThumbs();
  updateThumbSize();
  updateCounts();
  updateButtons();
  setStatus("Waiting for images.");
  fileInput.value = "";
}

function downloadPng() {
  const p = pane();
  if (!p.result) return;
  p.result.toBlob((blob) => {
    if (!blob) {
      setStatus("Could not export PNG.", "error");
      return;
    }
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `photostitch-${p.id}-${p.result.width}x${p.result.height}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

function yieldUi() {
  return new Promise((r) => setTimeout(r, 0));
}

// Pane focus + wheel zoom
for (const id of /** @type {const} */ (["a", "b"])) {
  const p = panes[id];
  p.el.addEventListener("pointerdown", () => setFocusedPane(id));
  p.wrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setFocusedPane(id);
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      p.zoom = Math.min(3, Math.max(0.08, p.zoom * factor));
      applyPaneZoom(id);
    },
    { passive: false }
  );
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
undoBtn.addEventListener("click", undoLast);
downloadBtn.addEventListener("click", downloadPng);

window.addEventListener("resize", () => {
  for (const id of /** @type {const} */ (["a", "b"])) {
    if (panes[id].result) fitPaneZoom(id);
  }
});

setFocusedPane("a");
updateThumbSize();
updateButtons();
applyPaneZoom("a");
applyPaneZoom("b");
