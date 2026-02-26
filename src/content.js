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

// Settings
const MAX_GIFS = 10;

// Grid settings
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
  const timeFromModelReady = modelReadyTime ? (allCaptionsTime - modelReadyTime) : allCaptionsTime;
  
  console.log('[GIF] ═══════════════════════════════════════');
  console.log('[GIF] 🎉 ACCESSIBILITY READY');
  console.log('[GIF]   Device: ' + modelDevice);
  console.log('[GIF]   Total time: ' + (allCaptionsTime / 1000).toFixed(1) + 's');
  console.log('[GIF]   Model load: ' + ((modelReadyTime || 0) / 1000).toFixed(1) + 's');
  console.log('[GIF]   Captions: ' + (timeFromModelReady / 1000).toFixed(1) + 's');
  console.log('[GIF]   GIFs: ' + totalCaptioned);
  if (totalCaptioned > 0) {
    console.log('[GIF]   Avg: ' + Math.round(timeFromModelReady / totalCaptioned) + 'ms/GIF');
  }
  console.log('[GIF] ═══════════════════════════════════════');
}

function applyCaption(img, caption, time) {
  img.alt = caption;
  img.setAttribute('aria-label', caption);
  img.setAttribute('role', 'img');
  img.setAttribute('tabindex', '0');
  
  totalCaptioned++;
  
  logTiming('✓ [' + totalCaptioned + '/' + totalGifsFound + '] "' + caption + '" (' + time + 'ms)');
  
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

async function getImageData(img) {
  try {
    const frames = await extractGifFrames(img.src);
    return createGrid(frames);
  } catch (e) {
    return await getFallbackImageData(img);
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
  if (!isContextValid()) return;
  if (processed.has(img.src)) return;
  processed.add(img.src);
  
  const id = 'g' + Date.now() + Math.random().toString(36).slice(2, 6);
  pending.set(id, img);
  
  try {
    const data = await getImageData(img);
    const storageData = await chrome.storage.local.get('captionQueue');
    const queue = storageData.captionQueue || [];
    
    if (priority) {
      queue.unshift({ gifId: id, imageData: data });
    } else {
      queue.push({ gifId: id, imageData: data });
    }
    
    await chrome.storage.local.set({ captionQueue: queue });
  } catch (e) {
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

async function scan() {
  if (initialScanDone) return;
  
  const status = await getModelStatus();
  if (!status || status.status !== 'ready') return;
  
  if (!modelReadyTime) {
    modelReadyTime = performance.now() - PAGE_LOAD_TIME;
    modelDevice = status.device || 'unknown';
    logTiming('Model ready! (' + modelDevice + ')');
  }
  
  const visibleGifs = [];
  const hiddenGifs = [];
  
  document.querySelectorAll('img').forEach(img => {
    const src = img.src.toLowerCase();
    if ((src.includes('media') && (src.includes('giphy') || src.includes('tenor'))) &&
        !src.includes('logo') &&
        !processed.has(img.src) &&
        img.naturalWidth > 100) {
      
      if (isInViewport(img)) {
        visibleGifs.push(img);
      } else {
        hiddenGifs.push(img);
      }
    }
  });
  
  const allGifs = [...visibleGifs, ...hiddenGifs].slice(0, MAX_GIFS);
  const visibleCount = Math.min(visibleGifs.length, MAX_GIFS);
  
  totalGifsFound = allGifs.length;
  
  if (totalGifsFound > 0) {
    logTiming('Found ' + totalGifsFound + ' GIFs (' + visibleCount + ' visible)');
    
    for (let i = 0; i < allGifs.length; i++) {
      await queueGif(allGifs[i], i < visibleCount);
    }
    
    logTiming('All ' + totalGifsFound + ' GIFs queued');
  }
  
  initialScanDone = true;
}

if (isContextValid()) {
  logTiming('Initializing...');
  
  setInterval(checkResults, 200);
  
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.modelStatus?.newValue?.status === 'ready' && !initialScanDone) {
      scan();
    }
  });
  
  scan();
} else {
  console.error('[GIF] Extension context invalid!');
}