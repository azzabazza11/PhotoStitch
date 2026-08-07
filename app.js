import {
  cropImage,
  effectiveCrop,
  matchTwoTiles,
  snapNearOffset,
  scoreOverlapAt,
  paintAgreementOverlay,
  compositeMontage,
  padWorkspace,
  workspacePadFor,
} from "./stitcher.js?v=12";

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
const workspace2Btn = document.getElementById("workspace2Btn");
const matchBtn = document.getElementById("matchBtn");
const lockBtn = document.getElementById("lockBtn");
const unlockBtn = document.getElementById("unlockBtn");
const returnBtn = document.getElementById("returnBtn");
const panesEl = document.getElementById("panes");
const cropInput = document.getElementById("crop");
const thresholdInput = document.getElementById("threshold");
const thresholdOut = document.getElementById("thresholdOut");
const scaleSelect = document.getElementById("scale");
const cropPreview = document.getElementById("cropPreview");
const cropCanvas = document.getElementById("cropCanvas");
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
    padX: 0,
    padY: 0,
    /** Once true, never auto-fit — only wheel zoom changes scale */
    userZoomed: false,
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
    padX: 0,
    padY: 0,
    userZoomed: false,
  },
};

/** @type {"a" | "b"} */
let focusedPane = "a";
let workspaceBVisible = false;

function setWorkspaceBVisible(on) {
  workspaceBVisible = Boolean(on);
  panes.b.el.hidden = !workspaceBVisible;
  panesEl.classList.toggle("single", !workspaceBVisible);
  workspace2Btn.setAttribute("aria-pressed", workspaceBVisible ? "true" : "false");
  workspace2Btn.textContent = workspaceBVisible ? "Hide B" : "+ Workspace";
  if (!workspaceBVisible && focusedPane === "b") {
    setFocusedPane("a");
  }
  // Do not auto-fit zoom — keep the user's scale
}

function toggleWorkspaceB() {
  setWorkspaceBVisible(!workspaceBVisible);
  setStatus(
    workspaceBVisible
      ? "Workspace B shown — drop a second montage here."
      : "Workspace B hidden — A uses the full area."
  );
}

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

/** @type {string[]} selected loaded ids */
let selection = [];

/** Locked tile ids — cannot be re-dragged until Unlock */
/** @type {Set<string>} */
let lockedIds = new Set();

let busy = false;

/** Drag state */
let dragIndex = null;
let dragMoved = false;
let pointerId = null;
/** @type {HTMLCanvasElement | null} */
let dragBaseCanvas = null;
/** @type {HTMLCanvasElement | null} */
let dragCoreCanvas = null;
/** @type {{ minX: number, minY: number } | null} */
let dragBaseOrigin = null;
/** @type {{ x: number, y: number }} */
let dragPad = { x: 0, y: 0 };
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
  if (id === "b" && !workspaceBVisible) {
    setWorkspaceBVisible(true);
  }
  focusedPane = id;
  for (const p of Object.values(panes)) {
    p.el.classList.toggle("focused", p.id === id);
  }
  // Only fit when explicitly requested and user hasn't scroll-zoomed this pane
  if (fit && !panes[id].userZoomed) fitPaneZoom(id);
  updateButtons();
}

function applyPaneZoom(id) {
  const p = panes[id];
  p.stage.style.transform = `scale(${p.zoom})`;
  p.zoomEl.textContent = `${Math.round(p.zoom * 100)}%`;
}

/** Fit once for empty→first content only; never overrides user scroll-zoom. */
function fitPaneZoom(id) {
  const p = panes[id];
  if (p.userZoomed) {
    applyPaneZoom(id);
    return;
  }
  if (!p.canvas.width) {
    p.zoom = 1;
    applyPaneZoom(id);
    return;
  }
  const availW = Math.max(40, p.wrap.clientWidth - 16);
  const availH = Math.max(40, p.wrap.clientHeight - 16);
  const sx = availW / p.canvas.width;
  const sy = availH / p.canvas.height;
  p.zoom = Math.min(1.15, Math.max(0.08, Math.min(sx, sy) * 0.96));
  applyPaneZoom(id);
}

function updateButtons() {
  const hasResult = Boolean(pane().result);
  clearBtn.disabled = busy || (loaded.length === 0 && !hasResult && history.length === 0);
  undoBtn.disabled = busy || history.length === 0;
  downloadBtn.disabled = busy || !hasResult;

  const selectedIdx = selection.map((id) => indexById(id)).filter((i) => i >= 0);
  const placedSel = selectedIdx.filter((i) => tileGroup.has(i));
  const lockedSel = selection.filter((id) => lockedIds.has(id));
  const unlockedPlaced = placedSel.filter((i) => !lockedIds.has(tiles[i].id));

  matchBtn.disabled = busy || selection.length !== 2;
  lockBtn.disabled = busy || unlockedPlaced.length === 0;
  unlockBtn.disabled = busy || lockedSel.length === 0;
  returnBtn.disabled = busy || placedSel.length === 0;
}

function updateCounts() {
  const placed = tileGroup.size;
  const locked = lockedIds.size;
  const sel = selection.length;
  const parts = [];
  if (loaded.length) parts.push(`${loaded.length} loaded`);
  if (placed) parts.push(`${placed} placed`);
  if (locked) parts.push(`${locked} locked`);
  if (sel) parts.push(`${sel} selected`);
  if (groups.size) parts.push(`${groups.size} group${groups.size === 1 ? "" : "s"}`);
  countsEl.textContent = parts.join(" · ");
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
  history = [];
  selection = [];
  lockedIds = new Set();
  panes.a.userZoomed = false;
  panes.b.userZoomed = false;
  refreshAllPreviews();
  renderThumbs();
  updateThumbSize();
}

function showPreviewOnPane(id, tightCanvas, movingIndex = -1) {
  const p = panes[id];
  const hadContent = Boolean(p.result);
  const pad = workspacePadFor(tiles, movingIndex);
  const { canvas: padded, padX, padY } = padWorkspace(tightCanvas, pad.x, pad.y);
  p.padX = padX;
  p.padY = padY;
  p.result = tightCanvas;
  const ctx = p.canvas.getContext("2d");
  p.canvas.width = padded.width;
  p.canvas.height = padded.height;
  ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
  ctx.drawImage(padded, 0, 0);
  p.wrap.classList.add("has-result");
  // Keep current zoom; only auto-fit the first time content appears
  if (!hadContent && !p.userZoomed) fitPaneZoom(id);
  else applyPaneZoom(id);
  updateButtons();
}

function clearPanePreview(id) {
  const p = panes[id];
  p.canvas.width = 0;
  p.canvas.height = 0;
  p.wrap.classList.remove("has-result");
  p.result = null;
  p.padX = 0;
  p.padY = 0;
  p.zoom = 1;
  p.userZoomed = false;
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
  const gid = groupForPane(id);

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
    if (lockedIds.has(item.id)) wrap.classList.add("locked");

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.url;
    img.alt = item.file.name;
    img.draggable = false;

    const meta = document.createElement("span");
    meta.className = "thumb-meta";
    if (lockedIds.has(item.id)) meta.textContent = gid ? `${gid} · locked` : "locked";
    else if (gid) meta.textContent = gid;
    else if (selection.includes(item.id)) {
      const n = selection.indexOf(item.id) + 1;
      meta.textContent = selection.length <= 2 ? (n === 1 ? "1st" : "2nd") : `#${n}`;
    } else meta.textContent = item.file.name;

    if (gid) {
      const badge = document.createElement("span");
      badge.className = "group-badge";
      badge.textContent = lockedIds.has(item.id) ? `${gid}·L` : gid;
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
      onThumbClick(item.id, e);
    });

    wrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const i = indexById(item.id);
      if (lockedIds.has(item.id) && tileGroup.has(i)) {
        // Still allow click-select; block drag start for locked
        return;
      }
      startDrag(e, i, wrap);
    });

    thumbs.appendChild(wrap);
  }
  updateButtons();
  updateCounts();
}

function onThumbClick(id, e = null) {
  if (busy) return;

  const multi = e && (e.ctrlKey || e.metaKey);

  if (multi) {
    if (selection.includes(id)) selection = selection.filter((x) => x !== id);
    else selection.push(id);
    renderThumbs();
    setStatus(
      selection.length
        ? `${selection.length} selected — Lock / Unlock / Return / Del, or Match when exactly 2.`
        : "Selection cleared."
    );
    return;
  }

  if (selection.includes(id) && selection.length === 1) {
    selection = [];
    renderThumbs();
    setStatus("Selection cleared. Click tiles to select, or drag onto a workspace.");
    return;
  }

  if (selection.length === 1 && selection[0] !== id) {
    selection = [selection[0], id];
    renderThumbs();
    runPairMatch(selection[0], selection[1]);
    return;
  }

  selection = [id];
  renderThumbs();
  const idx = indexById(id);
  const placed = tileGroup.has(idx);
  setStatus(
    placed
      ? lockedIds.has(id)
        ? "Locked tile selected — Unlock to re-drag, or Ctrl+click more to Unlock/Return."
        : "Placed tile selected — drag to re-fit, Ctrl+click to multi-select, or click another to match."
      : "Select a second overlapping image (or drag this one onto a workspace)."
  );
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
      setStatus("No confident match — try drag-snap or lower confidence.", "error");
      selection = [];
      renderThumbs();
      return;
    }

    const gA = tileGroup.get(iA);
    const gB = tileGroup.get(iB);

    if (!gA && !gB) {
      applyJoin({
        paneId,
        targetGroupId: null,
        abs: new Map([[iA, { dx: 0, dy: 0 }]]),
        place: { index: iB, dx: hit.dx, dy: hit.dy },
        score: hit.score,
        edge: hit.edge,
      });
      return;
    }
    if (gA && !gB) {
      const abs = new Map(groups.get(gA));
      const aPos = abs.get(iA);
      applyJoin({
        paneId,
        targetGroupId: gA,
        place: { index: iB, dx: aPos.dx + hit.dx, dy: aPos.dy + hit.dy },
        score: hit.score,
        edge: hit.edge,
      });
      return;
    }
    if (!gA && gB) {
      const abs = new Map(groups.get(gB));
      const bPos = abs.get(iB);
      applyJoin({
        paneId,
        targetGroupId: gB,
        place: { index: iA, dx: bPos.dx - hit.dx, dy: bPos.dy - hit.dy },
        score: hit.score,
        edge: hit.edge,
      });
      return;
    }
    if (gA && gB && gA !== gB) {
      const aPos = groups.get(gA).get(iA);
      const bPos = groups.get(gB).get(iB);
      applyJoin({
        paneId,
        targetGroupId: gA,
        mergeGroupId: gB,
        mergeDelta: {
          dx: aPos.dx + hit.dx - bPos.dx,
          dy: aPos.dy + hit.dy - bPos.dy,
        },
        score: hit.score,
        edge: hit.edge,
        message: `Merged ${gB} → ${gA} (${hit.score.toFixed(3)} · ${hit.edge}).`,
      });
      return;
    }
    if (gA && gB && gA === gB) {
      const aPos = groups.get(gA).get(iA);
      applyJoin({
        paneId,
        targetGroupId: gA,
        place: { index: iB, dx: aPos.dx + hit.dx, dy: aPos.dy + hit.dy },
        score: hit.score,
        edge: hit.edge,
        realign: true,
      });
      return;
    }
    setStatus("Could not join that pair.", "error");
    selection = [];
    renderThumbs();
  } finally {
    busy = false;
    updateButtons();
  }
}

/**
 * Commit a join/snap/merge immediately (no Accept/Reject).
 * @param {{
 *   paneId: "a"|"b",
 *   targetGroupId: string|null,
 *   place?: { index: number, dx: number, dy: number },
 *   abs?: Map<number, {dx:number,dy:number}>,
 *   mergeGroupId?: string|null,
 *   mergeDelta?: { dx: number, dy: number },
 *   score?: number,
 *   edge?: string,
 *   realign?: boolean,
 *   message?: string,
 * }} spec
 */
function applyJoin(spec) {
  if (!spec.skipHistory) pushHistory();
  const paneId = spec.paneId || focusedPane;

  if (spec.mergeGroupId && spec.targetGroupId) {
    const target = groups.get(spec.targetGroupId);
    const other = groups.get(spec.mergeGroupId);
    const delta = spec.mergeDelta;
    for (const [ti, pos] of other) {
      target.set(ti, { dx: pos.dx + delta.dx, dy: pos.dy + delta.dy });
      tileGroup.set(ti, spec.targetGroupId);
    }
    groups.delete(spec.mergeGroupId);
    for (const pan of Object.values(panes)) {
      if (pan.groupId === spec.mergeGroupId) pan.groupId = spec.targetGroupId;
    }
    panes[paneId].groupId = spec.targetGroupId;
  } else if (!spec.targetGroupId && spec.abs && spec.place) {
    const gid = `G${nextGroup++}`;
    const abs = new Map(spec.abs);
    abs.set(spec.place.index, { dx: spec.place.dx, dy: spec.place.dy });
    groups.set(gid, abs);
    for (const ti of abs.keys()) tileGroup.set(ti, gid);
    panes[paneId].groupId = gid;
  } else if (spec.targetGroupId && spec.place) {
    const abs = groups.get(spec.targetGroupId);
    abs.set(spec.place.index, { dx: spec.place.dx, dy: spec.place.dy });
    tileGroup.set(spec.place.index, spec.targetGroupId);
    panes[paneId].groupId = spec.targetGroupId;
  }

  selection = spec.place ? [tiles[spec.place.index].id] : [];
  refreshAllPreviews();
  renderThumbs();
  updateCounts();
  updateButtons();

  const scoreBit =
    spec.score != null ? ` ${spec.score.toFixed(3)}${spec.edge ? ` · ${spec.edge}` : ""}` : "";
  setStatus(
    spec.message ||
      (spec.realign
        ? `Re-fit applied.${scoreBit} Drag again to refine, or Lock when ready.`
        : `Joined.${scoreBit} Re-drag to refine, Lock when ready.`)
  );
}

function lockSelected() {
  if (busy) return;
  const ids = selection.filter((id) => {
    const i = indexById(id);
    return i >= 0 && tileGroup.has(i);
  });
  if (!ids.length) {
    setStatus("Select placed tiles to lock.", "error");
    return;
  }
  pushHistory();
  for (const id of ids) lockedIds.add(id);
  renderThumbs();
  updateButtons();
  updateCounts();
  setStatus(`Locked ${ids.length} tile${ids.length === 1 ? "" : "s"} — Unlock to move again.`);
}

function unlockSelected() {
  if (busy) return;
  const ids = selection.filter((id) => lockedIds.has(id));
  if (!ids.length) {
    setStatus("Select locked tiles to unlock.", "error");
    return;
  }
  pushHistory();
  for (const id of ids) lockedIds.delete(id);
  renderThumbs();
  updateButtons();
  updateCounts();
  setStatus(`Unlocked ${ids.length} tile${ids.length === 1 ? "" : "s"} — drag to re-fit.`);
}

function returnSelectedToRail() {
  if (busy) return;
  const ids = selection.filter((id) => {
    const i = indexById(id);
    return i >= 0 && tileGroup.has(i);
  });
  if (!ids.length) {
    setStatus("Select placed tiles to return to the photo rail.", "error");
    return;
  }
  unplaceByIds(ids);
  setStatus(`Returned ${ids.length} tile${ids.length === 1 ? "" : "s"} to the left rail.`);
}

function unplaceByIds(ids, { recordHistory = true } = {}) {
  if (recordHistory) pushHistory();
  for (const id of ids) {
    const idx = indexById(id);
    if (idx < 0) continue;
    const gid = tileGroup.get(idx);
    if (!gid) continue;
    const abs = groups.get(gid);
    if (abs) {
      abs.delete(idx);
      if (abs.size === 0) {
        groups.delete(gid);
        for (const pan of Object.values(panes)) {
          if (pan.groupId === gid) pan.groupId = null;
        }
      }
    }
    tileGroup.delete(idx);
    lockedIds.delete(id);
  }
  selection = selection.filter((id) => loaded.some((l) => l.id === id));
  refreshAllPreviews();
  renderThumbs();
  updateCounts();
  updateButtons();
}

function removeSelectedPhotos() {
  if (busy) return;
  if (!selection.length) return;
  const ids = [...selection];
  pushHistory();
  unplaceByIds(ids, { recordHistory: false });
  const idSet = new Set(ids);
  for (const item of loaded) {
    if (idSet.has(item.id)) URL.revokeObjectURL(item.url);
  }
  const placements = snapshotPlacementsById();
  const lockedSnap = [...lockedIds].filter((id) => !idSet.has(id));
  loaded = loaded.filter((l) => !idSet.has(l.id));
  const cropPx = Number(cropInput.value) || 0;
  tiles = loaded.map((item) => {
    const cropped = cropImage(item.img, cropPx, item.file.name);
    return { ...cropped, id: item.id };
  });
  restorePlacementsById(placements);
  lockedIds = new Set(lockedSnap.filter((id) => indexById(id) >= 0));
  selection = [];
  updateCropPreview();
  updateThumbSize();
  refreshAllPreviews();
  renderThumbs();
  updateCounts();
  updateButtons();
  setStatus(`Removed ${ids.length} photo${ids.length === 1 ? "" : "s"}.`);
}

function matchSelected() {
  if (selection.length !== 2) return;
  runPairMatch(selection[0], selection[1]);
}

function absWithoutTile(gid, excludeIndex) {
  const abs = new Map(groups.get(gid));
  abs.delete(excludeIndex);
  return abs;
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
    lockedIds: [...lockedIds],
  });
  if (history.length > 80) history.shift();
  updateButtons();
}

function undoLast() {
  if (!history.length || busy) return;
  const snap = history.pop();
  nextGroup = snap.nextGroup;
  panes.a.groupId = snap.paneGroups.a;
  panes.b.groupId = snap.paneGroups.b;
  restorePlacementsById(snap.placements);
  lockedIds = new Set(snap.lockedIds || []);
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
      ? `Undid last change. ${tileGroup.size} tiles placed.`
      : "Undid last change. Montage cleared — join again when ready."
  );
}

window.addEventListener("keydown", (e) => {
  if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "z") {
    e.preventDefault();
    undoLast();
    return;
  }
  if (key === "delete" || key === "backspace") {
    if (selection.length) {
      e.preventDefault();
      removeSelectedPhotos();
    }
    return;
  }
  if (key === "l" && !lockBtn.disabled) {
    e.preventDefault();
    lockSelected();
  } else if (key === "u" && !unlockBtn.disabled) {
    e.preventDefault();
    unlockSelected();
  }
});

function reorderThumbs(fromId, beforeId) {
  if (fromId === beforeId) return false;
  const from = loaded.findIndex((l) => l.id === fromId);
  if (from < 0) return false;

  const placements = snapshotPlacementsById();

  const next = [...loaded];
  const [moved] = next.splice(from, 1);
  let insertAt = beforeId ? next.findIndex((l) => l.id === beforeId) : next.length;
  if (insertAt < 0) insertAt = next.length;
  next.splice(insertAt, 0, moved);
  loaded = next;
  tiles = loaded.map((l) => tiles.find((t) => t.id === l.id));

  restorePlacementsById(placements);
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
    if (id === "b" && !workspaceBVisible) continue;
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

function prepareDragBase(paneId, movingIndex = -1) {
  const gid = groupForPane(paneId);
  if (!gid) {
    dragBaseCanvas = null;
    dragCoreCanvas = null;
    dragBaseOrigin = null;
    dragPad = { x: 0, y: 0 };
    return null;
  }
  const baseAbs =
    movingIndex >= 0 && tileGroup.get(movingIndex) === gid
      ? absWithoutTile(gid, movingIndex)
      : new Map(groups.get(gid));
  if (!baseAbs.size && movingIndex >= 0 && tileGroup.get(movingIndex) === gid) {
    // Only this tile in the group — treat as empty base for reposition seed
    dragBaseCanvas = null;
    dragCoreCanvas = null;
    dragBaseOrigin = null;
    dragPad = { x: 0, y: 0 };
    return gid;
  }
  if (!baseAbs.size) {
    dragBaseCanvas = null;
    dragCoreCanvas = null;
    dragBaseOrigin = null;
    dragPad = { x: 0, y: 0 };
    return null;
  }
  const { canvas, origin } = compositeMontage(tiles, baseAbs, null);
  const pad = workspacePadFor(tiles, movingIndex);
  const { canvas: padded, padX, padY } = padWorkspace(canvas, pad.x, pad.y);
  dragCoreCanvas = canvas;
  dragBaseCanvas = padded;
  dragBaseOrigin = origin;
  dragPad = { x: padX, y: padY };
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

/**
 * Grow padded workspace so the moving tile stays fully visible.
 */
function autoScrollWrap(wrap, clientX, clientY) {
  const rect = wrap.getBoundingClientRect();
  const edge = 56;
  let dx = 0;
  let dy = 0;
  if (clientX < rect.left + edge) dx = -Math.ceil((edge - (clientX - rect.left)) / 3);
  else if (clientX > rect.right - edge) dx = Math.ceil((edge - (rect.right - clientX)) / 3);
  if (clientY < rect.top + edge) dy = -Math.ceil((edge - (clientY - rect.top)) / 3);
  else if (clientY > rect.bottom - edge) dy = Math.ceil((edge - (rect.bottom - clientY)) / 3);
  if (dx) wrap.scrollLeft += dx;
  if (dy) wrap.scrollTop += dy;
}

function updateMontageDragPreview(movingIndex, clientX, clientY, paneId) {
  const p = panes[paneId];
  if (!dragBaseCanvas || !dragBaseOrigin || !dragCoreCanvas) return false;

  autoScrollWrap(p.wrap, clientX, clientY);

  // Keep display canvas size locked to drag base — no mid-drag resize (avoids zoom/pan jumps)
  if (p.canvas.width !== dragBaseCanvas.width || p.canvas.height !== dragBaseCanvas.height) {
    p.canvas.width = dragBaseCanvas.width;
    p.canvas.height = dragBaseCanvas.height;
    p.padX = dragPad.x;
    p.padY = dragPad.y;
    p.wrap.classList.add("has-result");
    applyPaneZoom(paneId);
  }

  const mapped = canvasPointerToLocal(p, clientX, clientY);
  if (!mapped) return false;
  const drawX = mapped.localX - tiles[movingIndex].width / 2;
  const drawY = mapped.localY - tiles[movingIndex].height / 2;

  const ctx = p.canvas.getContext("2d");
  ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
  ctx.drawImage(dragBaseCanvas, 0, 0);

  if (agreementCanvas) {
    ctx.drawImage(agreementCanvas, dragPad.x, dragPad.y);
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

  const coreX = drawX - dragPad.x;
  const coreY = drawY - dragPad.y;

  const now = performance.now();
  if (now - dragScoreTimer < 120) return true;
  dragScoreTimer = now;

  const score = scoreOverlapAt(dragCoreCanvas, tiles[movingIndex], coreX, coreY);
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
      dragCoreCanvas,
      tiles[movingIndex],
      coreX,
      coreY,
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
  dragCoreCanvas = null;
  dragBaseOrigin = null;
  dragPad = { x: 0, y: 0 };
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

function startDrag(e, index, originEl = null) {
  if (busy) return;
  const tileId = tiles[index]?.id;
  if (!tileId) return;
  if (lockedIds.has(tileId) && tileGroup.has(index)) {
    setStatus("That tile is locked — Unlock it before re-dragging.", "error");
    return;
  }

  const fromId = tileId;
  dragIndex = index;
  dragMoved = false;
  pointerId = e.pointerId;
  const captureEl = originEl || e.currentTarget;
  try {
    captureEl?.setPointerCapture?.(e.pointerId);
  } catch (_) {}

  const loadedIdx = loaded.findIndex((l) => l.id === fromId);
  let lastHover = null;
  const canLiveSnap = !lockedIds.has(fromId);

  document.body.classList.add("dragging-work");

  const onMove = (ev) => {
    if (ev.pointerId !== pointerId) return;
    if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 6) {
      dragMoved = true;
    }
    if (!dragMoved) return;

    captureEl?.classList?.add("drag-source");
    autoScrollRail(ev.clientY);

    const overPane = paneAtPoint(ev.clientX, ev.clientY);
    for (const p of Object.values(panes)) {
      p.el.classList.toggle("drop-hot", p.id === overPane);
    }

    if (overPane && canLiveSnap) {
      if (dragTargetPane !== overPane) {
        dragTargetPane = overPane;
        setFocusedPane(overPane);
        prepareDragBase(overPane, index);
        // Keep zoom as-is — do not auto-zoom on drag enter
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

      // Empty pane (or sole-tile group lifted): show ghost
      dragGhost.hidden = false;
      dragGhost.style.backgroundImage = `url(${loaded[loadedIdx].url})`;
      const size = Math.min(200, Math.max(100, tiles[index].width * panes[overPane].zoom * 0.35));
      dragGhost.style.width = `${size}px`;
      dragGhost.style.height = `${size}px`;
      dragGhost.style.left = `${ev.clientX - size / 2}px`;
      dragGhost.style.top = `${ev.clientY - size / 2}px`;
      hideLiveConf();
      setStatus(`Drop to start / place in Workspace ${overPane.toUpperCase()}.`, "busy");
      return;
    }

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
    if (hover && hover !== captureEl) {
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
    const dropRect = drop.getBoundingClientRect();
    const overThumbs =
      ev.clientX >= thumbsRect.left &&
      ev.clientX <= thumbsRect.right &&
      ev.clientY >= thumbsRect.top &&
      ev.clientY <= thumbsRect.bottom;
    const overDropZone =
      ev.clientX >= dropRect.left &&
      ev.clientX <= dropRect.right &&
      ev.clientY >= dropRect.top &&
      ev.clientY <= dropRect.bottom;

    const hover = thumbAtPoint(ev.clientX, ev.clientY);

    // Return placed tile to rail when dropped on drop-zone or empty rail (not on another thumb)
    if (tileGroup.has(i) && (overDropZone || (overThumbs && !hover))) {
      clearMontageDragPreview();
      unplaceByIds([fromId]);
      setStatus(`Returned “${tiles[i]?.name || fromId}” to the left rail.`);
      setTimeout(() => {
        dragMoved = false;
      }, 0);
      return;
    }

    if (overThumbs || (hover && hover.dataset.id && hover.dataset.id !== fromId)) {
      clearMontageDragPreview();
      refreshAllPreviews();
      const beforeId = hover && hover.dataset.id !== fromId ? hover.dataset.id : null;
      if (reorderThumbs(fromId, beforeId)) {
        selection = selection.filter((id) => loaded.some((l) => l.id === id));
        renderThumbs();
        updateCounts();
        setStatus("Shuffled. Click two to match, or drag onto a workspace.");
      }
      setTimeout(() => {
        dragMoved = false;
      }, 0);
      return;
    }

    const overPane = paneAtPoint(ev.clientX, ev.clientY);
    if (overPane) {
      setFocusedPane(overPane);
      const rect = panes[overPane].canvas.getBoundingClientRect();
      finishDragSnap(i, ev.clientX, ev.clientY, rect, overPane).finally(() => {
        clearMontageDragPreview();
      });
      return;
    }

    clearMontageDragPreview();
    refreshAllPreviews();
    setStatus("Drop on a workspace to snap, or on the left rail to return / shuffle.");
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
    const wasInGroup = tileGroup.get(movingIndex);
    const realigning = Boolean(wasInGroup && wasInGroup === gid);

    if (!gid) {
      pushHistory();
      if (wasInGroup) {
        unplaceByIds([tiles[movingIndex].id], { recordHistory: false });
      }
      const newG = `G${nextGroup++}`;
      groups.set(newG, new Map([[movingIndex, { dx: 0, dy: 0 }]]));
      tileGroup.set(movingIndex, newG);
      panes[paneId].groupId = newG;
      selection = [tiles[movingIndex].id];
      refreshAllPreviews();
      renderThumbs();
      updateCounts();
      updateButtons();
      setStatus(
        `Started ${newG} in Workspace ${paneId.toUpperCase()} with “${tiles[movingIndex].name}”. Drag another tile onto it.`
      );
      return;
    }

    if (wasInGroup && wasInGroup !== gid) {
      pushHistory();
      unplaceByIds([tiles[movingIndex].id], { recordHistory: false });
    }

    const baseAbs = realigning ? absWithoutTile(gid, movingIndex) : new Map(groups.get(gid));
    if (!baseAbs.size) {
      if (!(wasInGroup && wasInGroup !== gid)) pushHistory();
      groups.get(gid).set(movingIndex, { dx: 0, dy: 0 });
      tileGroup.set(movingIndex, gid);
      selection = [tiles[movingIndex].id];
      refreshAllPreviews();
      renderThumbs();
      updateCounts();
      updateButtons();
      setStatus("Tile reset in place. Drag another overlapping photo onto it.");
      return;
    }

    const { canvas: montageCanvas, origin } = compositeMontage(tiles, baseAbs, null);

    const p = panes[paneId];
    const liveRect = p.canvas.width ? p.canvas.getBoundingClientRect() : rect;
    const padX = dragPad.x || p.padX || 0;
    const padY = dragPad.y || p.padY || 0;
    const scaleX = (p.canvas.width || montageCanvas.width + padX * 2) / Math.max(1, liveRect.width);
    const scaleY = (p.canvas.height || montageCanvas.height + padY * 2) / Math.max(1, liveRect.height);
    const localX = (clientX - liveRect.left) * scaleX - padX;
    const localY = (clientY - liveRect.top) * scaleY - padY;

    const guessInMontage = {
      dx: localX - tiles[movingIndex].width / 2,
      dy: localY - tiles[movingIndex].height / 2,
    };

    const hit = snapNearOffset(
      { canvas: montageCanvas },
      tiles[movingIndex],
      guessInMontage.dx,
      guessInMontage.dy,
      { ...opts(), radius: 140 }
    );

    if (!hit) {
      setStatus("Snap failed — try a closer drop, or Match two thumbs.", "error");
      refreshAllPreviews();
      return;
    }

    const absDx = origin.minX + hit.dx;
    const absDy = origin.minY + hit.dy;
    const alreadyHistoric = Boolean(wasInGroup && wasInGroup !== gid);

    applyJoin({
      paneId,
      targetGroupId: gid,
      place: { index: movingIndex, dx: absDx, dy: absDy },
      score: hit.score,
      edge: hit.edge,
      realign: realigning,
      skipHistory: alreadyHistoric,
      message: hit.weak
        ? `Weak snap ${hit.score.toFixed(3)} · ${hit.edge} — drag again to refine.`
        : `${realigning ? "Re-fit" : "Snapped"} ${hit.score.toFixed(3)} · ${hit.edge}. Drag again to refine, or Lock.`,
    });
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

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Exact pixel fingerprint (dimensions + SHA-256 of RGBA buffer).
 * @param {HTMLImageElement} img
 */
async function pixelFingerprint(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `${w}x${h}:${bytesToHex(digest)}`;
}

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/"));
  if (!list.length) {
    setStatus("No image files found.", "error");
    return;
  }

  let skippedNameSize = 0;
  let skippedPixels = 0;
  let added = 0;
  /** @type {Set<string>} */
  const seenNameSize = new Set(loaded.map((l) => `${l.file.name}\0${l.file.size}`));
  /** @type {Set<string>} */
  const batchFingerprints = new Set();
  for (const item of loaded) {
    if (!item.fingerprint) {
      item.fingerprint = await pixelFingerprint(item.img);
    }
    batchFingerprints.add(item.fingerprint);
  }

  for (const file of list) {
    const nameSizeKey = `${file.name}\0${file.size}`;
    if (seenNameSize.has(nameSizeKey)) {
      skippedNameSize += 1;
      continue;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error(`Failed to load ${file.name}`));
        img.src = url;
      });
    } catch (_) {
      URL.revokeObjectURL(url);
      setStatus(`Failed to load ${file.name}.`, "error");
      continue;
    }

    const fingerprint = await pixelFingerprint(img);
    if (batchFingerprints.has(fingerprint)) {
      skippedPixels += 1;
      URL.revokeObjectURL(url);
      continue;
    }

    seenNameSize.add(nameSizeKey);
    batchFingerprints.add(fingerprint);

    loaded.push({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
      file,
      url,
      img,
      fingerprint,
    });
    added += 1;
  }

  if (!added) {
    const parts = [];
    if (skippedNameSize) parts.push(`${skippedNameSize} same name+size`);
    if (skippedPixels) parts.push(`${skippedPixels} identical pixels`);
    setStatus(
      parts.length ? `No new photos — skipped ${parts.join(", ")}.` : "No image files found.",
      "error"
    );
    return;
  }

  rebuildTiles();
  updateCropPreview();
  updateCounts();
  updateButtons();
  const skipBits = [];
  if (skippedNameSize) skipBits.push(`${skippedNameSize} name+size`);
  if (skippedPixels) skipBits.push(`${skippedPixels} pixel-identical`);
  setStatus(
    skipBits.length
      ? `Added ${added}. Skipped duplicates (${skipBits.join(", ")}).`
      : "Click two overlapping shots, or drag a free tile onto a workspace."
  );
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
  history = [];
  selection = [];
  lockedIds = new Set();
  panes.a.userZoomed = false;
  panes.b.userZoomed = false;
  clearPanePreview("a");
  clearPanePreview("b");
  cropPreview.hidden = true;
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

/**
 * Pick topmost tile under pointer in a pane (for overlap disambiguation).
 * @returns {number | null} tile index
 */
function hitTestPaneTile(paneId, clientX, clientY) {
  const gid = groupForPane(paneId);
  if (!gid) return null;
  const p = panes[paneId];
  const mapped = canvasPointerToLocal(p, clientX, clientY);
  if (!mapped) return null;
  const coreX = mapped.localX - (p.padX || 0);
  const coreY = mapped.localY - (p.padY || 0);
  const abs = groups.get(gid);
  const { origin } = compositeMontage(tiles, abs, null);
  const entries = [...abs.entries()].sort(
    (a, b) => b[1].dx + b[1].dy - (a[1].dx + a[1].dy)
  );
  for (const [i, pos] of entries) {
    const x = pos.dx - origin.minX;
    const y = pos.dy - origin.minY;
    const t = tiles[i];
    if (coreX >= x && coreX < x + t.width && coreY >= y && coreY < y + t.height) {
      return i;
    }
  }
  return null;
}

function bindPaneInteraction(paneId) {
  const p = panes[paneId];
  p.el.addEventListener("pointerdown", () => setFocusedPane(paneId));
  p.wrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setFocusedPane(paneId);
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      p.zoom = Math.min(3, Math.max(0.08, p.zoom * factor));
      p.userZoomed = true;
      applyPaneZoom(paneId);
    },
    { passive: false }
  );

  p.canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || busy) return;
    setFocusedPane(paneId);
    const hit = hitTestPaneTile(paneId, e.clientX, e.clientY);
    if (hit == null) return;
    const id = tiles[hit].id;

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      if (selection.includes(id)) selection = selection.filter((x) => x !== id);
      else selection.push(id);
      renderThumbs();
      setStatus(`${selection.length} selected from montage.`);
      return;
    }

    selection = [id];
    renderThumbs();
    if (lockedIds.has(id)) {
      setStatus("Locked tile selected — Unlock to re-drag.");
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    startDrag(e, hit, p.canvas);
  });
}

for (const id of /** @type {const} */ (["a", "b"])) {
  bindPaneInteraction(id);
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
matchBtn.addEventListener("click", matchSelected);
lockBtn.addEventListener("click", lockSelected);
unlockBtn.addEventListener("click", unlockSelected);
returnBtn.addEventListener("click", returnSelectedToRail);
workspace2Btn.addEventListener("click", toggleWorkspaceB);

window.addEventListener("resize", () => {
  // Preserve zoom/pan — only re-apply current scale after layout
  for (const id of /** @type {const} */ (["a", "b"])) {
    applyPaneZoom(id);
  }
});

setWorkspaceBVisible(false);
setFocusedPane("a");
updateThumbSize();
updateButtons();
applyPaneZoom("a");
applyPaneZoom("b");
