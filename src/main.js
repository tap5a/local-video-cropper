import {
  exportVideo, fitLayout, drawComposite, fitOutputDims,
  Input, BlobSource, ALL_FORMATS,
} from './export.js';

const $ = (id) => document.getElementById(id);

const els = {
  dropZone: $('drop-zone'),
  fileInput: $('file-input'),
  editor: $('editor'),
  stageOuter: $('stage-outer'),
  stage: $('stage'),
  video: $('video'),
  blurPreview: $('blur-preview'),
  cropRect: $('crop-rect'),
  overlayImg: $('overlay-img'),
  playBtn: $('play-btn'),
  tlTrack: $('tl-track'),
  tlRange: $('tl-range'),
  tlPlayhead: $('tl-playhead'),
  tlHandleStart: $('tl-handle-start'),
  tlHandleEnd: $('tl-handle-end'),
  timeStart: $('time-start'),
  timeCurrent: $('time-current'),
  timeEnd: $('time-end'),
  timeLength: $('time-length'),
  modeSeg: $('mode-seg'),
  modeHint: $('mode-hint'),
  aspectGrid: $('aspect-grid'),
  blurGroup: $('blur-group'),
  blurSlider: $('blur-slider'),
  blurVal: $('blur-val'),
  brightnessSlider: $('brightness-slider'),
  brightnessVal: $('brightness-val'),
  colorGroup: $('color-group'),
  colorPicker: $('color-picker'),
  colorVal: $('color-val'),
  overlayBtn: $('overlay-btn'),
  overlayInput: $('overlay-input'),
  overlayRow: $('overlay-row'),
  overlayName: $('overlay-name'),
  overlayRemove: $('overlay-remove'),
  qualitySelect: $('quality-select'),
  srcInfo: $('src-info'),
  outInfo: $('out-info'),
  exportBtn: $('export-btn'),
  cancelBtn: $('cancel-btn'),
  progressWrap: $('progress-wrap'),
  progressFill: $('progress-fill'),
  progressText: $('progress-text'),
  result: $('result'),
  resultVideo: $('result-video'),
  downloadLink: $('download-link'),
  resultInfo: $('result-info'),
  errorBox: $('error-box'),
  newFileBtn: $('new-file-btn'),
  zoomGroup: $('zoom-group'),
  zoomSlider: $('zoom-slider'),
  zoomVal: $('zoom-val'),
};

const ASPECTS = [
  { label: 'Original', value: 'original' },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '4:5', value: 4 / 5 },
  { label: '1:1', value: 1 },
  { label: '21:9', value: 21 / 9 },
  { label: 'Free', value: 'free' },
];

const MIN_CROP = 32; // px, source space
const MIN_TRIM_GAP = 0.1; // s

const state = {
  file: null,
  fileName: '',
  srcW: 0,
  srcH: 0,
  duration: 0,
  mode: 'crop', // 'crop' | 'blur' | 'color'
  aspect: 'original', // 'original' | 'free' | number
  crop: { x: 0, y: 0, w: 0, h: 0 }, // source pixels
  trimStart: 0,
  trimEnd: 0,
  blurAmount: 40,
  bgBrightness: 100,
  zoom: 0,
  bgColor: '#000000',
  overlay: null, // { bitmap, name, url }
  exporting: false,
  resultUrl: null,
};

const isFitMode = () => state.mode !== 'crop';

// ---------------------------------------------------------------- utilities

const fmtTime = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

const fmtSize = (bytes) => {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const even = (n) => Math.max(2, 2 * Math.round(n / 2));

function showError(msg) {
  els.errorBox.textContent = msg;
  els.errorBox.hidden = !msg;
}

// ------------------------------------------------------------- file loading

async function loadFile(file) {
  if (!file || !file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) {
    showError('That does not look like a video file.');
    return;
  }
  showError('');
  clearResult();

  state.file = file;
  state.fileName = file.name.replace(/\.[^.]+$/, '');

  const url = URL.createObjectURL(file);
  const video = els.video;
  video.src = url;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('Could not read this video in the browser.'));
  }).catch((err) => {
    showError(err.message);
    throw err;
  });

  state.srcW = video.videoWidth;
  state.srcH = video.videoHeight;

  // The <video> element's duration is unreliable for some files (MediaRecorder
  // WebMs report Infinity or near-zero) — Mediabunny parses the actual packets,
  // and it's what the export pipeline uses, so treat it as authoritative.
  let duration = video.duration;
  const mbDuration = await new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    .computeDuration()
    .catch(() => 0);
  if (!Number.isFinite(duration) || mbDuration > duration) duration = mbDuration;

  // Nudge the element past a bogus reported end so preview seeking works.
  if (!Number.isFinite(video.duration) || video.duration < duration) {
    await new Promise((resolve) => {
      video.onseeked = resolve;
      video.currentTime = duration;
    });
    video.onseeked = null;
    video.currentTime = 0;
  }
  if (!Number.isFinite(duration) || duration <= 0.01) {
    showError('This video appears to be empty or unreadable.');
    return;
  }
  state.duration = duration;
  state.trimStart = 0;
  state.trimEnd = video.duration;

  els.dropZone.hidden = true;
  els.editor.hidden = false;
  els.srcInfo.textContent =
    `Source: ${state.srcW}×${state.srcH} · ${fmtTime(state.duration)} · ${fmtSize(file.size)}`;

  setAspect(state.aspect === 'free' && isFitMode() ? 'original' : state.aspect);
  layoutStage();
  updateTrimUI();

  // re-measure once layout has settled after the editor became visible
  requestAnimationFrame(layoutStage);
  setTimeout(layoutStage, 120);
}

els.dropZone.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => loadFile(els.fileInput.files[0]));

for (const [evt, cls] of [['dragover', true], ['dragleave', false], ['drop', false]]) {
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.toggle('dragover', cls);
  });
}
els.dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

els.newFileBtn.addEventListener('click', () => {
  els.video.pause();
  els.editor.hidden = true;
  els.dropZone.hidden = false;
  els.fileInput.value = '';
  clearResult();
});

function clearResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  els.result.hidden = true;
  els.resultVideo.removeAttribute('src');
}

// ------------------------------------------------------------ stage layout

// Size #stage so the video content maps 1:1 to the element box (no letterbox
// inside the element), which keeps crop-overlay math linear.
function layoutStage() {
  if (!state.srcW) return;
  const availW = els.stageOuter.clientWidth;
  const availH = els.stageOuter.clientHeight;
  if (!availW || !availH) return;

  let arW = state.srcW, arH = state.srcH;
  if (isFitMode()) {
    const aspect = state.aspect === 'original' || state.aspect === 'free'
      ? state.srcW / state.srcH : state.aspect;
    arW = aspect;
    arH = 1;
  }

  const scale = Math.min(availW / arW, availH / arH);
  const w = arW * scale;
  const h = arH * scale;
  els.stage.style.width = `${w}px`;
  els.stage.style.height = `${h}px`;

  if (isFitMode()) {
    setupPreviewCanvas(w, h);
  }
  updateCropOverlay();
  updateTrimUI();
}

new ResizeObserver(layoutStage).observe(els.stageOuter);
window.addEventListener('resize', layoutStage);

// -------------------------------------------------------------- crop logic

function defaultCropForAspect(aspect) {
  const { srcW, srcH } = state;
  if (aspect === 'original' || aspect === 'free') {
    return { x: 0, y: 0, w: srcW, h: srcH };
  }
  let w, h;
  if (srcW / srcH > aspect) {
    h = srcH;
    w = srcH * aspect;
  } else {
    w = srcW;
    h = srcW / aspect;
  }
  return { x: (srcW - w) / 2, y: (srcH - h) / 2, w, h };
}

function setAspect(value) {
  state.aspect = value;
  state.crop = defaultCropForAspect(value);
  renderAspectButtons();
  layoutStage();
  updateOutInfo();
}

function renderAspectButtons() {
  els.aspectGrid.innerHTML = '';
  for (const { label, value } of ASPECTS) {
    const btn = document.createElement('button');
    btn.textContent = label;
    const isActive =
      value === state.aspect ||
      (typeof value === 'number' && typeof state.aspect === 'number' &&
        Math.abs(value - state.aspect) < 1e-9);
    btn.classList.toggle('active', isActive);
    btn.disabled = isFitMode() && value === 'free';
    btn.addEventListener('click', () => setAspect(value));
    els.aspectGrid.appendChild(btn);
  }
}

function displayScale() {
  return els.stage.clientWidth / state.srcW;
}

function updateCropOverlay() {
  if (state.mode !== 'crop' || !state.srcW) return;
  const s = displayScale();
  const { x, y, w, h } = state.crop;
  const r = els.cropRect.style;
  r.left = `${x * s}px`;
  r.top = `${y * s}px`;
  r.width = `${w * s}px`;
  r.height = `${h * s}px`;
}

// Crop rect dragging & resizing
let dragCtx = null;

els.cropRect.addEventListener('pointerdown', (e) => {
  if (state.mode !== 'crop') return;
  e.preventDefault();
  e.stopPropagation();
  const handle = e.target.dataset?.handle || null;
  try { els.cropRect.setPointerCapture(e.pointerId); } catch {}
  dragCtx = {
    handle,
    startX: e.clientX,
    startY: e.clientY,
    crop: { ...state.crop },
  };
});

els.cropRect.addEventListener('pointermove', (e) => {
  if (!dragCtx) return;
  const s = displayScale();
  const dx = (e.clientX - dragCtx.startX) / s;
  const dy = (e.clientY - dragCtx.startY) / s;
  const c0 = dragCtx.crop;
  const { srcW, srcH } = state;

  if (!dragCtx.handle) {
    // move
    state.crop.x = clamp(c0.x + dx, 0, srcW - c0.w);
    state.crop.y = clamp(c0.y + dy, 0, srcH - c0.h);
  } else {
    // resize from a corner; opposite corner is the anchor
    const h = dragCtx.handle;
    const anchorX = h.includes('w') ? c0.x + c0.w : c0.x;
    const anchorY = h.includes('n') ? c0.y + c0.h : c0.y;
    const movingX0 = h.includes('w') ? c0.x : c0.x + c0.w;
    const movingY0 = h.includes('n') ? c0.y : c0.y + c0.h;
    let mx = clamp(movingX0 + dx, 0, srcW);
    let my = clamp(movingY0 + dy, 0, srcH);

    let w = Math.abs(mx - anchorX);
    let hgt = Math.abs(my - anchorY);

    const aspect = typeof state.aspect === 'number'
      ? state.aspect
      : state.aspect === 'original' ? srcW / srcH : null;

    if (aspect) {
      // constrain to aspect, limited by available room from the anchor
      const dirX = mx >= anchorX ? 1 : -1;
      const dirY = my >= anchorY ? 1 : -1;
      const roomW = dirX > 0 ? srcW - anchorX : anchorX;
      const roomH = dirY > 0 ? srcH - anchorY : anchorY;
      w = Math.max(w, hgt * aspect);
      w = Math.min(w, roomW, roomH * aspect);
      w = Math.max(w, MIN_CROP);
      hgt = w / aspect;
      mx = anchorX + dirX * w;
      my = anchorY + dirY * hgt;
    } else {
      w = Math.max(w, MIN_CROP);
      hgt = Math.max(hgt, MIN_CROP);
    }

    state.crop.x = Math.min(anchorX, anchorX + (mx >= anchorX ? w : -w));
    state.crop.y = Math.min(anchorY, anchorY + (my >= anchorY ? hgt : -hgt));
    state.crop.w = w;
    state.crop.h = hgt;
  }
  updateCropOverlay();
  updateOutInfo();
});

const endCropDrag = () => { dragCtx = null; };
els.cropRect.addEventListener('pointerup', endCropDrag);
els.cropRect.addEventListener('pointercancel', endCropDrag);

// --------------------------------------------------------------- mode

els.modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  setMode(btn.dataset.mode);
});

const MODE_HINTS = {
  crop: 'Cut out a region of the frame.',
  blur: 'Whole video fits inside the new frame; a blurred copy fills the rest.',
  color: 'Whole video fits inside the new frame; a solid color fills the rest.',
};

function setMode(mode) {
  state.mode = mode;
  for (const b of els.modeSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === mode);
  }
  const fit = mode !== 'crop';
  els.stage.classList.toggle('blur-mode', fit);
  els.blurPreview.hidden = !fit;
  els.zoomGroup.hidden = !fit;
  els.blurGroup.hidden = mode !== 'blur';
  els.colorGroup.hidden = mode !== 'color';
  els.modeHint.textContent = MODE_HINTS[mode];
  if (fit && state.aspect === 'free') setAspect('original');
  renderAspectButtons();
  updateOverlayPreview();
  layoutStage();
  updateOutInfo();
}

// ------------------------------------------------------ fit-mode preview

let previewCtx = null;

function setupPreviewCanvas(cssW, cssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  els.blurPreview.width = Math.round(cssW * dpr);
  els.blurPreview.height = Math.round(cssH * dpr);
  previewCtx = els.blurPreview.getContext('2d');
}

const fallbackPreviewCanvas = document.createElement('canvas');

function drawPreviewFrame() {
  if (!previewCtx || !state.srcW) return;
  const cw = els.blurPreview.width;
  const ch = els.blurPreview.height;
  const bg = state.mode === 'blur'
    ? {
        type: 'blur',
        blurPx: (state.blurAmount * Math.max(cw, ch)) / 1080,
        brightness: state.bgBrightness,
      }
    : { type: 'color', color: state.bgColor };
  const draw = (dx, dy, dw, dh, targetCtx) =>
    (targetCtx || previewCtx).drawImage(els.video, dx, dy, dw, dh);
  drawComposite(
    previewCtx, cw, ch, state.srcW, state.srcH,
    bg, draw, fallbackPreviewCanvas, state.overlay?.bitmap, state.zoom
  );
}

els.blurSlider.addEventListener('input', () => {
  state.blurAmount = Number(els.blurSlider.value);
  els.blurVal.textContent = state.blurAmount;
});

els.brightnessSlider.addEventListener('input', () => {
  state.bgBrightness = Number(els.brightnessSlider.value);
  els.brightnessVal.textContent = state.bgBrightness;
});

els.zoomSlider.addEventListener('input', () => {
  state.zoom = Number(els.zoomSlider.value);
  els.zoomVal.textContent = state.zoom;
});

els.colorPicker.addEventListener('input', () => {
  state.bgColor = els.colorPicker.value;
  els.colorVal.textContent = state.bgColor;
});

// ---------------------------------------------------------------- overlay

els.overlayBtn.addEventListener('click', () => els.overlayInput.click());

els.overlayInput.addEventListener('change', async () => {
  const file = els.overlayInput.files[0];
  if (!file) return;
  try {
    const bitmap = await createImageBitmap(file);
    clearOverlay();
    state.overlay = { bitmap, name: file.name, url: URL.createObjectURL(file) };
    els.overlayName.textContent = file.name;
    els.overlayRow.hidden = false;
    updateOverlayPreview();
  } catch {
    showError('Could not read that image. Use a PNG (or WebP) file.');
  }
  els.overlayInput.value = '';
});

els.overlayRemove.addEventListener('click', () => {
  clearOverlay();
  updateOverlayPreview();
});

function clearOverlay() {
  if (state.overlay) {
    state.overlay.bitmap.close?.();
    URL.revokeObjectURL(state.overlay.url);
  }
  state.overlay = null;
  els.overlayRow.hidden = true;
}

// In crop mode the overlay preview is an <img> pinned to the crop rect
// (= the output frame); in fit modes it's drawn onto the preview canvas.
function updateOverlayPreview() {
  const showImg = !!state.overlay && state.mode === 'crop';
  els.overlayImg.hidden = !showImg;
  if (showImg) els.overlayImg.src = state.overlay.url;
}

// ------------------------------------------------------------- timeline

function timeToX(t) {
  return (t / state.duration) * els.tlTrack.clientWidth;
}

function updateTrimUI() {
  const { trimStart, trimEnd, duration } = state;
  if (!duration) return;
  const x1 = timeToX(trimStart);
  const x2 = timeToX(trimEnd);
  els.tlRange.style.left = `${x1}px`;
  els.tlRange.style.width = `${x2 - x1}px`;
  els.tlHandleStart.style.left = `${x1 - 6}px`;
  els.tlHandleEnd.style.left = `${x2 - 6}px`;
  els.timeStart.textContent = fmtTime(trimStart);
  els.timeEnd.textContent = fmtTime(trimEnd);
  els.timeLength.textContent = fmtTime(trimEnd - trimStart);
}

function trackTime(clientX) {
  const rect = els.tlTrack.getBoundingClientRect();
  return clamp(((clientX - rect.left) / rect.width) * state.duration, 0, state.duration);
}

function bindTrimHandle(el, which) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      const t = trackTime(ev.clientX);
      if (which === 'start') {
        state.trimStart = clamp(t, 0, state.trimEnd - MIN_TRIM_GAP);
        els.video.currentTime = state.trimStart;
      } else {
        state.trimEnd = clamp(t, state.trimStart + MIN_TRIM_GAP, state.duration);
        els.video.currentTime = state.trimEnd;
      }
      updateTrimUI();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}
bindTrimHandle(els.tlHandleStart, 'start');
bindTrimHandle(els.tlHandleEnd, 'end');

// click-to-seek + drag-to-scrub on the timeline track
els.tlTrack.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { els.tlTrack.setPointerCapture(e.pointerId); } catch {}
  const scrub = (ev) => {
    els.video.currentTime = trackTime(ev.clientX);
  };
  scrub(e);
  const move = (ev) => scrub(ev);
  const up = () => {
    els.tlTrack.removeEventListener('pointermove', move);
    els.tlTrack.removeEventListener('pointerup', up);
    els.tlTrack.removeEventListener('pointercancel', up);
  };
  els.tlTrack.addEventListener('pointermove', move);
  els.tlTrack.addEventListener('pointerup', up);
  els.tlTrack.addEventListener('pointercancel', up);
});

// -------------------------------------------------------------- playback

function togglePlay() {
  const v = els.video;
  if (v.paused) {
    if (v.currentTime < state.trimStart || v.currentTime >= state.trimEnd - 0.05) {
      v.currentTime = state.trimStart;
    }
    v.play();
  } else {
    v.pause();
  }
}

els.playBtn.addEventListener('click', togglePlay);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !els.editor.hidden && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    togglePlay();
  }
});

els.video.addEventListener('play', () => { els.playBtn.textContent = '⏸'; });
els.video.addEventListener('pause', () => { els.playBtn.textContent = '▶'; });

function tick() {
  if (els.editor.hidden || !state.duration) return;
  const v = els.video;

  // loop playback within the trim range
  if (!v.paused && v.currentTime >= state.trimEnd) {
    v.currentTime = state.trimStart;
  }

  els.tlPlayhead.style.left = `${timeToX(v.currentTime)}px`;
  els.timeCurrent.textContent = fmtTime(v.currentTime);

  if (isFitMode()) drawPreviewFrame();
}

// Drive the UI with rAF while the tab is visible; browsers suspend rAF in
// hidden/background tabs, so fall back to a coarse interval there.
(function loop() {
  tick();
  requestAnimationFrame(loop);
})();
setInterval(() => {
  if (document.visibilityState === 'hidden') tick();
}, 250);

// ------------------------------------------------------------ output info

function computeOutputDims() {
  if (state.mode === 'crop') {
    return { outW: even(state.crop.w), outH: even(state.crop.h) };
  }
  const aspect = state.aspect === 'original' || state.aspect === 'free'
    ? state.srcW / state.srcH : state.aspect;
  return fitOutputDims(state.srcW, state.srcH, aspect);
}

function updateOutInfo() {
  if (!state.srcW) return;
  const { outW, outH } = computeOutputDims();
  els.outInfo.textContent = `Output: ${outW}×${outH} MP4`;
}

// ---------------------------------------------------------------- export

let currentExport = null;

async function doExport() {
  if (state.exporting) return;
  state.exporting = true;
  showError('');
  clearResult();
  els.video.pause();
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = 'Exporting…';
  els.cancelBtn.hidden = false;
  els.progressWrap.hidden = false;
  els.progressFill.style.width = '0%';
  els.progressText.textContent = '0%';

  const aspect = state.aspect === 'original' || state.aspect === 'free'
    ? null : state.aspect;

  currentExport = exportVideo(
    {
      file: state.file,
      mode: state.mode,
      crop: state.crop,
      srcW: state.srcW,
      srcH: state.srcH,
      aspect,
      trimStart: state.trimStart,
      trimEnd: state.trimEnd,
      duration: state.duration,
      blurAmount: state.blurAmount,
      bgBrightness: state.bgBrightness,
      zoom: state.zoom,
      bgColor: state.bgColor,
      quality: els.qualitySelect.value,
      overlay: state.overlay?.bitmap ?? null,
    },
    (p) => {
      const pct = Math.round(p * 100);
      els.progressFill.style.width = `${pct}%`;
      els.progressText.textContent = `${pct}%`;
    }
  );

  try {
    const { blob, outW, outH, codec } = await currentExport.promise;
    state.resultUrl = URL.createObjectURL(blob);
    els.resultVideo.src = state.resultUrl;
    els.downloadLink.href = state.resultUrl;

    const aspectLabel = ASPECTS.find((a) => a.value === state.aspect)?.label
      .replace(':', 'x') ?? 'custom';
    const modeSuffix = state.mode === 'crop' ? '' : `-${state.mode}`;
    els.downloadLink.download = `${state.fileName}-${aspectLabel}${modeSuffix}.mp4`;

    els.resultInfo.textContent = `${outW}×${outH} · ${codec.toUpperCase()} · ${fmtSize(blob.size)}`;
    els.result.hidden = false;
  } catch (err) {
    if (!/cancel/i.test(err.message)) {
      console.error(err);
      showError(`Export failed: ${err.message}`);
    }
  } finally {
    state.exporting = false;
    currentExport = null;
    els.exportBtn.disabled = false;
    els.exportBtn.textContent = 'Export MP4';
    els.cancelBtn.hidden = true;
    els.progressWrap.hidden = true;
  }
}

els.exportBtn.addEventListener('click', doExport);
els.cancelBtn.addEventListener('click', () => currentExport?.cancel());

// ------------------------------------------------------------------- init

renderAspectButtons();
setMode('crop');

// test hook for automated verification
window.__app = {
  state, loadFile, doExport, els, setMode, setAspect,
  mb: { Input, BlobSource, ALL_FORMATS },
};
