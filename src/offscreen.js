/**
 * SmolVLM Offscreen Document - handles model inference.
 * Same architecture as vit-gpt2 extension:
 *   content.js → background.js → offscreen.js (DESCRIBE_GIF) → response
 */
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
let modelLoadTime = 0;
let ocrLoadTime = 0;
let device = 'unknown';

// === Load SmolVLM model ===
let modelLoadPromise = null;

async function loadModel() {
  if (model) return;
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
    const t0 = performance.now();
    console.log('[offscreen] Loading SmolVLM...');

    processor = await AutoProcessor.from_pretrained(MODEL_ID);

    // Try WebGPU fp16, fallback to fp32, then WASM
    try {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'low-power' });
      if (adapter?.features?.has('shader-f16')) {
        navigator.gpu.requestAdapter = async () => adapter;
        model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, { dtype: 'fp16', device: 'webgpu' });
        device = 'webgpu-fp16';
        console.log('[offscreen] SmolVLM loaded (WebGPU fp16)');
      } else {
        throw new Error('No fp16 support');
      }
    } catch (e) {
      console.log('[offscreen] WebGPU fp16 failed:', e.message, '- trying fp32...');
      try {
        model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, { dtype: 'fp32', device: 'webgpu' });
        device = 'webgpu-fp32';
        console.log('[offscreen] SmolVLM loaded (WebGPU fp32)');
      } catch (e2) {
        console.log('[offscreen] WebGPU fp32 failed:', e2.message, '- falling back to WASM q8...');
        model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' });
        device = 'wasm-q8';
        console.log('[offscreen] SmolVLM loaded (WASM q8)');
      }
    }

    modelLoadTime = performance.now() - t0;
    console.log(`[offscreen] SmolVLM ready in ${modelLoadTime.toFixed(0)}ms (${device})`);
  })();

  return modelLoadPromise;
}

// === Load Tesseract OCR worker (identical to vit-gpt2) ===
let ocrLoadPromise = null;

async function loadOCR() {
  if (ocrWorker) return;
  if (ocrLoadPromise) return ocrLoadPromise;

  ocrLoadPromise = (async () => {
    const t0 = performance.now();
    console.log('[offscreen] Loading Tesseract OCR...');
    try {
      ocrWorker = await Tesseract.createWorker('eng', 1, {
        workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
        langPath: chrome.runtime.getURL('tesseract'),
        corePath: chrome.runtime.getURL('tesseract/'),
        workerBlobURL: false,
        gzip: false,
      });
      ocrLoadTime = performance.now() - t0;
      console.log(`[offscreen] Tesseract OCR ready in ${ocrLoadTime.toFixed(0)}ms`);
    } catch (e) {
      console.error('[offscreen] OCR init failed:', e.message);
      ocrWorker = null;
    }
  })();

  return ocrLoadPromise;
}

// Load both in parallel on startup
loadModel();
loadOCR();

// === OCR utilities (identical to vit-gpt2) ===

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

async function isolateTextByColor(blobUrl) {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, h = bmp.height;

  const srcCanvas = new OffscreenCanvas(w, h);
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(bmp, 0, 0);
  const src = srcCtx.getImageData(0, 0, w, h);

  const whiteCanvas = new OffscreenCanvas(w, h);
  const whiteCtx = whiteCanvas.getContext('2d');
  const whiteData = whiteCtx.createImageData(w, h);

  const blackCanvas = new OffscreenCanvas(w, h);
  const blackCtx = blackCanvas.getContext('2d');
  const blackData = blackCtx.createImageData(w, h);

  for (let i = 0; i < src.data.length; i += 4) {
    const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
    const isLight = r > 200 && g > 200 && b > 200;
    whiteData.data[i]     = isLight ? 0 : 255;
    whiteData.data[i + 1] = isLight ? 0 : 255;
    whiteData.data[i + 2] = isLight ? 0 : 255;
    whiteData.data[i + 3] = 255;
    const isDark = r < 55 && g < 55 && b < 55;
    blackData.data[i]     = isDark ? 0 : 255;
    blackData.data[i + 1] = isDark ? 0 : 255;
    blackData.data[i + 2] = isDark ? 0 : 255;
    blackData.data[i + 3] = 255;
  }

  whiteCtx.putImageData(whiteData, 0, 0);
  blackCtx.putImageData(blackData, 0, 0);

  const [whiteBlob, blackBlob] = await Promise.all([
    whiteCanvas.convertToBlob({ type: 'image/png' }),
    blackCanvas.convertToBlob({ type: 'image/png' }),
  ]);

  return {
    white: URL.createObjectURL(whiteBlob),
    black: URL.createObjectURL(blackBlob),
  };
}

async function extractTextFromFrame(blobUrl) {
  if (!ocrWorker) return '';
  try {
    const isolated = await isolateTextByColor(blobUrl);
    const [whiteResult, blackResult] = await Promise.all([
      ocrWorker.recognize(isolated.white),
      ocrWorker.recognize(isolated.black),
    ]);
    URL.revokeObjectURL(isolated.white);
    URL.revokeObjectURL(isolated.black);
    const whiteText = cleanOcrText(whiteResult.data.text?.trim() || '');
    const blackText = cleanOcrText(blackResult.data.text?.trim() || '');
    return whiteText.length >= blackText.length ? whiteText : blackText;
  } catch {
    return '';
  }
}

async function extractTextBestOf(blobUrls) {
  const results = await Promise.all(blobUrls.map(u => extractTextFromFrame(u)));
  blobUrls.forEach(u => URL.revokeObjectURL(u));
  return results.reduce((best, t) => t.length > best.length ? t : best, '');
}

// === Grid construction ===
const NUM_FRAMES = 16;
const GRID_ROWS = 4;
const GRID_COLS = 4;
const CELL_SIZE = 224;
const FINAL_SIZE = 908;
const PAD_BETWEEN = 4;

async function extractFramesAndBuildGrid(url) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();

  if (typeof ImageDecoder === 'undefined') {
    const blob = new Blob([buffer], { type: 'image/gif' });
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(FINAL_SIZE, FINAL_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, FINAL_SIZE, FINAL_SIZE);
    ctx.drawImage(bmp, 0, 0, FINAL_SIZE, FINAL_SIZE);
    const gridBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return { gridUrl: URL.createObjectURL(gridBlob), ocrUrls: [], frameCount: 1 };
  }

  const decoder = new ImageDecoder({ data: new Uint8Array(buffer), type: 'image/gif' });
  await decoder.tracks.ready;
  const frameCount = decoder.tracks.selectedTrack.frameCount;

  // Select 16 evenly spaced frames
  const indices = [];
  const step = Math.max(1, (frameCount - 1) / (NUM_FRAMES - 1));
  for (let i = 0; i < NUM_FRAMES; i++) {
    indices.push(Math.min(Math.floor(i * step), frameCount - 1));
  }

  // Build 4x4 grid
  const gridW = GRID_COLS * CELL_SIZE + (GRID_COLS - 1) * PAD_BETWEEN;
  const gridH = GRID_ROWS * CELL_SIZE + (GRID_ROWS - 1) * PAD_BETWEEN;
  const gridCanvas = new OffscreenCanvas(gridW, gridH);
  const gridCtx = gridCanvas.getContext('2d');
  gridCtx.fillStyle = '#000';
  gridCtx.fillRect(0, 0, gridW, gridH);

  for (let i = 0; i < indices.length; i++) {
    const { image } = await decoder.decode({ frameIndex: indices[i] });
    const row = Math.floor(i / GRID_COLS);
    const col = i % GRID_COLS;
    const x = col * (CELL_SIZE + PAD_BETWEEN);
    const y = row * (CELL_SIZE + PAD_BETWEEN);
    const scale = Math.min(CELL_SIZE / image.displayWidth, CELL_SIZE / image.displayHeight);
    const w = image.displayWidth * scale;
    const h = image.displayHeight * scale;
    gridCtx.drawImage(image, x + (CELL_SIZE - w) / 2, y + (CELL_SIZE - h) / 2, w, h);
  }

  // Scale to final size
  const finalCanvas = new OffscreenCanvas(FINAL_SIZE, FINAL_SIZE);
  const finalCtx = finalCanvas.getContext('2d');
  finalCtx.fillStyle = '#000';
  finalCtx.fillRect(0, 0, FINAL_SIZE, FINAL_SIZE);
  const s = Math.min(FINAL_SIZE / gridW, FINAL_SIZE / gridH);
  finalCtx.drawImage(gridCanvas, (FINAL_SIZE - gridW * s) / 2, (FINAL_SIZE - gridH * s) / 2, gridW * s, gridH * s);

  const gridBlob = await finalCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });

  // OCR frames: first and middle
  const ocrUrls = [];
  for (const idx of [0, Math.max(0, Math.floor(frameCount / 2) - 1)]) {
    const { image } = await decoder.decode({ frameIndex: idx });
    const ocrCanvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
    ocrCanvas.getContext('2d').drawImage(image, 0, 0);
    const ocrBlob = await ocrCanvas.convertToBlob({ type: 'image/png' });
    ocrUrls.push(URL.createObjectURL(ocrBlob));
  }

  decoder.close();
  return { gridUrl: URL.createObjectURL(gridBlob), ocrUrls, frameCount };
}

// === Caption prompt ===
const PROMPT = "These frames are from an animated GIF, ordered left to right over time. Describe what is happening in a short, simple sentence.";

// === Describe GIF (same interface as vit-gpt2's describeGif) ===
async function describeGif(url, ocrEnabled = true) {
  const t0 = performance.now();

  await Promise.all([loadModel(), ocrEnabled ? loadOCR() : Promise.resolve()]);
  const tModelsReady = performance.now();

  const { gridUrl, ocrUrls, frameCount } = await extractFramesAndBuildGrid(url);
  const tFrames = performance.now();
  if (!ocrEnabled) {
    ocrUrls.forEach(u => URL.revokeObjectURL(u));
    ocrUrls.length = 0;
  }

  // Run captioning and OCR in parallel
  const captionPromise = (async () => {
    const image = await load_image(gridUrl);
    URL.revokeObjectURL(gridUrl);

    const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: PROMPT }] }];
    const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await processor(text, [image]);

    const genStart = performance.now();
    const output = await model.generate({ ...inputs, do_sample: false, max_new_tokens: 20, repetition_penalty: 1.3 });
    const genTime = performance.now() - genStart;

    const decoded = processor.batch_decode(output, { skip_special_tokens: true });
    const fullText = decoded[0] || '';
    const idx = fullText.lastIndexOf('Assistant:');
    const caption = (idx >= 0 ? fullText.slice(idx + 10) : fullText).trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');

    return { caption, genTime };
  })();

  // Time OCR inside the promise so ocrMs reflects pure OCR cost,
  // independent of when the parallel caption finishes.
  let ocrMs = 0;
  const ocrPromise = ocrUrls.length > 0
    ? (async () => {
        const t0 = performance.now();
        const text = await extractTextBestOf(ocrUrls);
        ocrMs = performance.now() - t0;
        return text;
      })()
    : Promise.resolve('');

  const [{ caption: rawCaption, genTime }, ocrText] = await Promise.all([captionPromise, ocrPromise]);
  const tDone = performance.now();

  let caption = rawCaption;
  if (ocrText && ocrText.length > 3) caption += '. Text: ' + ocrText;

  const metrics = {
    modelLoadMs: Math.round(modelLoadTime),
    ocrLoadMs: Math.round(ocrLoadTime),
    frameExtractionMs: Math.round(tFrames - tModelsReady),
    totalInferenceMs: Math.round(genTime),
    avgFrameInferenceMs: Math.round(genTime),
    summaryMs: 0,
    totalMs: Math.round(tDone - t0),
    framesExtracted: NUM_FRAMES,
    totalGifFrames: frameCount,
    ocrEnabled,
    ocrMs: Math.round(ocrMs),
    ocrDetected: ocrText.length > 0,
    ocrText: ocrText || null,
    device: device,
  };

  console.log(
    `[offscreen] ${metrics.totalMs}ms total | grid: ${metrics.frameExtractionMs}ms, inference: ${metrics.totalInferenceMs}ms | ` +
    `${NUM_FRAMES}/${frameCount} frames | OCR: ${ocrText ? '"' + ocrText + '"' : 'none'} | "${caption}"`
  );

  return { caption, metrics };
}

// === Sequential queue to prevent concurrent ONNX sessions ===
let busy = false;
const queue = [];

function processQueue() {
  if (busy || queue.length === 0) return;
  busy = true;
  const { url, ocrEnabled, sendResponse } = queue.shift();

  describeGif(url, ocrEnabled)
    .then(({ caption, metrics }) => sendResponse({ caption, metrics }))
    .catch((err) => {
      console.error('[offscreen] Error:', err);
      sendResponse({ error: err.message });
    })
    .finally(() => {
      busy = false;
      processQueue();
    });
}

// === Message handler (identical pattern to vit-gpt2) ===
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'DESCRIBE_GIF' || message.target !== 'offscreen') return;

  queue.push({ url: message.url, ocrEnabled: message.ocr !== false, sendResponse });
  processQueue();

  return true; // keep sendResponse alive
});
