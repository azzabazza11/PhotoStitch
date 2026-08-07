import { cropImage, effectiveCrop, stitchTiles } from "./stitcher.js";

const drop = document.getElementById("drop");
const fileInput = document.getElementById("fileInput");
const thumbs = document.getElementById("thumbs");
const statusEl = document.getElementById("status");
const countsEl = document.getElementById("counts");
const stitchBtn = document.getElementById("stitchBtn");
const clearBtn = document.getElementById("clearBtn");
const downloadBtn = document.getElementById("downloadBtn");
const cropInput = document.getElementById("crop");
const thresholdInput = document.getElementById("threshold");
const thresholdOut = document.getElementById("thresholdOut");
const scaleSelect = document.getElementById("scale");
const reviewMode = document.getElementById("reviewMode");
const preview = document.getElementById("preview");
const previewWrap = preview.parentElement;
const cropPreview = document.getElementById("cropPreview");
const cropCanvas = document.getElementById("cropCanvas");
const progress = document.getElementById("progress");
const progressBar = document.getElementById("progressBar");
const reviewBar = document.getElementById("reviewBar");
const reviewMsg = document.getElementById("reviewMsg");
const acceptBtn = document.getElementById("acceptBtn");
const rejectBtn = document.getElementById("rejectBtn");
const acceptRestBtn = document.getElementById("acceptRestBtn");
const stopBtn = document.getElementById("stopBtn");

/** @type {{ id: string, file: File, url: string, img: HTMLImageElement }[]} */
let loaded = [];
/** @type {HTMLCanvasElement | null} */
let resultCanvas = null;
/** @type {Record<string, string>} */
let lastHints = {};
let busy = false;

/** @type {((d: 'accept'|'reject'|'accept-rest'|'stop') => void) | null} */
let reviewResolve = null;

thresholdInput.addEventListener("input", () => {
  thresholdOut.textContent = Number(thresholdInput.value).toFixed(2);
});

cropInput.addEventListener("input", () => updateCropPreview());

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function setProgress(fraction) {
  if (fraction == null || fraction < 0) {
    progress.hidden = true;
    progressBar.style.width = "0%";
    return;
  }
  progress.hidden = false;
  progressBar.style.width = `${Math.min(100, Math.round(fraction * 100))}%`;
}

function updateButtons() {
  stitchBtn.disabled = busy || loaded.length < 2;
  clearBtn.disabled = busy || (loaded.length === 0 && !resultCanvas);
  downloadBtn.disabled = busy || !resultCanvas;
}

function updateCounts() {
  countsEl.textContent = loaded.length
    ? `${loaded.length} image${loaded.length === 1 ? "" : "s"} loaded`
    : "";
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

/**
 * @param {string[]} placedIds
 * @param {string[]} failedIds
 * @param {Record<string, string>} [hints]
 * @param {string|null} [pendingId]
 */
function renderThumbs(placedIds = [], failedIds = [], hints = lastHints, pendingId = null) {
  lastHints = hints || {};
  thumbs.replaceChildren();
  for (const item of loaded) {
    const wrap = document.createElement("div");
    wrap.className = "thumb-wrap";
    if (placedIds.includes(item.id)) wrap.classList.add("placed");
    if (failedIds.includes(item.id)) wrap.classList.add("failed");
    if (pendingId && item.id === pendingId) wrap.classList.add("pending");

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.url;
    img.alt = item.file.name;

    const hint = lastHints[item.id];
    img.title = hint ? `${item.file.name}\n${hint}` : item.file.name;

    const meta = document.createElement("span");
    meta.className = "thumb-meta";
    if (pendingId === item.id) meta.textContent = "review";
    else if (failedIds.includes(item.id)) meta.textContent = "unmatched";
    else if (placedIds.includes(item.id) && hint) meta.textContent = hint.split(" ")[0];
    else meta.textContent = item.file.name;

    wrap.appendChild(img);
    wrap.appendChild(meta);
    thumbs.appendChild(wrap);
  }
}

function hideReview() {
  reviewBar.hidden = true;
  reviewResolve = null;
}

/**
 * @returns {Promise<'accept'|'reject'|'accept-rest'|'stop'>}
 */
function waitForReview(message) {
  reviewMsg.textContent = message;
  reviewBar.hidden = false;
  acceptBtn.focus();
  return new Promise((resolve) => {
    reviewResolve = resolve;
  });
}

function resolveReview(decision) {
  if (!reviewResolve) return;
  const r = reviewResolve;
  hideReview();
  r(decision);
}

acceptBtn.addEventListener("click", () => resolveReview("accept"));
rejectBtn.addEventListener("click", () => resolveReview("reject"));
acceptRestBtn.addEventListener("click", () => resolveReview("accept-rest"));
stopBtn.addEventListener("click", () => resolveReview("stop"));

window.addEventListener("keydown", (e) => {
  if (!reviewResolve) return;
  if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  const key = e.key.toLowerCase();
  if (key === "a") {
    e.preventDefault();
    resolveReview("accept");
  } else if (key === "r") {
    e.preventDefault();
    resolveReview("reject");
  } else if (key === "escape") {
    e.preventDefault();
    resolveReview("stop");
  }
});

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
  ctx.lineWidth = 1;
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

/**
 * @param {FileList|File[]} files
 */
async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/"));
  if (!list.length) {
    setStatus("No image files found in that drop.", "error");
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

  resultCanvas = null;
  lastHints = {};
  preview.width = 0;
  preview.height = 0;
  previewWrap.classList.remove("has-result");
  hideReview();
  renderThumbs();
  updateCropPreview();
  updateCounts();
  updateButtons();
  setProgress(null);
  setStatus(
    loaded.length < 2
      ? "Add at least one more overlapping screenshot."
      : "Ready to stitch. Order does not matter."
  );
}

function clearAll() {
  if (reviewResolve) resolveReview("stop");
  for (const item of loaded) URL.revokeObjectURL(item.url);
  loaded = [];
  resultCanvas = null;
  lastHints = {};
  preview.width = 0;
  preview.height = 0;
  previewWrap.classList.remove("has-result");
  cropPreview.hidden = true;
  hideReview();
  renderThumbs();
  updateCounts();
  updateButtons();
  setProgress(null);
  setStatus("Waiting for images.");
  fileInput.value = "";
}

async function runStitch() {
  if (busy || loaded.length < 2) return;
  busy = true;
  updateButtons();
  setStatus("Cropping…", "busy");
  setProgress(0.02);
  hideReview();

  const cropPx = Number(cropInput.value) || 0;
  const threshold = Number(thresholdInput.value);
  const searchScale = Number(scaleSelect.value);
  const useReview = reviewMode.checked;

  try {
    const tiles = [];
    for (const item of loaded) {
      const cropped = cropImage(item.img, cropPx, item.file.name);
      tiles.push({ ...cropped, id: item.id });
    }

    const result = await stitchTiles(tiles, {
      threshold,
      searchScale,
      previewIntervalMs: 5000,
      onProgress(info) {
        setStatus(info.msg, "busy");
        renderThumbs(
          info.placedIds || [],
          info.failedIds || [],
          info.matchHints || lastHints,
          info.pendingId || null
        );
        const placed = (info.placedIds || []).length;
        setProgress(0.05 + 0.9 * (placed / Math.max(tiles.length, 1)));
      },
      onPreview(info) {
        showPreviewCanvas(info.canvas);
        setStatus(info.msg, "busy");
        renderThumbs(
          info.placedIds,
          info.failedIds,
          lastHints,
          info.pendingId
        );
      },
      onPropose: useReview
        ? async (info) => {
            showPreviewCanvas(info.canvas);
            setProgress(0.05 + 0.9 * (info.placedIds.length / Math.max(tiles.length, 1)));
            const msg = `Join “${info.tile.name}” onto “${info.anchor.name}”? score ${info.score.toFixed(3)} · ${info.edge} · ${info.remaining} left`;
            setStatus(msg, "busy");
            return waitForReview(msg);
          }
        : undefined,
    });

    resultCanvas = result.canvas;
    showPreviewCanvas(result.canvas);

    const hints = { ...lastHints };
    for (const m of result.matches || []) {
      hints[m.b] = `${m.score.toFixed(3)} [${m.edge}]`;
      if (!hints[m.a]) hints[m.a] = "seed / linked";
    }
    renderThumbs(result.placedIds, result.failedIds, hints);

    setProgress(1);
    const placed = result.placedIds.length;
    const failed = result.failedIds.length;
    if (failed) {
      setStatus(
        `Stitched ${placed}/${loaded.length}. ${failed} unmatched — reject bad joins, lower confidence, or check overlap/zoom.`,
        "error"
      );
    } else {
      setStatus(
        `Done — ${placed} images → ${result.canvas.width}×${result.canvas.height}px`,
        ""
      );
    }
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : String(err), "error");
    setProgress(null);
  } finally {
    hideReview();
    busy = false;
    updateButtons();
    setTimeout(() => setProgress(null), 800);
  }
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

stitchBtn.addEventListener("click", runStitch);
clearBtn.addEventListener("click", clearAll);
downloadBtn.addEventListener("click", downloadPng);

updateButtons();
