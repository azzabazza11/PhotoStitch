import { cropImage, stitchTiles } from "./stitcher.js";

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
const preview = document.getElementById("preview");
const previewWrap = preview.parentElement;

/** @type {{ id: string, file: File, url: string, img: HTMLImageElement }[]} */
let loaded = [];
/** @type {HTMLCanvasElement | null} */
let resultCanvas = null;
let busy = false;

thresholdInput.addEventListener("input", () => {
  thresholdOut.textContent = Number(thresholdInput.value).toFixed(2);
});

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
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

function renderThumbs(placedIds = [], failedIds = []) {
  thumbs.replaceChildren();
  for (const item of loaded) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.url;
    img.alt = item.file.name;
    img.title = item.file.name;
    if (placedIds.includes(item.id)) img.classList.add("placed");
    if (failedIds.includes(item.id)) img.classList.add("failed");
    thumbs.appendChild(img);
  }
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
  preview.width = 0;
  preview.height = 0;
  previewWrap.classList.remove("has-result");
  renderThumbs();
  updateCounts();
  updateButtons();
  setStatus(
    loaded.length < 2
      ? "Add at least one more overlapping screenshot."
      : "Ready to stitch. Order does not matter."
  );
}

function clearAll() {
  for (const item of loaded) URL.revokeObjectURL(item.url);
  loaded = [];
  resultCanvas = null;
  preview.width = 0;
  preview.height = 0;
  previewWrap.classList.remove("has-result");
  renderThumbs();
  updateCounts();
  updateButtons();
  setStatus("Waiting for images.");
  fileInput.value = "";
}

async function runStitch() {
  if (busy || loaded.length < 2) return;
  busy = true;
  updateButtons();
  setStatus("Cropping…", "busy");

  const cropPx = Number(cropInput.value) || 0;
  const threshold = Number(thresholdInput.value);
  const searchScale = Number(scaleSelect.value);

  try {
    const tiles = [];
    for (const item of loaded) {
      const cropped = cropImage(item.img, cropPx, item.file.name);
      tiles.push({ ...cropped, id: item.id });
    }

    const result = await stitchTiles(tiles, {
      threshold,
      searchScale,
      onProgress(msg, placedIds, failedIds) {
        setStatus(msg, "busy");
        renderThumbs(placedIds, failedIds);
      },
    });

    resultCanvas = result.canvas;
    const ctx = preview.getContext("2d");
    preview.width = result.canvas.width;
    preview.height = result.canvas.height;
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(result.canvas, 0, 0);
    previewWrap.classList.add("has-result");

    renderThumbs(result.placedIds, result.failedIds);
    const placed = result.placedIds.length;
    const failed = result.failedIds.length;
    if (failed) {
      setStatus(
        `Stitched ${placed}/${loaded.length}. ${failed} could not be matched — lower confidence, reduce crop, or check overlap/zoom.`,
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
  } finally {
    busy = false;
    updateButtons();
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
