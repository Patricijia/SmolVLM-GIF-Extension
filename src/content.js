import { parseGIF, decompressFrames } from 'gifuct-js';

console.log('[GIF] ========== CONTENT SCRIPT LOADED ==========');

const PAGE_LOAD_TIME = performance.now();
const processed = new Set();
const pending = new Map();

let firstCaptionTime = null;
let allCaptionsTime = null;
let totalGifsFound = 0;
let totalCaptioned = 0;
let initialScanDone = false;
let modelReadyTime = null;
let modelDevice = 'unknown';
let gifsFoundTime = null;

// Settings
const MAX_GIFS = 10;

// Grid settings — must match training data preprocessing (tgif dataset script)
const NUM_FRAMES = 16;
const GRID_ROWS = 4;
const GRID_COLS = 4;
const CELL_SIZE = 128;
const FINAL_SIZE = 512;
const PAD_BETWEEN_FRAMES = 4;
const PAD_COLOR = '#000000';

function logTiming(event) {
  const elapsed = Math.round(performance.now() - PAGE_LOAD_TIME);
  console.log('[GIF] [' + elapsed + 'ms] ' + event);
}

function isContextValid() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

async function getModelStatus() {
  if (!isContextValid()) return null;
  try {
    const data = await chrome.storage.local.get('modelStatus');
    return data.modelStatus || null;
  } catch {
    return null;
  }
}

function isInViewport(img) {
  const rect = img.getBoundingClientRect();
  return (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
}

function printSummary() {
  if (allCaptionsTime) return;

  allCaptionsTime = performance.now() - PAGE_LOAD_TIME;
  const captioningTime = gifsFoundTime ? (allCaptionsTime - gifsFoundTime) : allCaptionsTime;

  console.log('[GIF] ═══════════════════════════════════════');
  console.log('[GIF] 🎉 ACCESSIBILITY READY');
  console.log('[GIF]   Page load → ready: ' + (allCaptionsTime / 1000).toFixed(1) + 's');
  console.log('[GIF]   Model load: ' + ((modelReadyTime || 0) / 1000).toFixed(1) + 's');
  console.log('[GIF]   First caption: ' + ((firstCaptionTime || 0) / 1000).toFixed(1) + 's');
  console.log('[GIF]   Captioning: ' + (captioningTime / 1000).toFixed(1) + 's');
  console.log('[GIF]   GIFs: ' + totalCaptioned + ' (' + modelDevice + ')');
  if (totalCaptioned > 0) {
    console.log('[GIF]   Avg: ' + Math.round(captioningTime / totalCaptioned) + 'ms/GIF');
  }
  console.log('[GIF] ═══════════════════════════════════════');
}

function applyCaption(img, caption, time) {
  img.alt = caption;
  img.setAttribute('aria-label', caption);
  img.setAttribute('role', 'img');
  img.setAttribute('tabindex', '0');

  totalCaptioned++;
  if (!firstCaptionTime) {
    firstCaptionTime = performance.now() - PAGE_LOAD_TIME;
  }

  logTiming('✓ [' + totalCaptioned + '/' + totalGifsFound + '] URL=' + img.src + ' CAPTION="' + caption + '" (' + time + 'ms)');

  if (totalCaptioned >= totalGifsFound && totalGifsFound > 0) {
    printSummary();
  }
}

async function extractGifFrames(gifUrl) {
  const response = await fetch(gifUrl, { mode: 'cors' });
  if (!response.ok) throw new Error('Fetch failed');
  
  const buffer = await response.arrayBuffer();
  const gif = parseGIF(buffer);
  const frames = decompressFrames(gif, true);
  
  if (!frames || frames.length === 0) {
    throw new Error('No frames');
  }
  
  return frames;
}

function renderFrame(frame, canvas, ctx) {
  const { width, height } = frame.dims;
  
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  
  const imageData = new ImageData(
    new Uint8ClampedArray(frame.patch),
    frame.dims.width,
    frame.dims.height
  );
  
  ctx.putImageData(imageData, frame.dims.left || 0, frame.dims.top || 0);
}

function letterboxToCell(destCtx, srcCanvas, cellX, cellY, cellSize) {
  const scale = Math.min(cellSize / srcCanvas.width, cellSize / srcCanvas.height);
  const w = srcCanvas.width * scale;
  const h = srcCanvas.height * scale;
  const x = cellX + (cellSize - w) / 2;
  const y = cellY + (cellSize - h) / 2;
  
  destCtx.drawImage(srcCanvas, x, y, w, h);
}

function createGrid(frames) {
  const gridW = GRID_COLS * CELL_SIZE + (GRID_COLS - 1) * PAD_BETWEEN_FRAMES;
  const gridH = GRID_ROWS * CELL_SIZE + (GRID_ROWS - 1) * PAD_BETWEEN_FRAMES;
  
  const canvas = document.createElement('canvas');
  canvas.width = FINAL_SIZE;
  canvas.height = FINAL_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAD_COLOR;
  ctx.fillRect(0, 0, FINAL_SIZE, FINAL_SIZE);
  
  const gridCanvas = document.createElement('canvas');
  gridCanvas.width = gridW;
  gridCanvas.height = gridH;
  const gridCtx = gridCanvas.getContext('2d');
  gridCtx.fillStyle = PAD_COLOR;
  gridCtx.fillRect(0, 0, gridW, gridH);
  
  const frameCanvas = document.createElement('canvas');
  const frameCtx = frameCanvas.getContext('2d');
  
  const indices = [];
  const step = Math.max(1, (frames.length - 1) / (NUM_FRAMES - 1));
  for (let i = 0; i < NUM_FRAMES; i++) {
    indices.push(Math.min(Math.floor(i * step), frames.length - 1));
  }
  
  for (let i = 0; i < NUM_FRAMES; i++) {
    const frame = frames[indices[i]];
    const row = Math.floor(i / GRID_COLS);
    const col = i % GRID_COLS;
    const x = col * (CELL_SIZE + PAD_BETWEEN_FRAMES);
    const y = row * (CELL_SIZE + PAD_BETWEEN_FRAMES);
    
    renderFrame(frame, frameCanvas, frameCtx);
    letterboxToCell(gridCtx, frameCanvas, x, y, CELL_SIZE);
  }
  
  const scale = Math.min(FINAL_SIZE / gridW, FINAL_SIZE / gridH);
  const finalW = gridW * scale;
  const finalH = gridH * scale;
  const offsetX = (FINAL_SIZE - finalW) / 2;
  const offsetY = (FINAL_SIZE - finalH) / 2;
  
  ctx.drawImage(gridCanvas, offsetX, offsetY, finalW, finalH);
  
  return canvas.toDataURL('image/jpeg', 0.85);
}

// Composite GIF frames 0..toIndex onto a canvas at native GIF dimensions.
function compositeFrames(frames, toIndex) {
  const gifWidth = frames[0].dims.width;
  const gifHeight = frames[0].dims.height;
  const canvas = document.createElement('canvas');
  canvas.width = gifWidth;
  canvas.height = gifHeight;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i <= toIndex; i++) {
    const f = frames[i];
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(f.patch), f.dims.width, f.dims.height),
      f.dims.left || 0, f.dims.top || 0
    );
  }
  return canvas.toDataURL('image/png'); // PNG = lossless, best for OCR
}

async function getImageData(img) {
  try {
    const frames = await extractGifFrames(img.src);
    const grid = createGrid(frames);
    // Two high-quality frames for TrOCR: frame 0 and the mid frame.
    // Different frames often carry different text overlays (subtitles, captions).
    const mid = Math.max(0, Math.floor(frames.length / 2) - 1);
    const ocrFrames = [
      compositeFrames(frames, 0),
      compositeFrames(frames, mid),
    ];
    return { grid, ocrFrames };
  } catch (e) {
    const fallback = await getFallbackImageData(img);
    return { grid: fallback, ocrFrames: [fallback] };
  }
}

async function getFallbackImageData(img) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = FINAL_SIZE;
    const ctx = canvas.getContext('2d');
    
    const corsImg = new Image();
    corsImg.crossOrigin = 'anonymous';
    
    corsImg.onload = () => {
      try {
        ctx.fillStyle = PAD_COLOR;
        ctx.fillRect(0, 0, FINAL_SIZE, FINAL_SIZE);
        
        const scale = Math.min(FINAL_SIZE / corsImg.naturalWidth, FINAL_SIZE / corsImg.naturalHeight);
        const w = corsImg.naturalWidth * scale;
        const h = corsImg.naturalHeight * scale;
        ctx.drawImage(corsImg, (FINAL_SIZE - w) / 2, (FINAL_SIZE - h) / 2, w, h);
        
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        reject(e);
      }
    };
    corsImg.onerror = () => reject(new Error('CORS'));
    corsImg.src = img.src;
  });
}

async function queueGif(img, priority) {
  if (!isContextValid()) {
    logTiming('queueGif: context invalid, skipping');
    return;
  }
  if (processed.has(img.src)) {
    logTiming('queueGif: already processed, skipping');
    return;
  }
  processed.add(img.src);

  const id = 'g' + Date.now() + Math.random().toString(36).slice(2, 6);
  pending.set(id, img);

  try {
    logTiming('queueGif: extracting frames for ' + id);
    const { grid, ocrFrames } = await getImageData(img);
    logTiming('queueGif: frames extracted, grid size=' + grid.length + ' ocrFrames=' + ocrFrames.length);
    const storageData = await chrome.storage.local.get('captionQueue');
    const queue = storageData.captionQueue || [];

    if (priority) {
      queue.unshift({ gifId: id, imageData: grid, ocrFrames });
    } else {
      queue.push({ gifId: id, imageData: grid, ocrFrames });
    }

    await chrome.storage.local.set({ captionQueue: queue });
    logTiming('queueGif: ' + id + ' added to queue (length=' + queue.length + ')');
  } catch (e) {
    logTiming('queueGif ERROR: ' + e.message);
    processed.delete(img.src);
    pending.delete(id);
  }
}

async function checkResults() {
  if (!isContextValid()) return;
  
  try {
    const data = await chrome.storage.local.get('captionResults');
    const results = data.captionResults || {};
    
    for (const id of Object.keys(results)) {
      const r = results[id];
      const img = pending.get(id);
      
      if (img && r?.caption) {
        applyCaption(img, r.caption, r.time);
        pending.delete(id);
        delete results[id];
        await chrome.storage.local.set({ captionResults: results });
      }
    }
  } catch (e) {}
}

let isScanning = false;

async function scan() {
  if (initialScanDone || isScanning) return;
  isScanning = true;

  try {
    const status = await getModelStatus();
    if (!status || status.status !== 'ready') return;

    if (!modelReadyTime) {
      modelReadyTime = performance.now() - PAGE_LOAD_TIME;
      modelDevice = status.device || 'unknown';
      logTiming('Model ready! (' + modelDevice + ')');
    }

    const allImages = document.querySelectorAll('img');
    const visibleGifs = [];
    const hiddenGifs = [];

    allImages.forEach(img => {
      const src = img.src.toLowerCase();
      const isGif = src.includes('.gif') || img.src.includes('.gif');
      if (isGif && !processed.has(img.src) && img.naturalWidth > 100) {
        if (isInViewport(img)) {
          visibleGifs.push(img);
        } else {
          hiddenGifs.push(img);
        }
      }
    });

    const allGifs = [...visibleGifs, ...hiddenGifs].slice(0, MAX_GIFS);
    const visibleCount = Math.min(visibleGifs.length, MAX_GIFS);

    if (allGifs.length === 0) return;

    totalGifsFound = allGifs.length;
    initialScanDone = true;
    gifsFoundTime = performance.now() - PAGE_LOAD_TIME;

    logTiming('Found ' + totalGifsFound + ' GIFs (' + visibleCount + ' visible)');

    for (let i = 0; i < allGifs.length; i++) {
      await queueGif(allGifs[i], i < visibleCount);
    }
    logTiming('All ' + totalGifsFound + ' GIFs queued');
  } finally {
    isScanning = false;
  }
}

if (isContextValid()) {
  logTiming('Initializing...');

  // Sync model preference from page localStorage to extension storage.
  // If the model changed, clear old captions so they are regenerated.
  (async () => {
    const pageModelId = window.localStorage?.getItem('gif_model_id');
    if (pageModelId) {
      const stored = await chrome.storage.local.get('selectedModelId');
      if (stored.selectedModelId !== pageModelId) {
        await chrome.storage.local.set({
          selectedModelId: pageModelId,
          captionQueue: [],
          captionResults: {},
        });
        logTiming('Model switched to: ' + pageModelId);
      }
    }
  })();

  setInterval(checkResults, 200);

  // Poll for model ready — onChanged can miss the transition
  const scanInterval = setInterval(() => {
    if (initialScanDone) {
      clearInterval(scanInterval);
      return;
    }
    scan();
  }, 1000);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.modelStatus?.newValue?.status === 'ready' && !initialScanDone) {
      scan();
    }
  });

  // Watch for dynamically added images (SPAs load GIFs after content script)
  let scanDebounce = null;
  const observer = new MutationObserver((mutations) => {
    if (initialScanDone) return;
    // Check if any added nodes contain images
    let hasNewImages = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeName === 'IMG' || (node.querySelectorAll && node.querySelectorAll('img').length > 0)) {
          hasNewImages = true;
          break;
        }
      }
      if (hasNewImages) break;
    }
    if (hasNewImages) {
      clearTimeout(scanDebounce);
      scanDebounce = setTimeout(() => {
        logTiming('MutationObserver: new images detected, scanning...');
        scan();
      }, 500);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  scan();
} else {
  console.error('[GIF] Extension context invalid!');
}