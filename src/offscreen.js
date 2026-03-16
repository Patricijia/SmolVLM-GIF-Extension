import { pipeline, env } from '@huggingface/transformers';
import Tesseract from 'tesseract.js';

env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/');
env.allowLocalModels = false;
env.useBrowserCache = true;

let captioner = null;
let ocrWorker = null;
let isLoaded = false;
let captionCount = 0;
let isGenerating = false;
let device = 'unknown';
let consecutiveErrors = 0;

console.log('[OFF] ========== OFFSCREEN STARTED ==========');

// ============================================================
// STORAGE HELPERS
// ============================================================

async function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'STORAGE_GET', keys }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }
      resolve(response?.success ? response.data : {});
    });
  });
}

async function setStorage(data) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'STORAGE_SET', data }, () => resolve());
  });
}

async function updateStatus(data) {
  const result = await getStorage('modelStatus');
  const current = result.modelStatus || {};
  await setStorage({ modelStatus: { ...current, ...data, captionCount, device } });
}

// ============================================================
// OCR (Tesseract.js - runs on CPU via WASM)
// ============================================================

async function initOCR() {
  console.log('[OFF] Initializing OCR worker...');
  
  try {
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
      langPath: chrome.runtime.getURL('tesseract'),
      corePath: chrome.runtime.getURL('tesseract/'),
      workerBlobURL: false,
      gzip: false,
    });
    
    console.log('[OFF] ✅ OCR worker ready (CPU/WASM)');
    return true;
  } catch (e) {
    console.error('[OFF] OCR init failed:', e.message);
    return false;
  }
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to load image for dimensions'));
    img.src = dataUrl;
  });
}

function downscaleImage(dataUrl, maxWidth) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth <= maxWidth) {
        resolve(dataUrl);
        return;
      }
      const scale = maxWidth / img.naturalWidth;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function cleanOcrText(rawText) {
  if (!rawText) return '';

  let text = rawText.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const allWords = text.split(' ').filter(w => w.length > 0);
  if (allWords.length === 0) return '';

  // Count short words (1-2 chars) — OCR garbage is mostly short fragments
  const shortCount = allWords.filter(w => w.replace(/[^a-zA-Z0-9]/g, '').length <= 2).length;
  if (allWords.length > 2 && shortCount / allWords.length > 0.4) return '';

  // Remove single-char words and words without vowels
  const words = allWords.filter(w => {
    const clean = w.replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length < 2) return false;
    if (clean.length >= 3 && !/[aeiouyAEIOUY]/.test(clean)) return false;
    return true;
  });

  text = words.join(' ').trim();
  if (text.length < 3) return '';
  return text;
}

// Isolate white or black text from the image for better OCR
function isolateTextByColor(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const src = ctx.getImageData(0, 0, w, h);

      // White text version: near-white pixels → black on white background
      const whiteCanvas = document.createElement('canvas');
      whiteCanvas.width = w;
      whiteCanvas.height = h;
      const whiteCtx = whiteCanvas.getContext('2d');
      const whiteData = whiteCtx.createImageData(w, h);

      // Black text version: near-black pixels → black on white background
      const blackCanvas = document.createElement('canvas');
      blackCanvas.width = w;
      blackCanvas.height = h;
      const blackCtx = blackCanvas.getContext('2d');
      const blackData = blackCtx.createImageData(w, h);

      for (let i = 0; i < src.data.length; i += 4) {
        const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];

        // White text: pixel is near-white (R,G,B all > 200)
        const isWhite = r > 200 && g > 200 && b > 200;
        whiteData.data[i] = isWhite ? 0 : 255;
        whiteData.data[i + 1] = isWhite ? 0 : 255;
        whiteData.data[i + 2] = isWhite ? 0 : 255;
        whiteData.data[i + 3] = 255;

        // Black text: pixel is near-black (R,G,B all < 55)
        const isBlack = r < 55 && g < 55 && b < 55;
        blackData.data[i] = isBlack ? 0 : 255;
        blackData.data[i + 1] = isBlack ? 0 : 255;
        blackData.data[i + 2] = isBlack ? 0 : 255;
        blackData.data[i + 3] = 255;
      }

      whiteCtx.putImageData(whiteData, 0, 0);
      blackCtx.putImageData(blackData, 0, 0);

      resolve({
        white: whiteCanvas.toDataURL('image/png'),
        black: blackCanvas.toDataURL('image/png')
      });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function extractText(imageData) {
  if (!ocrWorker) return '';

  try {
    const dims = await getImageDimensions(imageData);

    if (dims.width < 100 || dims.height < 100) {
      console.log('[OFF] OCR skip: image too small (' + dims.width + 'x' + dims.height + ')');
      return '';
    }

    console.log('[OFF] OCR input: ' + dims.width + 'x' + dims.height);

    const scaled = await downscaleImage(imageData, 500);

    // Create binarized versions for white and black text
    const isolated = await isolateTextByColor(scaled);
    if (!isolated) return '';

    // Run OCR on both white-text and black-text versions
    const [whiteResult, blackResult] = await Promise.all([
      ocrWorker.recognize(isolated.white),
      ocrWorker.recognize(isolated.black)
    ]);

    const whiteRaw = whiteResult.data.text?.trim() || '';
    const blackRaw = blackResult.data.text?.trim() || '';
    const whiteText = cleanOcrText(whiteRaw);
    const blackText = cleanOcrText(blackRaw);

    console.log('[OFF] OCR white: "' + whiteRaw.substring(0, 80).replace(/\n/g, ' ') + '" → "' + whiteText + '"');
    console.log('[OFF] OCR black: "' + blackRaw.substring(0, 80).replace(/\n/g, ' ') + '" → "' + blackText + '"');

    // Pick the longer clean result (more real words = better)
    const text = whiteText.length >= blackText.length ? whiteText : blackText;
    if (text) console.log('[OFF] OCR result: "' + text + '"');
    return text;
  } catch (e) {
    console.error('[OFF] OCR error:', e.message);
    return '';
  }
}

// ============================================================
// CAPTIONING (SmolVLM/ViT - runs on WebGPU)
// ============================================================

async function loadModel() {
  if (isLoaded) return;
  
  console.log('[OFF] Loading models...');
  const start = performance.now();
  
  await updateStatus({ status: 'loading', progress: 10 });

  // Check WebGPU
  let useWebGPU = false;
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        console.log('[OFF] WebGPU adapter found');
        useWebGPU = true;
      }
    } catch (e) {
      console.log('[OFF] WebGPU check failed:', e.message);
    }
  }

  try {
    if (useWebGPU) {
      console.log('[OFF] Loading captioner with WebGPU...');
      try {
        captioner = await pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning', {
          device: 'webgpu',
          dtype: 'fp32',
        });
        device = 'webgpu';
        console.log('[OFF] ✅ Captioner loaded (WebGPU)');
      } catch (e) {
        console.log('[OFF] WebGPU captioner failed, falling back to WASM:', e.message);
        useWebGPU = false;
      }
    }

    if (!captioner) {
      console.log('[OFF] Loading captioner with WASM...');
      captioner = await pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning', {
        device: 'wasm',
      });
      device = 'wasm';
      console.log('[OFF] ✅ Captioner loaded (WASM)');
    }

    // 2. Load OCR worker (CPU) - after captioner to avoid WASM thread contention
    await initOCR();

    isLoaded = true;
    const loadTime = Math.round(performance.now() - start);
    await updateStatus({ status: 'ready', progress: 100, loadTime });
    console.log('[OFF] All models ready in ' + loadTime + 'ms');

    processQueue();
    
  } catch (err) {
    console.error('[OFF] Load failed:', err);
    await updateStatus({ status: 'error', message: err.message });
  }
}

// ============================================================
// PARALLEL CAPTION + OCR
// ============================================================

const CAPTION_TIMEOUT_MS = 30000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timeout after ' + ms + 'ms')), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function recoverWithWasm() {
  console.log('[OFF] Recovering with WASM...');
  captioner = null;
  try {
    captioner = await pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning', {
      device: 'wasm',
    });
    device = 'wasm';
    isLoaded = true;
    consecutiveErrors = 0;
    await updateStatus({ status: 'ready', device: 'wasm' });
    console.log('[OFF] ✅ Recovered with WASM');
  } catch (e) {
    console.error('[OFF] Recovery failed:', e.message);
    isLoaded = false;
    await updateStatus({ status: 'error', message: 'Recovery failed' });
  }
}

async function generateCaptionWithOCR(imageData, ocrImage) {
  if (!isLoaded || !captioner) return { error: 'Not loaded' };
  if (isGenerating) return { error: 'Busy' };

  isGenerating = true;
  const start = performance.now();

  try {
    // Run BOTH in parallel with timeout to catch WebGPU hangs
    const [captionResult, ocrText] = await withTimeout(
      Promise.all([
        captioner(imageData, { max_new_tokens: 20 }),
        ocrWorker ? extractText(ocrImage || imageData) : Promise.resolve('')
      ]),
      CAPTION_TIMEOUT_MS
    );

    const rawCaption = captionResult[0].generated_text.trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');

    // Format: "Gif displays [caption] with text [ocrText]"
    let caption = 'Gif displays ' + rawCaption;
    if (ocrText && ocrText.length > 3) {
      caption = caption + ' with text ' + ocrText;
    }
    caption = caption.replace(/\s+/g, ' ').trim();

    const time = Math.round(performance.now() - start);

    captionCount++;
    consecutiveErrors = 0;
    await updateStatus({ captionCount });

    console.log('[OFF] ✓ "' + caption + '" (' + time + 'ms)');

    isGenerating = false;
    return { caption, ocrText, time };

  } catch (err) {
    console.error('[OFF] Generate error:', err.message);
    isGenerating = false;
    consecutiveErrors++;

    // If WebGPU hung or errored, fall back to WASM
    if (device === 'webgpu') {
      console.log('[OFF] ⚠️ WebGPU failed, recovering to WASM...');
      await recoverWithWasm();
    }

    return { error: err.message };
  }
}

// ============================================================
// QUEUE PROCESSOR
// ============================================================

async function processQueue() {
  console.log('[OFF] Queue processor started');
  
  // Keep-alive ping
  setInterval(() => {
    chrome.runtime.sendMessage({ type: 'keepAlive' }).catch(() => {});
  }, 20000);
  
  let logCounter = 0;
  while (true) {
    try {
      if (!isGenerating && isLoaded) {
        const data = await getStorage(['captionQueue', 'captionResults']);
        const queue = data.captionQueue || [];

        // Log queue status every 50 iterations (~10s) when idle
        if (queue.length === 0 && ++logCounter % 50 === 0) {
          console.log('[OFF] Waiting for queue... (isLoaded=' + isLoaded + ' device=' + device + ' captionCount=' + captionCount + ')');
        }

        if (queue.length > 0) {
          logCounter = 0;
          const item = queue.shift();
          await setStorage({ captionQueue: queue });

          console.log('[OFF] Processing: ' + item.gifId + ' (' + queue.length + ' left, device=' + device + ')');

          const result = await generateCaptionWithOCR(item.imageData, item.ocrImage);

          if (!result.error) {
            const results = data.captionResults || {};
            results[item.gifId] = result;
            await setStorage({ captionResults: results });
            console.log('[OFF] Result stored for ' + item.gifId);
          } else {
            console.log('[OFF] Generate failed: ' + result.error + ' (consecutiveErrors=' + consecutiveErrors + ')');
            if (consecutiveErrors < 3) {
              const currentData = await getStorage('captionQueue');
              const currentQueue = currentData.captionQueue || [];
              currentQueue.push(item);
              await setStorage({ captionQueue: currentQueue });
              console.log('[OFF] Re-queued ' + item.gifId);
            } else {
              console.log('[OFF] Dropping ' + item.gifId + ' after ' + consecutiveErrors + ' consecutive errors');
            }
          }
        }
      } else if (!isLoaded) {
        if (++logCounter % 50 === 0) {
          console.log('[OFF] Model not loaded yet, waiting...');
        }
      }
    } catch (e) {
      console.error('[OFF] Queue error:', e.message);
    }

    await new Promise(r => setTimeout(r, 200));
  }
}

// ============================================================
// CLEANUP
// ============================================================

async function cleanup() {
  if (ocrWorker) {
    await ocrWorker.terminate();
    ocrWorker = null;
  }
}

// ============================================================
// INIT
// ============================================================

function init() {
  console.log('[OFF] Ready');
  
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'offscreen') return;
    
    if (msg.type === 'loadModel') {
      loadModel();
      sendResponse({ received: true });
    }
    
    return true;
  });
  
  // Cleanup on unload
  window.addEventListener('beforeunload', cleanup);
}

init();