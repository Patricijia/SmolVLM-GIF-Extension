import {
  AutoProcessor,
  AutoModelForVision2Seq,
  load_image,
  env,
} from '@huggingface/transformers';
import Tesseract from 'tesseract.js';

env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/');
env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency || 4;
env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';

let processor = null;
let model = null;
let ocrWorker = null;
let isLoaded = false;
let captionCount = 0;
let isGenerating = false;
let device = 'unknown';
let consecutiveErrors = 0;

const logEl = document.getElementById('log');
const statusBadge = document.getElementById('statusBadge');

function log(msg) {
  console.log(msg);
  if (logEl) {
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function setStatus(text, cls) {
  if (statusBadge) {
    statusBadge.textContent = text;
    statusBadge.className = 'status ' + cls;
  }
}

log('[INF] ========== INFERENCE PAGE STARTED ==========');

// ============================================================
// STORAGE HELPERS
// ============================================================

async function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => resolve(data || {}));
  });
}

async function setStorage(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => resolve());
  });
}

async function updateStatus(data) {
  const result = await getStorage('modelStatus');
  const current = result.modelStatus || {};
  await setStorage({ modelStatus: { ...current, ...data, captionCount, device } });
}

// ============================================================
// OCR (Tesseract.js)
// ============================================================

async function initOCR() {
  log('[INF] Initializing OCR worker...');
  try {
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
      langPath: chrome.runtime.getURL('tesseract'),
      corePath: chrome.runtime.getURL('tesseract/'),
      workerBlobURL: false,
      gzip: false,
    });
    log('[INF] ✅ OCR worker ready');
    return true;
  } catch (e) {
    log('[INF] OCR init failed: ' + e.message);
    return false;
  }
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

function downscaleImage(dataUrl, maxWidth) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth <= maxWidth) { resolve(dataUrl); return; }
      const scale = maxWidth / img.naturalWidth;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
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
  const shortCount = allWords.filter(w => w.replace(/[^a-zA-Z0-9]/g, '').length <= 2).length;
  if (allWords.length > 2 && shortCount / allWords.length > 0.4) return '';
  const words = allWords.filter(w => {
    const clean = w.replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length < 2) return false;
    if (clean.length >= 3 && !/[aeiouyAEIOUY]/.test(clean)) return false;
    return true;
  });
  text = words.join(' ').trim();
  return text.length < 3 ? '' : text;
}

function isolateTextByColor(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const src = ctx.getImageData(0, 0, w, h);

      const whiteCanvas = document.createElement('canvas');
      whiteCanvas.width = w; whiteCanvas.height = h;
      const whiteCtx = whiteCanvas.getContext('2d');
      const whiteData = whiteCtx.createImageData(w, h);

      const blackCanvas = document.createElement('canvas');
      blackCanvas.width = w; blackCanvas.height = h;
      const blackCtx = blackCanvas.getContext('2d');
      const blackData = blackCtx.createImageData(w, h);

      for (let i = 0; i < src.data.length; i += 4) {
        const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
        const isWhite = r > 200 && g > 200 && b > 200;
        whiteData.data[i] = isWhite ? 0 : 255;
        whiteData.data[i + 1] = isWhite ? 0 : 255;
        whiteData.data[i + 2] = isWhite ? 0 : 255;
        whiteData.data[i + 3] = 255;
        const isBlack = r < 55 && g < 55 && b < 55;
        blackData.data[i] = isBlack ? 0 : 255;
        blackData.data[i + 1] = isBlack ? 0 : 255;
        blackData.data[i + 2] = isBlack ? 0 : 255;
        blackData.data[i + 3] = 255;
      }

      whiteCtx.putImageData(whiteData, 0, 0);
      blackCtx.putImageData(blackData, 0, 0);
      resolve({ white: whiteCanvas.toDataURL('image/png'), black: blackCanvas.toDataURL('image/png') });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function extractText(imageData) {
  if (!ocrWorker) return '';
  try {
    const dims = await getImageDimensions(imageData);
    if (dims.width < 100 || dims.height < 100) return '';
    const scaled = await downscaleImage(imageData, 500);
    const isolated = await isolateTextByColor(scaled);
    if (!isolated) return '';
    const [whiteResult, blackResult] = await Promise.all([
      ocrWorker.recognize(isolated.white),
      ocrWorker.recognize(isolated.black)
    ]);
    const whiteText = cleanOcrText(whiteResult.data.text?.trim() || '');
    const blackText = cleanOcrText(blackResult.data.text?.trim() || '');
    return whiteText.length >= blackText.length ? whiteText : blackText;
  } catch (e) {
    return '';
  }
}

// ============================================================
// SmolVLM (main thread for WebGPU access)
// ============================================================

// Check if we should skip WebGPU (set after a failed attempt)
const forceWasm = new URL(location.href).searchParams.has('wasm');

async function loadModel() {
  if (isLoaded) return;

  log('[INF] Loading models...');
  setStatus('Loading SmolVLM...', 'loading');
  const start = performance.now();
  await updateStatus({ status: 'loading', progress: 10 });

  try {
    // Decide device: try WebGPU unless we already know it fails.
    // A failed WebGPU from_pretrained taints ONNX's internal wasmInitPromise,
    // making WASM fallback impossible in the same page load. So if WebGPU
    // fails, we reload the page with ?wasm to get a clean ONNX state.
    let useDevice = 'wasm';
    let useDtype = 'q4';
    if (!forceWasm && navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          const hasFp16 = adapter.features.has('shader-f16');
          log('[INF] WebGPU adapter found, fp16=' + hasFp16);
          if (hasFp16) {
            // fp16: best option — works on Apple Silicon, modern NVIDIA/AMD
            const gpuDevice = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
            gpuDevice.destroy();
            useDevice = 'webgpu';
            useDtype = 'fp16';
            log('[INF] Will use WebGPU fp16');
          } else {
            // No fp16: fp32 works but needs >4GB VRAM, risky on small GPUs.
            // q4 has no WebGPU kernels. Fall back to WASM.
            log('[INF] No fp16 — falling back to WASM');
          }
        }
      } catch (e) {
        log('[INF] WebGPU probe failed: ' + e.message);
      }
    } else if (forceWasm) {
      log('[INF] WASM mode (WebGPU failed on previous attempt)');
    }
    log('[INF] Using: ' + useDevice + ' / ' + useDtype);

    // Load processor, OCR, and model in parallel
    log('[INF] Loading processor + OCR + SmolVLM (' + useDevice + ')...');
    await updateStatus({ status: 'loading', progress: 20 });
    const [, , ] = await Promise.all([
      AutoProcessor.from_pretrained(MODEL_ID).then(p => { processor = p; }),
      initOCR(),
      AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
        dtype: useDtype,
        device: useDevice,
      }).then(m => { model = m; }),
    ]);
    device = useDevice;
    log('[INF] ✅ SmolVLM loaded (' + device + ' ' + useDtype + ')');

    isLoaded = true;
    const loadTime = Math.round(performance.now() - start);
    await updateStatus({ status: 'ready', progress: 100, loadTime });
    log('[INF] All models ready in ' + loadTime + 'ms');
    setStatus('Ready (' + device + ') — ' + loadTime + 'ms', 'ready');

    processQueue();

  } catch (err) {
    log('[INF] Load failed: ' + err.message);

    // If WebGPU was attempted and failed, reload with clean ONNX state for WASM
    if (!forceWasm && err.message.includes('webgpu')) {
      log('[INF] WebGPU runtime failed — reloading in WASM mode...');
      await updateStatus({ status: 'loading', progress: 5, message: 'Falling back to WASM...' });
      const wasmUrl = chrome.runtime.getURL('inference.html') + '?wasm';
      location.replace(wasmUrl);
      return;
    }

    setStatus('Error: ' + err.message, 'error');
    await updateStatus({ status: 'error', message: err.message });
  }
}

// ============================================================
// GENERATE CAPTION
// ============================================================

async function generateCaption(imageData) {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image' },
        { type: 'text', text: 'Describe this GIF briefly.' },
      ],
    },
  ];

  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const image = await load_image(imageData);
  const inputs = await processor(text, [image]);

  log('[INF] Running model.generate...');
  const genStart = performance.now();

  const output = await model.generate({
    ...inputs,
    do_sample: false,
    max_new_tokens: 20,
    repetition_penalty: 1.1,
  });

  const genTime = Math.round(performance.now() - genStart);
  log('[INF] Generation took ' + genTime + 'ms');

  const decoded = processor.batch_decode(output, { skip_special_tokens: true });
  const fullText = decoded[0] || '';
  const assistantIdx = fullText.lastIndexOf('Assistant:');
  return (assistantIdx >= 0 ? fullText.slice(assistantIdx + 10) : fullText)
    .trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
}

// ============================================================
// CAPTION + OCR
// ============================================================

const CAPTION_TIMEOUT_MS = 300000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout after ' + ms + 'ms')), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function generateCaptionWithOCR(imageData, ocrImage) {
  if (!isLoaded || !model || !processor) return { error: 'Not loaded' };
  if (isGenerating) return { error: 'Busy' };

  isGenerating = true;
  const start = performance.now();

  try {
    const [caption, ocrText] = await withTimeout(
      Promise.all([
        generateCaption(imageData),
        ocrWorker ? extractText(ocrImage || imageData) : Promise.resolve('')
      ]),
      CAPTION_TIMEOUT_MS
    );

    let finalCaption = 'Gif displays ' + caption;
    if (ocrText && ocrText.length > 3) {
      finalCaption += ' with text ' + ocrText;
    }
    finalCaption = finalCaption.replace(/\s+/g, ' ').trim();

    const time = Math.round(performance.now() - start);
    captionCount++;
    consecutiveErrors = 0;
    await updateStatus({ captionCount });

    log('[INF] ✓ "' + finalCaption + '" (' + time + 'ms)');
    isGenerating = false;
    return { caption: finalCaption, ocrText, time };

  } catch (err) {
    log('[INF] Generate error: ' + err.message);
    isGenerating = false;
    consecutiveErrors++;
    return { error: err.message };
  }
}

// ============================================================
// QUEUE PROCESSOR
// ============================================================

async function processQueue() {
  log('[INF] Queue processor started');

  let logCounter = 0;
  while (true) {
    try {
      if (!isGenerating && isLoaded) {
        const data = await getStorage(['captionQueue', 'captionResults']);
        const queue = data.captionQueue || [];

        if (queue.length === 0 && ++logCounter % 50 === 0) {
          log('[INF] Waiting for queue... (device=' + device + ' captions=' + captionCount + ')');
        }

        if (queue.length > 0) {
          logCounter = 0;
          const item = queue.shift();
          await setStorage({ captionQueue: queue });

          log('[INF] Processing: ' + item.gifId + ' (' + queue.length + ' left)');
          const result = await generateCaptionWithOCR(item.imageData, item.ocrImage);

          if (!result.error) {
            const results = data.captionResults || {};
            results[item.gifId] = result;
            await setStorage({ captionResults: results });
          } else {
            log('[INF] Failed: ' + result.error + ' (errors=' + consecutiveErrors + ')');
            if (consecutiveErrors < 3) {
              const currentData = await getStorage('captionQueue');
              const currentQueue = currentData.captionQueue || [];
              currentQueue.push(item);
              await setStorage({ captionQueue: currentQueue });
            } else {
              log('[INF] Dropping ' + item.gifId);
            }
          }
        }
      }
    } catch (e) {
      log('[INF] Queue error: ' + e.message);
    }

    await new Promise(r => setTimeout(r, 200));
  }
}

// ============================================================
// MESSAGES & AUTO-LOAD
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'loadModel') {
    loadModel();
    sendResponse({ received: true });
  }
  if (msg.type === 'ping') {
    sendResponse({ alive: true, device, captionCount, isLoaded });
  }
  return true;
});

loadModel();
