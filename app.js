import {
  cropImage,
  normalizeCrop,
  isCropped,
  matchTwoTiles,
  scoreOverlapAt,
  paintAgreementOverlay,
  compositeMontage,
  padWorkspace,
  workspacePadFor,
} from "./stitcher.js?v=27";

/** Shown in the UI — bump with every Pages deploy */
const APP_VERSION = "27";

const drop = document.getElementById("drop");
const fileInput = document.getElementById("fileInput");
const thumbs = document.getElementById("thumbs");
const photoRail = document.getElementById("photoRail");
const railInner = photoRail.querySelector(".rail-inner");
const railPinBtn = document.getElementById("railPinBtn");
const workColumn = document.querySelector(".work-column");
const statusEl = document.getElementById("status");
const countsEl = document.getElementById("counts");
const appVersionEl = document.getElementById("appVersion");
const appVersionFooter = document.getElementById("appVersionFooter");
const tileMenu = document.getElementById("tileMenu");
if (appVersionEl) appVersionEl.textContent = `v${APP_VERSION}`;
if (appVersionFooter) appVersionFooter.textContent = `v${APP_VERSION}`;
document.title = `PhotoStitch v${APP_VERSION}`;
const clearBtn = document.getElementById("clearBtn");
const undoBtn = document.getElementById("undoBtn");
const downloadBtn = document.getElementById("downloadBtn");
const workspace2Btn = document.getElementById("workspace2Btn");
const matchBtn = document.getElementById("matchBtn");
const lockBtn = document.getElementById("lockBtn");
const unlockBtn = document.getElementById("unlockBtn");
const returnBtn = document.getElementById("returnBtn");
const panesEl = document.getElementById("panes");
const cropEditBtn = document.getElementById("cropEditBtn");
const restoreBtn = document.getElementById("restoreBtn");
const thresholdInput = document.getElementById("threshold");
const thresholdOut = document.getElementById("thresholdOut");
const scaleSelect = document.getElementById("scale");
const dragGhost = document.getElementById("dragGhost");
const liveConf = document.getElementById("liveConf");
const liveConfFill = document.getElementById("liveConfFill");
const liveConfValue = document.getElementById("liveConfValue");
const cropHud = document.getElementById("cropHud");
const cropFrame = document.getElementById("cropFrame");
const cropHudApply = document.getElementById("cropHudApply");
const cropHudCancel = document.getElementById("cropHudCancel");

const panes = {
  a: {
    id: "a",
    el: document.getElementById("paneA"),
    wrap: document.getElementById("previewWrapA"),
    stage: document.getElementById("stageA"),
    canvas: document.getElementById("previewA"),
    zoomEl: document.getElementById("zoomA"),
    zoom: 1,
    panX: 0,
    panY: 0,
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
    panX: 0,
    panY: 0,
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

function setRailPinned(on) {
  const pinned = Boolean(on);
  document.body.classList.toggle("rail-pinned", pinned);
  if (railPinBtn) {
    railPinBtn.setAttribute("aria-pressed", pinned ? "true" : "false");
    railPinBtn.textContent = pinned ? "Close" : "Open";
    railPinBtn.title = pinned
      ? "Collapse the photo pane (stays until you open it again)"
      : "Open the photo pane (stays open until you close it)";
  }
  try {
    localStorage.setItem("photostitch-rail-pinned", pinned ? "1" : "0");
  } catch (_) {}
  // Layout width changed — keep current zoom framing
  requestAnimationFrame(() => {
    for (const id of /** @type {const} */ (["a", "b"])) applyPaneZoom(id);
  });
}

function toggleRailPinned() {
  const next = !document.body.classList.contains("rail-pinned");
  setRailPinned(next);
  setStatus(next ? "Photo pane open — stays until you Close." : "Photo pane closed — stays until you Open.");
}

/** @type {{ id: string, file: File, url: string, img: HTMLImageElement }[]} */
let loaded = [];
/** @type {import('./stitcher.js').Tile[] | { canvas: HTMLCanvasElement, width: number, height: number, name: string, id: string }[]} */
let tiles = [];

/**
 * groups: groupId -> Map(tileIndex -> {dx,dy,z})
 * @type {Map<string, Map<number, { dx: number, dy: number, z?: number }>>}
 */
let groups = new Map();
/** @type {Map<number, string>} tileIndex -> groupId */
let tileGroup = new Map();
let nextGroup = 1;

/** @type {{ placements: Map<string, { gid: string, dx: number, dy: number, z?: number }>, nextGroup: number, paneGroups: { a: string | null, b: string | null }, lockedIds?: string[] }[]} */
let history = [];

/** @type {string[]} selected loaded ids */
let selection = [];

/** Locked tile ids — cannot be re-dragged until Unlock */
/** @type {Set<string>} */
let lockedIds = new Set();

let busy = false;
/** Collapse consecutive arrow nudges into one undo step */
let nudgeHistoryArmed = true;
let spaceHeld = false;

/** Drag state */
let dragIndex = null;
let dragMoved = false;
let pointerId = null;
/** Grab point within the tile (pixels from top-left) — keeps drag relative to click */
/** @type {{ x: number, y: number }} */
let dragGrab = { x: 0, y: 0 };
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
/**
 * Exact absolute place pose while dragging (matches live preview).
 * Frozen at pointerup before UI teardown so layout shifts cannot skew the drop.
 * @type {{ paneId: "a" | "b", dx: number, dy: number } | null}
 */
let dragLastPose = null;
let dragScoreTimer = 0;
/** @type {HTMLCanvasElement | null} */
let agreementCanvas = null;
let railScrollRaf = 0;

thresholdInput.addEventListener("input", () => {
  thresholdOut.textContent = Number(thresholdInput.value).toFixed(2);
});
thresholdInput.addEventListener("input", () => {
  thresholdOut.textContent = Number(thresholdInput.value).toFixed(2);
});

/**
 * @param {object} item
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
function getItemCrop(item) {
  if (item.crop && typeof item.crop === "object") {
    return normalizeCrop(item.img.width, item.img.height, item.crop);
  }
  if (typeof item.cropPx === "number" && item.cropPx > 0) {
    const c = item.cropPx;
    return normalizeCrop(item.img.width, item.img.height, {
      top: c,
      right: c,
      bottom: c,
      left: c,
    });
  }
  return normalizeCrop(item.img.width, item.img.height, 0);
}

function makeTileFromLoaded(item) {
  const crop = getItemCrop(item);
  item.crop = crop;
  delete item.cropPx;
  const cropped = cropImage(item.img, crop, item.file.name);
  return { ...cropped, id: item.id, crop };
}

/** Rebuild tile bitmaps from loaded[] without wiping placements. */
function rebuildTilesKeepPlacements() {
  const placements = snapshotPlacementsById();
  tiles = loaded.map(makeTileFromLoaded);
  restorePlacementsById(placements);
  refreshAllPreviews();
  renderThumbs();
  updateThumbSize();
  updateButtons();
  updateCounts();
}

/** @deprecated */
function rebuildTiles() {
  rebuildTilesKeepPlacements();
}

/**
 * Crop edit session — full source shown on montage with adjustable frame.
 * @type {null | {
 *   id: string,
 *   idx: number,
 *   paneId: "a"|"b",
 *   gid: string,
 *   z: number,
 *   fullDx: number,
 *   fullDy: number,
 *   srcW: number,
 *   srcH: number,
 *   crop: { top:number, right:number, bottom:number, left:number },
 *   savedTile: object,
 *   savedPos: { dx:number, dy:number, z?:number },
 * }}
 */
let cropEdit = null;
let cropDrag = null;

function zeroCrop() {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

function startCropEditForId(id) {
  if (busy || cropEdit) return;
  const idx = indexById(id);
  if (idx < 0) {
    setStatus("Select a placed photo on the montage to crop.", "error");
    return;
  }
  const gid = tileGroup.get(idx);
  if (!gid) {
    setStatus("Place the photo on the montage first, then Crop.", "error");
    return;
  }
  const paneId =
    panes.a.groupId === gid ? "a" : panes.b.groupId === gid ? "b" : focusedPane;
  const item = loaded.find((l) => l.id === id);
  if (!item) return;
  const crop = getItemCrop(item);
  const pos = groups.get(gid).get(idx);
  const fullDx = pos.dx - crop.left;
  const fullDy = pos.dy - crop.top;

  cropEdit = {
    id,
    idx,
    paneId,
    gid,
    z: pos.z ?? 0,
    fullDx,
    fullDy,
    srcW: item.img.width,
    srcH: item.img.height,
    crop: { ...crop },
    savedTile: tiles[idx],
    savedPos: { dx: pos.dx, dy: pos.dy, z: pos.z ?? 0 },
  };

  // Show full source on the montage while editing
  const full = cropImage(item.img, zeroCrop(), item.file.name);
  tiles[idx] = { ...full, id: item.id, crop: zeroCrop() };
  groups.get(gid).set(idx, { dx: fullDx, dy: fullDy, z: pos.z ?? 0 });

  document.body.classList.add("crop-editing");
  if (cropHud) cropHud.hidden = false;
  setFocusedPane(paneId);
  refreshAllPreviews();
  syncCropHud();
  setStatus("Drag edges/corners to crop · Apply or Cancel.");
  updateButtons();
}

function cancelCropEdit() {
  if (!cropEdit) return;
  const { idx, gid, savedTile, savedPos } = cropEdit;
  tiles[idx] = savedTile;
  if (groups.has(gid)) groups.get(gid).set(idx, { ...savedPos });
  cropEdit = null;
  cropDrag = null;
  document.body.classList.remove("crop-editing");
  if (cropHud) cropHud.hidden = true;
  refreshAllPreviews();
  renderThumbs();
  updateButtons();
  setStatus("Crop cancelled.");
}

function applyCropEdit() {
  if (!cropEdit) return;
  const edit = cropEdit;
  const item = loaded.find((l) => l.id === edit.id);
  if (!item) {
    cancelCropEdit();
    return;
  }
  pushHistory();
  const crop = normalizeCrop(edit.srcW, edit.srcH, edit.crop);
  item.crop = crop;
  delete item.cropPx;
  const cropped = cropImage(item.img, crop, item.file.name);
  tiles[edit.idx] = { ...cropped, id: item.id, crop };
  groups.get(edit.gid).set(edit.idx, {
    dx: edit.fullDx + crop.left,
    dy: edit.fullDy + crop.top,
    z: edit.z,
  });
  cropEdit = null;
  cropDrag = null;
  document.body.classList.remove("crop-editing");
  if (cropHud) cropHud.hidden = true;
  refreshAllPreviews();
  renderThumbs();
  updateButtons();
  scheduleAutosave();
  setStatus(
    isCropped(crop)
      ? `Crop applied (${crop.left}/${crop.top}/${crop.right}/${crop.bottom}px). Undo to revert.`
      : "Crop cleared (full image)."
  );
}

function uncropById(id) {
  const item = loaded.find((l) => l.id === id);
  if (!item) return;
  const old = getItemCrop(item);
  if (!isCropped(old)) {
    setStatus("That photo is not cropped.");
    return;
  }
  pushHistory();
  const idx = indexById(id);
  if (idx >= 0 && tileGroup.has(idx)) {
    const pos = groups.get(tileGroup.get(idx)).get(idx);
    pos.dx -= old.left;
    pos.dy -= old.top;
  }
  item.crop = zeroCrop();
  delete item.cropPx;
  tiles = loaded.map(makeTileFromLoaded);
  refreshAllPreviews();
  renderThumbs();
  updateButtons();
  scheduleAutosave();
  setStatus("Uncropped to full image. Undo to revert.");
}

function canvasLocalToClient(p, localX, localY) {
  const wrapRect = p.wrap.getBoundingClientRect();
  return {
    x: wrapRect.left + p.panX + localX * p.zoom,
    y: wrapRect.top + p.panY + localY * p.zoom,
  };
}

function syncCropHud() {
  if (!cropEdit || !cropFrame || !cropHud) return;
  const p = panes[cropEdit.paneId];
  const gid = cropEdit.gid;
  const abs = groups.get(gid);
  if (!abs || !p.canvas.width) return;
  const { origin } = compositeMontage(tiles, abs, null);
  const padX = p.padX || 0;
  const padY = p.padY || 0;
  const c = cropEdit.crop;
  const fullLocalX = cropEdit.fullDx - origin.minX + padX;
  const fullLocalY = cropEdit.fullDy - origin.minY + padY;
  const left = fullLocalX + c.left;
  const top = fullLocalY + c.top;
  const right = fullLocalX + cropEdit.srcW - c.right;
  const bottom = fullLocalY + cropEdit.srcH - c.bottom;
  const tl = canvasLocalToClient(p, left, top);
  const br = canvasLocalToClient(p, right, bottom);
  cropFrame.style.left = `${tl.x}px`;
  cropFrame.style.top = `${tl.y}px`;
  cropFrame.style.width = `${Math.max(8, br.x - tl.x)}px`;
  cropFrame.style.height = `${Math.max(8, br.y - tl.y)}px`;
  cropHud.hidden = false;
}

function clientToCropLocal(clientX, clientY) {
  if (!cropEdit) return null;
  const p = panes[cropEdit.paneId];
  const mapped = canvasPointerToLocal(p, clientX, clientY);
  if (!mapped) return null;
  const gid = cropEdit.gid;
  const abs = groups.get(gid);
  const { origin } = compositeMontage(tiles, abs, null);
  const padX = p.padX || 0;
  const padY = p.padY || 0;
  return {
    x: mapped.localX - padX - (cropEdit.fullDx - origin.minX),
    y: mapped.localY - padY - (cropEdit.fullDy - origin.minY),
  };
}

function onCropHandleDown(e) {
  if (!cropEdit) return;
  const handle = e.target.closest?.(".crop-handle");
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  cropDrag = {
    handle: handle.dataset.h,
    start: { ...cropEdit.crop },
  };
  const onMove = (ev) => {
    if (!cropDrag || !cropEdit) return;
    const loc = clientToCropLocal(ev.clientX, ev.clientY);
    if (!loc) return;
    const maxL = cropEdit.srcW - 32;
    const maxT = cropEdit.srcH - 32;
    let { top, right, bottom, left } = cropDrag.start;
    const h = cropDrag.handle;
    if (h.includes("n")) top = Math.max(0, Math.min(maxT, loc.y));
    if (h.includes("s")) bottom = Math.max(0, Math.min(maxT, cropEdit.srcH - loc.y));
    if (h.includes("w")) left = Math.max(0, Math.min(maxL, loc.x));
    if (h.includes("e")) right = Math.max(0, Math.min(maxL, cropEdit.srcW - loc.x));
    // Keep minimum 32px content
    if (cropEdit.srcW - left - right < 32) {
      if (h.includes("e")) right = cropEdit.srcW - left - 32;
      if (h.includes("w")) left = cropEdit.srcW - right - 32;
    }
    if (cropEdit.srcH - top - bottom < 32) {
      if (h.includes("s")) bottom = cropEdit.srcH - top - 32;
      if (h.includes("n")) top = cropEdit.srcH - bottom - 32;
    }
    cropEdit.crop = normalizeCrop(cropEdit.srcW, cropEdit.srcH, {
      top,
      right,
      bottom,
      left,
    });
    syncCropHud();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    cropDrag = null;
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

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
  p.stage.style.transform = `translate(${p.panX}px, ${p.panY}px) scale(${p.zoom})`;
  p.zoomEl.textContent = `${Math.round(p.zoom * 100)}%`;
  if (cropEdit && cropEdit.paneId === id) syncCropHud();
}

/** Zoom so the content point under the cursor stays under the cursor. */
function zoomAtClient(paneId, clientX, clientY, factor) {
  const p = panes[paneId];
  const rect = p.wrap.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const contentX = (mx - p.panX) / p.zoom;
  const contentY = (my - p.panY) / p.zoom;
  const next = Math.min(3, Math.max(0.08, p.zoom * factor));
  p.panX = mx - contentX * next;
  p.panY = my - contentY * next;
  p.zoom = next;
  p.userZoomed = true;
  applyPaneZoom(paneId);
}

/** Fit once for empty→first content only; never overrides user scroll-zoom. */
/** Fit so the photo content fills the workspace (pad stays around it for dragging). */
function fitPaneZoom(id) {
  const p = panes[id];
  if (p.userZoomed) {
    applyPaneZoom(id);
    return;
  }
  if (!p.canvas.width || !p.result?.width) {
    p.zoom = 1;
    p.panX = 0;
    p.panY = 0;
    applyPaneZoom(id);
    return;
  }
  const availW = Math.max(80, p.wrap.clientWidth - 20);
  const availH = Math.max(80, p.wrap.clientHeight - 20);
  // Fit the tight montage, not the huge padded canvas — keeps the photo large
  const contentW = p.result.width;
  const contentH = p.result.height;
  const sx = availW / contentW;
  const sy = availH / contentH;
  p.zoom = Math.min(3, Math.max(0.12, Math.min(sx, sy) * 0.92));
  // Center the content rect within the wrap (pad extends beyond)
  const padX = p.padX || 0;
  const padY = p.padY || 0;
  p.panX = (p.wrap.clientWidth - contentW * p.zoom) / 2 - padX * p.zoom;
  p.panY = (p.wrap.clientHeight - contentH * p.zoom) / 2 - padY * p.zoom;
  applyPaneZoom(id);
}

function updateButtons() {
  const hasResult = Boolean(pane().result);
  clearBtn.disabled = busy || (loaded.length === 0 && !hasResult && history.length === 0);
  undoBtn.disabled = busy || history.length === 0 || Boolean(cropEdit);
  downloadBtn.disabled = busy || !hasResult;
  const selectedIdx = selection.map((id) => indexById(id)).filter((i) => i >= 0);
  const placedSel = selectedIdx.filter((i) => tileGroup.has(i));
  if (cropEditBtn) {
    cropEditBtn.disabled = busy || Boolean(cropEdit) || placedSel.length !== 1;
  }

  const lockedSel = selection.filter((id) => lockedIds.has(id));
  const unlockedPlaced = placedSel.filter((i) => !lockedIds.has(tiles[i].id));

  matchBtn.disabled = busy || selection.length !== 2 || Boolean(cropEdit);
  lockBtn.disabled = busy || unlockedPlaced.length === 0 || Boolean(cropEdit);
  unlockBtn.disabled = busy || lockedSel.length === 0 || Boolean(cropEdit);
  returnBtn.disabled = busy || placedSel.length === 0 || Boolean(cropEdit);
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
  // Fit after layout so the photo fills Workspace A (not a tiny padded window)
  if (!hadContent && !p.userZoomed) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitPaneZoom(id);
        if (cropEdit) syncCropHud();
      });
    });
  } else {
    applyPaneZoom(id);
    if (cropEdit) syncCropHud();
  }
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
  p.panX = 0;
  p.panY = 0;
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
  const selectedIds = new Set(selection);
  const { canvas } = compositeMontage(tiles, abs, null, { selectedIds });
  showPreviewOnPane(id, canvas);
}

function refreshAllPreviews() {
  refreshPane("a");
  refreshPane("b");
}

function renderThumbs() {
  const scrollTop = railInner?.scrollTop ?? 0;
  const scrollLeft = railInner?.scrollLeft ?? 0;
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
    else if (gid) {
      meta.textContent = isCropped(getItemCrop(item)) ? `${gid} · cropped` : gid;
    } else if (selection.includes(item.id)) {
      const n = selection.indexOf(item.id) + 1;
      meta.textContent = selection.length <= 2 ? (n === 1 ? "1st" : "2nd") : `#${n}`;
    } else {
      meta.textContent = isCropped(getItemCrop(item)) ? `cropped · ${item.file.name}` : item.file.name;
    }

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

    wrap.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const i = indexById(item.id);
      if (!tileGroup.has(i)) {
        selection = [item.id];
        renderThumbs();
        refreshAllPreviews();
        setStatus("Place the tile on a workspace before changing layers.");
        return;
      }
      showTileMenu(e.clientX, e.clientY, item.id);
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
  if (railInner) {
    // Keep the photo list scrolled where the user left it (replaceChildren resets scroll)
    const prev = railInner.style.scrollBehavior;
    railInner.style.scrollBehavior = "auto";
    railInner.scrollTop = scrollTop;
    railInner.scrollLeft = scrollLeft;
    railInner.style.scrollBehavior = prev;
  }
}

function onThumbClick(id, e = null) {
  if (busy) return;
  hideTileMenu();

  const multi = e && (e.ctrlKey || e.metaKey);

  if (multi) {
    if (selection.includes(id)) selection = selection.filter((x) => x !== id);
    else selection.push(id);
    renderThumbs();
    refreshAllPreviews();
    setStatus(
      selection.length
        ? `${selection.length} selected — arrows nudge · right-click layers · Lock / Match.`
        : "Selection cleared."
    );
    return;
  }

  if (selection.includes(id) && selection.length === 1) {
    selection = [];
    renderThumbs();
    refreshAllPreviews();
    setStatus("Selection cleared. Click tiles to select, or drag onto a workspace.");
    return;
  }

  if (selection.length === 1 && selection[0] !== id) {
    selection = [selection[0], id];
    renderThumbs();
    refreshAllPreviews();
    runPairMatch(selection[0], selection[1]);
    return;
  }

  selection = [id];
  renderThumbs();
  refreshAllPreviews();
  const idx = indexById(id);
  const placed = tileGroup.has(idx);
  setStatus(
    placed
      ? lockedIds.has(id)
        ? "Locked tile selected — Unlock to re-drag; arrows disabled until Unlock."
        : "Selected — yellow outline · arrows nudge (Shift=10px) · right-click layers · ]/[."
      : "Selected — drag onto a workspace, or click another to Match."
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
      setStatus("No confident match — align by dragging, or lower confidence.", "error");
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
        abs: new Map([[iA, { dx: 0, dy: 0, z: 0 }]]),
        place: { index: iB, dx: hit.dx, dy: hit.dy, z: 1 },
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
 * Commit a join/place/merge immediately (no Accept/Reject).
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
    const zOff = maxZInGroup(spec.targetGroupId) + 1;
    for (const [ti, pos] of other) {
      target.set(ti, {
        dx: pos.dx + delta.dx,
        dy: pos.dy + delta.dy,
        z: zOff + (pos.z ?? 0),
      });
      tileGroup.set(ti, spec.targetGroupId);
    }
    groups.delete(spec.mergeGroupId);
    for (const pan of Object.values(panes)) {
      if (pan.groupId === spec.mergeGroupId) pan.groupId = spec.targetGroupId;
    }
    panes[paneId].groupId = spec.targetGroupId;
  } else if (!spec.targetGroupId && spec.abs && spec.place) {
    const gid = `G${nextGroup++}`;
    const abs = new Map();
    let z = 0;
    for (const [ti, pos] of spec.abs) {
      abs.set(ti, { dx: pos.dx, dy: pos.dy, z: pos.z ?? z++ });
    }
    abs.set(spec.place.index, {
      dx: spec.place.dx,
      dy: spec.place.dy,
      z: spec.place.z ?? z,
    });
    groups.set(gid, abs);
    for (const ti of abs.keys()) tileGroup.set(ti, gid);
    panes[paneId].groupId = gid;
  } else if (spec.targetGroupId && spec.place) {
    const abs = groups.get(spec.targetGroupId);
    const prev = abs.get(spec.place.index);
    const z =
      spec.place.z ??
      (spec.realign && prev ? prev.z ?? 0 : nextZForGroup(spec.targetGroupId));
    abs.set(spec.place.index, { dx: spec.place.dx, dy: spec.place.dy, z });
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
  tiles = loaded.map(makeTileFromLoaded);
  restorePlacementsById(placements);
  lockedIds = new Set(lockedSnap.filter((id) => indexById(id) >= 0));
  selection = [];
  updateThumbSize();
  refreshAllPreviews();
  renderThumbs();
  updateCounts();
  updateButtons();
  scheduleAutosave();
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

function maxZInGroup(gid) {
  const abs = groups.get(gid);
  if (!abs?.size) return 0;
  let m = 0;
  for (const pos of abs.values()) m = Math.max(m, pos.z ?? 0);
  return m;
}

function nextZForGroup(gid) {
  return maxZInGroup(gid) + 1;
}

/** @returns {number[]} tile indices sorted back→front */
function layerStack(gid) {
  const abs = groups.get(gid);
  if (!abs) return [];
  return [...abs.entries()]
    .sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0) || a[0] - b[0])
    .map(([i]) => i);
}

function reindexLayers(gid, orderedIndices) {
  const abs = groups.get(gid);
  if (!abs) return;
  orderedIndices.forEach((idx, i) => {
    const pos = abs.get(idx);
    if (pos) pos.z = i;
  });
}

/**
 * @param {"front" | "forward" | "backward" | "back"} action
 */
function changeLayerOrder(action) {
  const idxs = selection
    .map((id) => indexById(id))
    .filter((i) => i >= 0 && tileGroup.has(i));
  if (!idxs.length) {
    setStatus("Select a placed tile to change layer order.", "error");
    return;
  }
  const byGroup = new Map();
  for (const i of idxs) {
    const gid = tileGroup.get(i);
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(i);
  }
  pushHistory();
  for (const [gid, selected] of byGroup) {
    let stack = layerStack(gid);
    const sel = new Set(selected);
    if (action === "front") {
      const rest = stack.filter((i) => !sel.has(i));
      stack = [...rest, ...stack.filter((i) => sel.has(i))];
    } else if (action === "back") {
      const rest = stack.filter((i) => !sel.has(i));
      stack = [...stack.filter((i) => sel.has(i)), ...rest];
    } else if (action === "forward") {
      for (let i = stack.length - 2; i >= 0; i--) {
        if (sel.has(stack[i]) && !sel.has(stack[i + 1])) {
          const t = stack[i];
          stack[i] = stack[i + 1];
          stack[i + 1] = t;
        }
      }
    } else if (action === "backward") {
      for (let i = 1; i < stack.length; i++) {
        if (sel.has(stack[i]) && !sel.has(stack[i - 1])) {
          const t = stack[i];
          stack[i] = stack[i - 1];
          stack[i - 1] = t;
        }
      }
    }
    reindexLayers(gid, stack);
  }
  refreshAllPreviews();
  renderThumbs();
  updateButtons();
  setStatus(`Layer ${action === "front" || action === "forward" ? "raised" : "lowered"}.`);
}

function nudgeSelected(dx, dy) {
  const idxs = selection
    .map((id) => indexById(id))
    .filter((i) => i >= 0 && tileGroup.has(i) && !lockedIds.has(tiles[i].id));
  if (!idxs.length) {
    setStatus("Select an unlocked placed tile, then use arrow keys to nudge.", "error");
    return false;
  }
  if (nudgeHistoryArmed) {
    pushHistory();
    nudgeHistoryArmed = false;
  }
  for (const i of idxs) {
    const pos = groups.get(tileGroup.get(i)).get(i);
    pos.dx += dx;
    pos.dy += dy;
  }
  refreshAllPreviews();
  updateCounts();
  setStatus(`Nudged ${idxs.length} tile${idxs.length === 1 ? "" : "s"} by ${dx || dy}px.`);
  return true;
}

function snapshotPlacementsById() {
  /** @type {Map<string, { gid: string, dx: number, dy: number, z?: number }>} */
  const placements = new Map();
  for (const [gid, abs] of groups) {
    for (const [idx, pos] of abs) {
      placements.set(tiles[idx].id, { gid, dx: pos.dx, dy: pos.dy, z: pos.z ?? 0 });
    }
  }
  return placements;
}

function snapshotCrops() {
  /** @type {Record<string, { top:number, right:number, bottom:number, left:number }>} */
  const crops = {};
  for (const item of loaded) crops[item.id] = { ...getItemCrop(item) };
  return crops;
}

function applyCropsRecord(crops) {
  if (!crops) return;
  for (const item of loaded) {
    if (Object.prototype.hasOwnProperty.call(crops, item.id)) {
      const raw = crops[item.id];
      if (typeof raw === "number") {
        item.crop = normalizeCrop(item.img.width, item.img.height, raw);
      } else {
        item.crop = normalizeCrop(item.img.width, item.img.height, raw);
      }
      delete item.cropPx;
    }
  }
  tiles = loaded.map(makeTileFromLoaded);
}

function restorePlacementsById(placements) {
  groups = new Map();
  tileGroup = new Map();
  for (const [id, p] of placements) {
    const idx = indexById(id);
    if (idx < 0) continue;
    if (!groups.has(p.gid)) groups.set(p.gid, new Map());
    groups.get(p.gid).set(idx, { dx: p.dx, dy: p.dy, z: p.z ?? 0 });
    tileGroup.set(idx, p.gid);
  }
}

function pushHistory() {
  const placements = snapshotPlacementsById();
  /** @type {Map<string, { gid: string, dx: number, dy: number, z?: number }>} */
  const clone = new Map();
  for (const [id, p] of placements) {
    clone.set(id, { gid: p.gid, dx: p.dx, dy: p.dy, z: p.z ?? 0 });
  }
  history.push({
    placements: clone,
    crops: snapshotCrops(),
    nextGroup,
    paneGroups: { a: panes.a.groupId, b: panes.b.groupId },
    lockedIds: [...lockedIds],
  });
  if (history.length > 80) history.shift();
  updateButtons();
  scheduleAutosave();
}

function undoLast() {
  if (!history.length || busy) return;
  const snap = history.pop();
  nextGroup = snap.nextGroup;
  panes.a.groupId = snap.paneGroups.a;
  panes.b.groupId = snap.paneGroups.b;
  if (snap.crops) applyCropsRecord(snap.crops);
  else tiles = loaded.map(makeTileFromLoaded);
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
  scheduleAutosave();
  setStatus(
    history.length
      ? `Undid last change. ${tileGroup.size} tiles placed.`
      : "Undid last change. Montage cleared — join again when ready."
  );
}

window.addEventListener("keydown", (e) => {
  if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  if (e.code === "Space") {
    spaceHeld = true;
    e.preventDefault();
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "escape" && cropEdit) {
    e.preventDefault();
    cancelCropEdit();
    return;
  }
  if (key === "enter" && cropEdit) {
    e.preventDefault();
    applyCropEdit();
    return;
  }
  if (cropEdit) return; // block other shortcuts while cropping
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
  if (key === "arrowleft" || key === "arrowright" || key === "arrowup" || key === "arrowdown") {
    const step = e.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    if (key === "arrowleft") dx = -step;
    if (key === "arrowright") dx = step;
    if (key === "arrowup") dy = -step;
    if (key === "arrowdown") dy = step;
    if (nudgeSelected(dx, dy)) e.preventDefault();
    return;
  }
  if ((key === "]" || key === "[") && selection.length) {
    e.preventDefault();
    changeLayerOrder(key === "]" ? (e.shiftKey ? "front" : "forward") : e.shiftKey ? "back" : "backward");
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

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") spaceHeld = false;
  if (e.key.startsWith("Arrow")) nudgeHistoryArmed = true;
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
    // Use the full work-pane (not only the canvas wrap) so empty space counts
    const rect = panes[id].el.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return id;
    }
  }
  // Fallback: anywhere in the right work column → A when B is hidden
  if (workColumn) {
    const r = workColumn.getBoundingClientRect();
    if (
      clientX >= r.left &&
      clientX <= r.right &&
      clientY >= r.top &&
      clientY <= r.bottom
    ) {
      if (!workspaceBVisible) return "a";
      const mid = (panes.a.el.getBoundingClientRect().bottom + panes.b.el.getBoundingClientRect().top) / 2;
      return clientY < mid ? "a" : "b";
    }
  }
  return null;
}

/** Left strip of the rail only (collapsed width) — for reorder / return, not the overlay. */
function overRailColumn(clientX, clientY) {
  const rect = photoRail.getBoundingClientRect();
  const collapsed = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rail-collapsed")) || 76;
  return (
    clientX >= rect.left &&
    clientX <= rect.left + collapsed + 8 &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

function prepareDragBase(paneId, movingIndex = -1) {
  const gid = groupForPane(paneId);
  const p = panes[paneId];
  if (!gid) {
    dragBaseCanvas = null;
    dragCoreCanvas = null;
    dragBaseOrigin = null;
    dragPad = { x: 0, y: 0 };
    return null;
  }

  const fullAbs = new Map(groups.get(gid));
  const lifting =
    movingIndex >= 0 && tileGroup.get(movingIndex) === gid;
  const baseAbs = lifting ? absWithoutTile(gid, movingIndex) : new Map(fullAbs);

  // Keep the SAME frame as the current montage (including the lifted tile's bounds)
  // so picking up does not resize/re-pad and jump the view.
  const { canvas: fullTight, origin } = compositeMontage(tiles, fullAbs, null);
  const padX = p.padX || 0;
  const padY = p.padY || 0;

  const core = document.createElement("canvas");
  core.width = fullTight.width;
  core.height = fullTight.height;
  const coreCtx = core.getContext("2d");
  coreCtx.fillStyle = "#0a120e";
  coreCtx.fillRect(0, 0, core.width, core.height);
  const drawOrder = [...baseAbs.entries()].sort(
    (a, b) => (a[1].z ?? 0) - (b[1].z ?? 0) || a[0] - b[0]
  );
  for (const [i, pos] of drawOrder) {
    coreCtx.drawImage(tiles[i].canvas, pos.dx - origin.minX, pos.dy - origin.minY);
  }

  const { canvas: padded } = padWorkspace(core, padX, padY);
  dragCoreCanvas = core;
  dragBaseCanvas = padded;
  dragBaseOrigin = origin;
  dragPad = { x: padX, y: padY };

  // Match on-screen bitmap size exactly — never shrink/grow on pickup
  if (p.canvas.width !== padded.width || p.canvas.height !== padded.height) {
    // Prefer current display size if pad was already applied the same way
    if (p.canvas.width === padded.width && p.canvas.height === padded.height) {
      /* ok */
    }
  }
  return gid;
}

/**
 * Map screen pointer → canvas pixel coords using the same pan/zoom as the stage
 * transform (not getBoundingClientRect on the bitmap, which drifts with subpixels).
 */
function canvasPointerToLocal(p, clientX, clientY) {
  const wrapRect = p.wrap.getBoundingClientRect();
  if (wrapRect.width < 8 || wrapRect.height < 8) return null;
  const zoom = p.zoom || 1;
  return {
    localX: (clientX - wrapRect.left - p.panX) / zoom,
    localY: (clientY - wrapRect.top - p.panY) / zoom,
    rect: wrapRect,
  };
}

/** Absolute group pose for the moving tile under the pointer (matches live preview). */
function poseFromPointer(paneId, clientX, clientY) {
  if (!dragBaseOrigin) return null;
  const mapped = canvasPointerToLocal(panes[paneId], clientX, clientY);
  if (!mapped) return null;
  const padX = dragPad.x || 0;
  const padY = dragPad.y || 0;
  return {
    paneId,
    dx: dragBaseOrigin.minX + mapped.localX - dragGrab.x - padX,
    dy: dragBaseOrigin.minY + mapped.localY - dragGrab.y - padY,
  };
}

/**
 * Grow padded workspace so the moving tile stays fully visible.
 */
function autoScrollWrap(wrap, clientX, clientY) {
  const paneId = wrap.id === "previewWrapB" ? "b" : "a";
  const p = panes[paneId];
  const rect = wrap.getBoundingClientRect();
  const edge = 56;
  let dx = 0;
  let dy = 0;
  if (clientX < rect.left + edge) dx = Math.ceil((edge - (clientX - rect.left)) / 3);
  else if (clientX > rect.right - edge) dx = -Math.ceil((edge - (rect.right - clientX)) / 3);
  if (clientY < rect.top + edge) dy = Math.ceil((edge - (clientY - rect.top)) / 3);
  else if (clientY > rect.bottom - edge) dy = -Math.ceil((edge - (rect.bottom - clientY)) / 3);
  if (!dx && !dy) return;
  p.panX += dx;
  p.panY += dy;
  applyPaneZoom(paneId);
}

function updateMontageDragPreview(movingIndex, clientX, clientY, paneId) {
  const p = panes[paneId];
  if (!dragBaseCanvas || !dragBaseOrigin || !dragCoreCanvas) return false;

  autoScrollWrap(p.wrap, clientX, clientY);

  // Keep display canvas size locked — never resize mid-drag (avoids zoom/pan jumps)
  if (
    p.canvas.width !== dragBaseCanvas.width ||
    p.canvas.height !== dragBaseCanvas.height
  ) {
    // Size mismatch means pad/origin drifted — still avoid applyPaneZoom; just blit into current canvas
    // by drawing the base scaled? Prefer exact match from prepareDragBase.
    // If still mismatched, update size WITHOUT changing pan/zoom.
    p.canvas.width = dragBaseCanvas.width;
    p.canvas.height = dragBaseCanvas.height;
    p.padX = dragPad.x;
    p.padY = dragPad.y;
    p.wrap.classList.add("has-result");
    // Do not call applyPaneZoom / fitPaneZoom — keep view stationary
  }

  const mapped = canvasPointerToLocal(p, clientX, clientY);
  if (!mapped) return false;
  const drawX = mapped.localX - dragGrab.x;
  const drawY = mapped.localY - dragGrab.y;
  const coreX = drawX - dragPad.x;
  const coreY = drawY - dragPad.y;
  // Hard-wire place pose to what is drawn — drop must use this exact pose
  dragLastPose = {
    paneId,
    dx: dragBaseOrigin.minX + coreX,
    dy: dragBaseOrigin.minY + coreY,
  };

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

  const now = performance.now();
  if (now - dragScoreTimer < 120) return true;
  dragScoreTimer = now;

  const score = scoreOverlapAt(dragCoreCanvas, tiles[movingIndex], coreX, coreY);
  const weakArea = score.area < 24 * 24;
  setLiveConf(score.score, weakArea);
  setStatus(
    weakArea
      ? "Drag so the tile overlaps the montage — confidence needs shared pixels."
      : `Live alignment ${score.score.toFixed(2)} (NCC ${score.ncc.toFixed(2)}) — release to place where it is.`,
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
  dragGrab = { x: 0, y: 0 };
  dragLastPose = null;
  dragScoreTimer = 0;
  dragTargetPane = null;
  for (const p of Object.values(panes)) p.el.classList.remove("drop-hot");
}

function grabOffsetFromThumb(wrap, tileIndex, clientX, clientY) {
  const t = tiles[tileIndex];
  const img = wrap.querySelector?.(".thumb") || wrap;
  const r = img.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) {
    return { x: t.width / 2, y: t.height / 2 };
  }
  // object-fit: contain — map into the drawn image box, not the letterboxed element
  const scale = Math.min(r.width / t.width, r.height / t.height);
  const drawnW = t.width * scale;
  const drawnH = t.height * scale;
  const offX = (r.width - drawnW) / 2;
  const offY = (r.height - drawnH) / 2;
  return {
    x: Math.max(0, Math.min(t.width, (clientX - r.left - offX) / scale)),
    y: Math.max(0, Math.min(t.height, (clientY - r.top - offY) / scale)),
  };
}

function grabOffsetFromPane(paneId, tileIndex, clientX, clientY) {
  const t = tiles[tileIndex];
  const p = panes[paneId];
  const mapped = canvasPointerToLocal(p, clientX, clientY);
  if (!mapped) return { x: t.width / 2, y: t.height / 2 };
  const gid = groupForPane(paneId);
  if (!gid || !groups.get(gid)?.has(tileIndex)) {
    return { x: t.width / 2, y: t.height / 2 };
  }
  const abs = groups.get(gid);
  const { origin } = compositeMontage(tiles, abs, null);
  const pos = abs.get(tileIndex);
  const tileX = pos.dx - origin.minX + (p.padX || 0);
  const tileY = pos.dy - origin.minY + (p.padY || 0);
  return {
    x: Math.max(0, Math.min(t.width, mapped.localX - tileX)),
    y: Math.max(0, Math.min(t.height, mapped.localY - tileY)),
  };
}

function clearDropHighlights() {
  thumbs.classList.remove("reorder-active");
  for (const el of thumbs.querySelectorAll(".drop-target, .drag-source")) {
    el.classList.remove("drop-target", "drag-source");
  }
}

function thumbAtPoint(clientX, clientY) {
  // Geometry-based so reorder still works when the rail has pointer-events:none
  for (const wrap of thumbs.querySelectorAll(".thumb-wrap")) {
    const r = wrap.getBoundingClientRect();
    if (
      clientX >= r.left &&
      clientX <= r.right &&
      clientY >= r.top &&
      clientY <= r.bottom
    ) {
      return wrap;
    }
  }
  return null;
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

function startDrag(e, index, originEl = null, grabOffset = null) {
  if (busy || cropEdit) return;
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

  if (grabOffset) {
    dragGrab = { x: grabOffset.x, y: grabOffset.y };
  } else if (originEl?.classList?.contains("thumb-wrap")) {
    dragGrab = grabOffsetFromThumb(originEl, index, e.clientX, e.clientY);
  } else {
    dragGrab = {
      x: tiles[index].width / 2,
      y: tiles[index].height / 2,
    };
  }

  const captureEl = originEl || e.currentTarget;
  // Do not setPointerCapture on the thumb — it keeps the gesture tied to the rail
  // and makes montage drops unreliable. Window listeners handle move/up.

  const loadedIdx = loaded.findIndex((l) => l.id === fromId);
  let lastHover = null;
  /** @type {"a" | "b" | null} */
  let dragLastPane = null;
  const canLiveSnap = !lockedIds.has(fromId);

  document.body.classList.add("dragging-tile");

  // If lifting from the montage, freeze the current frame immediately so pickup
  // does not resize/re-pad and jump under the cursor.
  const homeGid = tileGroup.get(index);
  if (homeGid) {
    const homePane =
      panes.a.groupId === homeGid ? "a" : panes.b.groupId === homeGid ? "b" : focusedPane;
    dragTargetPane = homePane;
    dragLastPane = homePane;
    setFocusedPane(homePane);
    prepareDragBase(homePane, index);
    if (dragBaseCanvas) {
      updateMontageDragPreview(index, e.clientX, e.clientY, homePane);
    }
  }

  const onMove = (ev) => {
    if (ev.pointerId !== pointerId) return;
    if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 6) {
      dragMoved = true;
    }
    if (!dragMoved) return;

    captureEl?.classList?.add("drag-source");
    // Expanded rail overlays the montage — disable hit-testing for the whole drag
    photoRail.style.pointerEvents = "none";
    autoScrollRail(ev.clientY);

    const overPane = paneAtPoint(ev.clientX, ev.clientY);
    if (overPane) dragLastPane = overPane;
    document.body.classList.toggle("dragging-over-work", Boolean(overPane));
    for (const p of Object.values(panes)) {
      p.el.classList.toggle("drop-hot", p.id === overPane);
    }

    if (overPane && canLiveSnap) {
      if (dragTargetPane !== overPane) {
        dragTargetPane = overPane;
        setFocusedPane(overPane);
        prepareDragBase(overPane, index);
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

      // Empty pane: ghost follows grab point
      dragGhost.hidden = false;
      dragGhost.style.backgroundImage = `url(${loaded[loadedIdx].url})`;
      const size = Math.min(200, Math.max(100, tiles[index].width * panes[overPane].zoom * 0.35));
      const gScale = size / Math.max(tiles[index].width, 1);
      dragGhost.style.width = `${size}px`;
      dragGhost.style.height = `${size}px`;
      dragGhost.style.left = `${ev.clientX - dragGrab.x * gScale}px`;
      dragGhost.style.top = `${ev.clientY - dragGrab.y * gScale}px`;
      hideLiveConf();
      setStatus(`Drop to place in Workspace ${overPane.toUpperCase()}.`, "busy");
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
    const gScale = size / Math.max(tiles[index].width, 1);
    dragGhost.style.width = `${size}px`;
    dragGhost.style.height = `${size}px`;
    dragGhost.style.left = `${ev.clientX - dragGrab.x * gScale}px`;
    dragGhost.style.top = `${ev.clientY - dragGrab.y * gScale}px`;

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

    const i = dragIndex;
    dragIndex = null;
    pointerId = null;

    if (!dragMoved) {
      dragGhost.hidden = true;
      clearDropHighlights();
      hideLiveConf();
      document.body.classList.remove("dragging-tile", "dragging-over-work");
      photoRail.style.pointerEvents = "";
      clearMontageDragPreview();
      return;
    }

    // Freeze placement WHILE drag layout is still intact (before rail/live-conf teardown)
    const overPane = paneAtPoint(ev.clientX, ev.clientY) || dragLastPane;
    let frozenPose = null;
    if (overPane && dragBaseOrigin) {
      // Final preview frame at release point, then read that pose
      if (dragBaseCanvas) updateMontageDragPreview(i, ev.clientX, ev.clientY, overPane);
      frozenPose =
        (dragLastPose && dragLastPose.paneId === overPane ? dragLastPose : null) ||
        poseFromPointer(overPane, ev.clientX, ev.clientY);
    }

    const inRail = overRailColumn(ev.clientX, ev.clientY);
    const hover = thumbAtPoint(ev.clientX, ev.clientY);
    const dropRect = drop.getBoundingClientRect();
    const overDropZone =
      ev.clientX >= dropRect.left &&
      ev.clientX <= dropRect.right &&
      ev.clientY >= dropRect.top &&
      ev.clientY <= dropRect.bottom;

    dragGhost.hidden = true;
    clearDropHighlights();
    hideLiveConf();
    document.body.classList.remove("dragging-tile", "dragging-over-work");
    photoRail.style.pointerEvents = "";

    if (overPane) {
      setFocusedPane(overPane);
      setStatus(`Placing in Workspace ${overPane.toUpperCase()}…`, "busy");
      finishDragPlace(i, overPane, frozenPose).finally(() => {
        clearMontageDragPreview();
      });
      return;
    }

    if (tileGroup.has(i) && (overDropZone || (inRail && !hover))) {
      clearMontageDragPreview();
      unplaceByIds([fromId]);
      setStatus(`Returned “${tiles[i]?.name || fromId}” to the left rail.`);
      setTimeout(() => {
        dragMoved = false;
      }, 0);
      return;
    }

    if (inRail || (hover && hover.dataset.id && hover.dataset.id !== fromId)) {
      clearMontageDragPreview();
      refreshAllPreviews();
      const beforeId = hover && hover.dataset.id !== fromId ? hover.dataset.id : null;
      if (reorderThumbs(fromId, beforeId)) {
        selection = selection.filter((id) => loaded.some((l) => l.id === id));
        renderThumbs();
        updateCounts();
        setStatus("Shuffled. Drag onto the workspace to place.");
      }
      setTimeout(() => {
        dragMoved = false;
      }, 0);
      return;
    }

    clearMontageDragPreview();
    refreshAllPreviews();
    setStatus("Drop on the workspace (right) to place, or on the left rail to shuffle.");
    setTimeout(() => {
      dragMoved = false;
    }, 0);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

/**
 * Place the tile at the frozen preview pose — no remapping, no auto-snap.
 * @param {number} movingIndex
 * @param {"a" | "b"} paneId
 * @param {{ paneId: "a" | "b", dx: number, dy: number } | null} frozenPose
 */
async function finishDragPlace(movingIndex, paneId, frozenPose) {
  busy = true;
  updateButtons();
  setStatus("Placing…", "busy");

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
      groups.set(newG, new Map([[movingIndex, { dx: 0, dy: 0, z: 0 }]]));
      tileGroup.set(movingIndex, newG);
      panes[paneId].groupId = newG;
      selection = [tiles[movingIndex].id];
      refreshAllPreviews();
      renderThumbs();
      updateCounts();
      updateButtons();
      setStatus(
        `Started ${newG} in Workspace ${paneId.toUpperCase()} with “${tiles[movingIndex].name}”. Drag another tile onto it and align by eye.`
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
      groups.get(gid).set(movingIndex, { dx: 0, dy: 0, z: 0 });
      tileGroup.set(movingIndex, gid);
      selection = [tiles[movingIndex].id];
      refreshAllPreviews();
      renderThumbs();
      updateCounts();
      updateButtons();
      setStatus("Tile reset in place. Drag another overlapping photo onto it.");
      return;
    }

    if (!frozenPose) {
      setStatus("Drop lost its place pose — drag again and release on the montage.", "error");
      refreshAllPreviews();
      return;
    }

    // Exact pixels from the live preview — never re-derive from screen coords after layout changes
    const placeDx = frozenPose.dx;
    const placeDy = frozenPose.dy;

    let scoreNote = "";
    if (dragCoreCanvas && dragBaseOrigin) {
      const coreX = placeDx - dragBaseOrigin.minX;
      const coreY = placeDy - dragBaseOrigin.minY;
      const scored = scoreOverlapAt(dragCoreCanvas, tiles[movingIndex], coreX, coreY);
      if (scored.area >= 24 * 24) {
        scoreNote = ` Alignment ${scored.score.toFixed(2)}.`;
      }
    }

    const alreadyHistoric = Boolean(wasInGroup && wasInGroup !== gid);

    applyJoin({
      paneId,
      targetGroupId: gid,
      place: { index: movingIndex, dx: placeDx, dy: placeDy },
      realign: realigning,
      skipHistory: alreadyHistoric,
      message: `${realigning ? "Re-placed" : "Placed"} exactly where released.${scoreNote} Drag again to nudge, Match to auto-align, or Lock.`,
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
  // no-op: crop marker overlay removed
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
      cropPx: 0,
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
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

  // Append tiles — do not wipe existing montage
  rebuildTilesKeepPlacements();
  scheduleAutosave();
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
  renderThumbs();
  updateThumbSize();
  updateCounts();
  updateButtons();
  setStatus("Waiting for images.");
  fileInput.value = "";
  clearAutosave();
}

/* —— Local autosave (IndexedDB) —— */
const IDB_NAME = "photostitch-db";
const IDB_STORE = "workspace";
const IDB_KEY = "autosave";
let autosaveTimer = 0;
let autosaveBusy = false;
/** @type {object | null} */
let pendingAutosave = null;

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(value) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet() {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete() {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = 0;
    void writeAutosave();
  }, 900);
}

async function writeAutosave() {
  if (autosaveBusy) {
    pendingAutosave = true;
    return;
  }
  if (!loaded.length && !tileGroup.size) {
    await clearAutosave();
    return;
  }
  autosaveBusy = true;
  try {
    const placements = [];
    for (const [id, p] of snapshotPlacementsById()) {
      placements.push([id, { gid: p.gid, dx: p.dx, dy: p.dy, z: p.z ?? 0 }]);
    }
    const items = [];
    for (const item of loaded) {
      items.push({
        id: item.id,
        name: item.file.name,
        type: item.file.type || "image/png",
        lastModified: item.file.lastModified || Date.now(),
        size: item.file.size,
        crop: getItemCrop(item),
        blob: item.file,
      });
    }
    await idbPut({
      v: 2,
      savedAt: Date.now(),
      threshold: Number(thresholdInput.value),
      scale: scaleSelect.value,
      workspaceBVisible,
      nextGroup,
      paneGroups: { a: panes.a.groupId, b: panes.b.groupId },
      lockedIds: [...lockedIds],
      placements,
      items,
    });
    if (restoreBtn) {
      restoreBtn.hidden = false;
      restoreBtn.textContent = "Restore";
      restoreBtn.title = `Reload autosave from ${new Date().toLocaleTimeString()}`;
    }
  } catch (err) {
    console.warn("Autosave failed", err);
  } finally {
    autosaveBusy = false;
    if (pendingAutosave) {
      pendingAutosave = null;
      scheduleAutosave();
    }
  }
}

async function clearAutosave() {
  try {
    await idbDelete();
  } catch (_) {}
  if (restoreBtn) restoreBtn.hidden = true;
}

async function checkAutosaveOnLoad() {
  try {
    const save = await idbGet();
    if (!save?.items?.length) {
      if (restoreBtn) restoreBtn.hidden = true;
      return;
    }
    if (restoreBtn) {
      restoreBtn.hidden = false;
      const when = save.savedAt ? new Date(save.savedAt).toLocaleString() : "earlier";
      restoreBtn.title = `Restore session saved ${when}`;
      restoreBtn.textContent = "Restore";
    }
    if (!loaded.length) {
      setStatus(`Autosave available (${save.items.length} photos) — click Restore to reload.`);
    }
  } catch (_) {}
}

async function restoreAutosave() {
  if (busy) return;
  busy = true;
  updateButtons();
  setStatus("Restoring autosave…", "busy");
  try {
    const save = await idbGet();
    if (!save?.items?.length) {
      setStatus("No autosave found.", "error");
      return;
    }
    for (const item of loaded) URL.revokeObjectURL(item.url);
    loaded = [];
    tiles = [];
    groups = new Map();
    tileGroup = new Map();
    history = [];
    selection = [];
    lockedIds = new Set(save.lockedIds || []);

    if (save.threshold != null) {
      thresholdInput.value = String(save.threshold);
      thresholdOut.textContent = Number(save.threshold).toFixed(2);
    }
    if (save.scale) scaleSelect.value = String(save.scale);
    setWorkspaceBVisible(Boolean(save.workspaceBVisible));
    nextGroup = save.nextGroup || 1;
    panes.a.groupId = save.paneGroups?.a || null;
    panes.b.groupId = save.paneGroups?.b || null;

    for (const entry of save.items) {
      const blob = entry.blob;
      const file =
        blob instanceof File
          ? blob
          : new File([blob], entry.name || "photo.png", {
              type: entry.type || "image/png",
              lastModified: entry.lastModified || Date.now(),
            });
      const url = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error(entry.name));
        el.src = url;
      });
      let crop = entry.crop;
      if (!crop && typeof entry.cropPx === "number") {
        crop = { top: entry.cropPx, right: entry.cropPx, bottom: entry.cropPx, left: entry.cropPx };
      }
      loaded.push({
        id: entry.id,
        file,
        url,
        img,
        crop: normalizeCrop(img.width, img.height, crop || 0),
        fingerprint: null,
      });
    }

    tiles = loaded.map(makeTileFromLoaded);
    const placeMap = new Map(save.placements || []);
    restorePlacementsById(placeMap);
    for (const pan of Object.values(panes)) {
      if (pan.groupId && !groups.has(pan.groupId)) pan.groupId = null;
    }
    panes.a.userZoomed = false;
    panes.b.userZoomed = false;
    refreshAllPreviews();
    renderThumbs();
    updateThumbSize();
    updateCounts();
    updateButtons();
    setStatus(
      `Restored ${loaded.length} photos · ${tileGroup.size} placed (${new Date(save.savedAt).toLocaleString()}).`
    );
  } catch (err) {
    console.error(err);
    setStatus("Restore failed — autosave may be incomplete.", "error");
  } finally {
    busy = false;
    updateButtons();
  }
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
    (a, b) => (b[1].z ?? 0) - (a[1].z ?? 0) || b[0] - a[0]
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

function hideTileMenu() {
  if (tileMenu) tileMenu.hidden = true;
}

function showTileMenu(clientX, clientY, id) {
  if (!tileMenu) return;
  if (id && !selection.includes(id)) {
    selection = [id];
    renderThumbs();
    refreshAllPreviews();
  }
  const item = loaded.find((l) => l.id === (id || selection[0]));
  const uncropBtn = tileMenu.querySelector('[data-action="uncrop"]');
  if (uncropBtn) {
    uncropBtn.hidden = !(item && isCropped(getItemCrop(item)));
  }
  tileMenu.hidden = false;
  const pad = 8;
  const menuW = tileMenu.offsetWidth || 180;
  const menuH = tileMenu.offsetHeight || 160;
  const x = Math.min(clientX, window.innerWidth - menuW - pad);
  const y = Math.min(clientY, window.innerHeight - menuH - pad);
  tileMenu.style.left = `${Math.max(pad, x)}px`;
  tileMenu.style.top = `${Math.max(pad, y)}px`;
}

function startPan(e, paneId) {
  const p = panes[paneId];
  const startX = e.clientX;
  const startY = e.clientY;
  const origX = p.panX;
  const origY = p.panY;
  const pointer = e.pointerId;
  p.wrap.classList.add("is-panning");
  try {
    p.wrap.setPointerCapture(pointer);
  } catch (_) {}

  const onMove = (ev) => {
    if (ev.pointerId !== pointer) return;
    p.panX = origX + (ev.clientX - startX);
    p.panY = origY + (ev.clientY - startY);
    applyPaneZoom(paneId);
  };
  const onUp = (ev) => {
    if (ev.pointerId !== pointer) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    p.wrap.classList.remove("is-panning");
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
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
      zoomAtClient(paneId, e.clientX, e.clientY, factor);
    },
    { passive: false }
  );

  p.wrap.addEventListener("pointerdown", (e) => {
    if (busy) return;
    setFocusedPane(paneId);

    // Middle mouse, Alt, or Space+drag → always pan
    if (e.button === 1 || e.altKey || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      startPan(e, paneId);
      return;
    }

    if (e.button !== 0) return;

    // Click empty montage background → pan
    if (e.target === p.wrap || e.target === p.stage) {
      e.preventDefault();
      startPan(e, paneId);
    }
  });

  p.canvas.addEventListener("pointerdown", (e) => {
    hideTileMenu();
    if (e.button === 1 || e.altKey || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      e.stopPropagation();
      setFocusedPane(paneId);
      startPan(e, paneId);
      return;
    }
    if (e.button !== 0 || busy) return;
    setFocusedPane(paneId);
    const hit = hitTestPaneTile(paneId, e.clientX, e.clientY);

    if (hit == null) {
      // Empty padded canvas area → pan
      e.preventDefault();
      e.stopPropagation();
      startPan(e, paneId);
      return;
    }

    const id = tiles[hit].id;

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      if (selection.includes(id)) selection = selection.filter((x) => x !== id);
      else selection.push(id);
      renderThumbs();
      refreshAllPreviews();
      setStatus(`${selection.length} selected — arrows nudge · right-click layers.`);
      return;
    }

    selection = [id];
    renderThumbs();
    // Do not refreshAllPreviews here — redrawing before drag makes the montage jump
    if (lockedIds.has(id)) {
      // Locked tile: pan the view instead of moving the photo
      e.preventDefault();
      e.stopPropagation();
      refreshAllPreviews();
      startPan(e, paneId);
      setStatus("Locked tile — Unlock to re-drag, or drag empty area / Space to pan.");
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    startDrag(e, hit, p.canvas, grabOffsetFromPane(paneId, hit, e.clientX, e.clientY));
  });

  p.canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    setFocusedPane(paneId);
    const hit = hitTestPaneTile(paneId, e.clientX, e.clientY);
    if (hit == null) {
      hideTileMenu();
      return;
    }
    showTileMenu(e.clientX, e.clientY, tiles[hit].id);
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
cropEditBtn?.addEventListener("click", () => {
  if (selection.length !== 1) {
    setStatus("Select one placed photo, then Crop.", "error");
    return;
  }
  startCropEditForId(selection[0]);
});
restoreBtn?.addEventListener("click", () => {
  void restoreAutosave();
});
cropHudApply?.addEventListener("click", applyCropEdit);
cropHudCancel?.addEventListener("click", cancelCropEdit);
cropFrame?.addEventListener("pointerdown", onCropHandleDown);
railPinBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleRailPinned();
});

tileMenu?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;
  hideTileMenu();
  const id = selection[0];
  if (action === "crop" && id) startCropEditForId(id);
  else if (action === "uncrop" && id) uncropById(id);
  else if (action === "front" || action === "forward" || action === "backward" || action === "back") {
    changeLayerOrder(action);
  }
});

document.addEventListener("pointerdown", (e) => {
  if (!tileMenu || tileMenu.hidden) return;
  if (tileMenu.contains(e.target)) return;
  hideTileMenu();
});

window.addEventListener("blur", hideTileMenu);
window.addEventListener("resize", () => {
  hideTileMenu();
  // Preserve zoom/pan — only re-apply current scale after layout
  for (const id of /** @type {const} */ (["a", "b"])) {
    applyPaneZoom(id);
  }
});

try {
  setRailPinned(localStorage.getItem("photostitch-rail-pinned") === "1");
} catch (_) {
  setRailPinned(false);
}

setWorkspaceBVisible(false);
setFocusedPane("a");
updateThumbSize();
updateButtons();
applyPaneZoom("a");
applyPaneZoom("b");
void checkAutosaveOnLoad();
