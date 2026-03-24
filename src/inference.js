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

const DEFAULT_MODEL_ID = 'Patricijia/smolvlm-gif-descriptor';
let MODEL_ID = DEFAULT_MODEL_ID;
let PROCESSOR_ID = DEFAULT_MODEL_ID;

let processor = null;
let model = null;
let ocrWorker = null;
let isLoaded = false;
let captionCount = 0;
let isGenerating = false;
let device = 'unknown';
let consecutiveErrors = 0;
const BATCH_SIZE = 3;

// OCR pre-cache: Tesseract jobs are started as soon as items enter the queue so
// the OCR worker runs ahead of the GPU caption batches (no ONNX conflict —
// Tesseract uses its own WASM binary, separate from ONNX Runtime).
const ocrCache = new Map();

function precomputeOcr(item) {
  if (ocrWorker && !ocrCache.has(item.gifId)) {
    const frames = item.ocrFrames || (item.ocrImage ? [item.ocrImage] : [item.imageData]);
    ocrCache.set(item.gifId, extractTextBestOf(frames));
  }
  return ocrCache.get(item.gifId) || Promise.resolve('');
}

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

// Show any error saved from a previous WebGPU attempt
(async () => {
  const d = await getStorage('lastWebGPUError');
  if (d.lastWebGPUError) {
    const e = d.lastWebGPUError;
    log('[INF] ⚠ PREVIOUS WEBGPU FAILURE (device=' + e.device + ' dtype=' + e.dtype + '): ' + e.msg);
    if (e.stack) log('[INF] Stack: ' + e.stack.split('\n').slice(0, 3).join(' | '));
    await setStorage({ lastWebGPUError: null });
  }
})();

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
// OCR (Tesseract.js — separate WASM binary, no ONNX conflict)
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

async function extractTextFromFrame(imageData) {
  if (!ocrWorker) return '';
  try {
    const isolated = await isolateTextByColor(imageData);
    if (!isolated) return '';
    const [whiteResult, blackResult] = await Promise.all([
      ocrWorker.recognize(isolated.white),
      ocrWorker.recognize(isolated.black),
    ]);
    const whiteText = cleanOcrText(whiteResult.data.text?.trim() || '');
    const blackText = cleanOcrText(blackResult.data.text?.trim() || '');
    return whiteText.length >= blackText.length ? whiteText : blackText;
  } catch {
    return '';
  }
}

// Run OCR on all provided frames and return the longest result.
// With 2 frames (first + mid), we catch text at different points in the animation.
async function extractTextBestOf(frames) {
  const results = await Promise.all(frames.map(f => extractTextFromFrame(f)));
  return results.reduce((best, t) => t.length > best.length ? t : best, '');
}

// ============================================================
// SmolVLM (main thread for WebGPU access)
// ============================================================

const forceWasm = new URL(location.href).searchParams.has('wasm');

async function loadModel() {
  if (isLoaded) return;

  // Pick up any model preference set by the content script
  const storedModel = await getStorage('selectedModelId');
  if (storedModel.selectedModelId) {
    MODEL_ID = storedModel.selectedModelId;
    PROCESSOR_ID = storedModel.selectedModelId;
  }

  log('[INF] Loading models...');
  log('[INF] URL: ' + location.href);
  log('[INF] forceWasm=' + forceWasm + ' navigator.gpu=' + (typeof navigator.gpu) + ' value=' + navigator.gpu);
  setStatus('Loading SmolVLM...', 'loading');
  const start = performance.now();
  await updateStatus({ status: 'loading', progress: 10 });

  let useDevice = 'wasm';
  let useDtype = 'q4';

  try {
    log('[INF] Checking WebGPU: forceWasm=' + forceWasm + ' hasGPU=' + !!navigator.gpu);
    if (!forceWasm && navigator.gpu) {
      log('[INF] Entering WebGPU probe block');
      try {
        async function tryAdapter(preference) {
          const a = await navigator.gpu.requestAdapter(preference ? { powerPreference: preference } : undefined);
          if (!a) { log('[INF] requestAdapter(' + preference + ') returned null'); return null; }
          const info = a.info || await a.requestAdapterInfo?.() || {};
          const name = info.description || info.architecture || info.vendor || 'unknown';
          // Do NOT call requestDevice here — adapters are single-use ("consumed" after first requestDevice).
          // Just check the feature list directly; shader-f16 in features means fp16 is supported.
          const fp16 = a.features?.has('shader-f16') ?? false;
          log('[INF] adapter(' + preference + '): ' + name + ' fp16=' + fp16);
          return { adapter: a, name, fp16 };
        }

        // On Optimus laptops the discrete GPU (high-performance) may not expose
        // shader-f16 in Dawn even though the hardware supports it. Try it first,
        // then fall back to the integrated GPU (low-power) which often exposes fp16
        // through its Vulkan driver (e.g. Intel Iris Xe on this machine).
        let best = await tryAdapter('high-performance');
        log('[INF] high-performance adapter: ' + best?.name + ', fp16=' + best?.fp16);

        if (!best?.fp16) {
          const lp = await tryAdapter('low-power');
          log('[INF] low-power adapter: ' + lp?.name + ', fp16=' + lp?.fp16);
          if (lp?.fp16) best = lp; // prefer the adapter that actually has fp16
        }

        if (best?.fp16) {
          useDevice = 'webgpu';
          useDtype = 'fp16';
          // transformers.js isWebGpuFp16Supported() calls navigator.gpu.requestAdapter()
          // with no args and gets the default NVIDIA adapter (no shader-f16).
          // Patch requestAdapter so every caller gets the Intel Xe adapter we probed.
          navigator.gpu.requestAdapter = async () => best.adapter;
          log('[INF] Will use WebGPU fp16 on: ' + best.name + ' (requestAdapter patched)');
        } else {
          // fp32 on WebGPU splits encoder/decoder into separate ONNX sessions which
          // conflict under the JSEP backend ("Session already started"). Use WASM q8.
          useDevice = 'wasm';
          useDtype = 'q8';
          log('[INF] No fp16 on any adapter — falling back to WASM q8');
        }
      } catch (e) {
        log('[INF] WebGPU probe failed: ' + e.message);
      }
    } else if (forceWasm) {
      log('[INF] WASM mode (WebGPU failed on previous attempt)');
    }
    log('[INF] Using: ' + useDevice + ' / ' + useDtype);

    log('[INF] env.backends.onnx.wasm.wasmPaths=' + env.backends.onnx.wasm.wasmPaths);
    log('[INF] Loading processor (device=' + useDevice + ' dtype=' + useDtype + ')...');
    await updateStatus({ status: 'loading', progress: 20 });

    try {
      log('[INF] Step 1: AutoProcessor.from_pretrained...');
      processor = await AutoProcessor.from_pretrained(PROCESSOR_ID);
      log('[INF] Step 1 done');
    } catch (e) {
      log('[INF] Step 1 FAILED: ' + e.message + '\n' + (e.stack || ''));
      throw e;
    }

    try {
      log('[INF] Step 2: AutoModelForVision2Seq.from_pretrained (device=' + useDevice + ' dtype=' + useDtype + ')...');
      model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
        dtype: useDtype,
        device: useDevice,
      });
      log('[INF] Step 2 done');
    } catch (e) {
      log('[INF] Step 2 FAILED: ' + e.message + '\n' + (e.stack || ''));
      if (useDevice === 'webgpu') {
        log('[INF] WebGPU model load failed — retrying with WASM q8 (no page reload)...');
        useDevice = 'wasm'; useDtype = 'q8';
        try {
          log('[INF] Step 2 retry: WASM q8...');
          model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' });
          log('[INF] Step 2 retry done');
        } catch (e2) {
          log('[INF] Step 2 retry FAILED: ' + e2.message);
          throw e2;
        }
      } else {
        throw e;
      }
    }

    try {
      log('[INF] Step 3: initOCR...');
      await initOCR();
      log('[INF] Step 3 done');
    } catch (e) {
      log('[INF] Step 3 FAILED (OCR): ' + e.message);
      // OCR is optional — continue without it
    }

    device = useDevice;
    log('[INF] ✅ SmolVLM loaded (' + device + ' ' + useDtype + ')');

    isLoaded = true;
    const loadTime = Math.round(performance.now() - start);
    await updateStatus({ status: 'ready', progress: 100, loadTime });
    log('[INF] All models ready in ' + loadTime + 'ms');
    setStatus('Ready (' + device + ') — ' + loadTime + 'ms', 'ready');

    processQueue();

  } catch (err) {
    log('[INF] Fatal load error: ' + err.message + '\n' + (err.stack || ''));
    setStatus('Error: ' + err.message, 'error');
    await updateStatus({ status: 'error', message: err.message });
  }
}

// ============================================================
// GENERATE CAPTIONS (batched SmolVLM)
// ============================================================

const CAPTION_TIMEOUT_MS = 300000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout after ' + ms + 'ms')), ms); })
  ]).finally(() => clearTimeout(timer));
}

const CAPTION_PROMPT_TEXT = 'These frames are ordered left to right over time. Describe these frames in a short, simple sentence (max 10 words), similar to: \'a man walks across the room\'. Use plain language and do not add extra commentary.';

// SmolVLM/Idefics3 hardcoded format — used when tokenizer.chat_template is missing from fine-tuned repo
const SMOLVLM_TEMPLATE_FALLBACK = '<|im_start|>User:<image>' + CAPTION_PROMPT_TEXT + '<end_of_utterance>\nAssistant:';

let captionTemplate = null;

function getCaptionTemplate() {
  if (!captionTemplate) {
    try {
      captionTemplate = processor.apply_chat_template([{
        role: 'user',
        content: [{ type: 'image' }, { type: 'text', text: CAPTION_PROMPT_TEXT }],
      }], { add_generation_prompt: true });
      log('[INF] apply_chat_template succeeded');
    } catch (e) {
      log('[INF] apply_chat_template failed (' + e.message.slice(0, 60) + '), using hardcoded SmolVLM template');
      captionTemplate = SMOLVLM_TEMPLATE_FALLBACK;
    }
  }
  return captionTemplate;
}

async function generateCaptionBatch(imageDataArray) {
  const t0 = performance.now();
  const texts = imageDataArray.map(() => getCaptionTemplate());
  const images = await Promise.all(imageDataArray.map(d => load_image(d)));
  const t1 = performance.now();

  const inputs = await processor(texts, images, { padding: true });
  const t2 = performance.now();

  // Log tensor shapes so we know how many visual tokens are produced
  const pvShape = inputs.pixel_values?.dims ?? inputs.pixel_values?.shape ?? 'unknown';
  const idsShape = inputs.input_ids?.dims ?? inputs.input_ids?.shape ?? 'unknown';
  log('[INF] load_image=' + Math.round(t1-t0) + 'ms  processor=' + Math.round(t2-t1) + 'ms');
  log('[INF] pixel_values shape=' + JSON.stringify(pvShape) + '  input_ids shape=' + JSON.stringify(idsShape));

  log('[INF] Running generate (' + imageDataArray.length + ' items)...');
  const genStart = performance.now();
  const output = await model.generate({
    ...inputs,
    do_sample: false,
    max_new_tokens: 20,
    repetition_penalty: 1.3,
  });
  const genTime = Math.round(performance.now() - genStart);
  log('[INF] generate=' + genTime + 'ms  total=' + Math.round(performance.now()-t0) + 'ms');

  return processor.batch_decode(output, { skip_special_tokens: true }).map(fullText => {
    const idx = fullText.lastIndexOf('Assistant:');
    return (idx >= 0 ? fullText.slice(idx + 10) : fullText)
      .trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
  });
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
          // WebGPU JSEP doesn't support concurrent ONNX sessions — batch=1 only.
        // WASM can safely batch.
        const batchSize = Math.min(device === 'webgpu' ? 1 : BATCH_SIZE, queue.length);
          const batch = queue.splice(0, batchSize);
          await setStorage({ captionQueue: queue });

          // Kick off OCR for current batch + all remaining queue items immediately.
          // Tesseract runs in its own worker thread — no ONNX session conflict.
          for (const item of [...batch, ...queue]) precomputeOcr(item);

          log('[INF] Processing batch of ' + batchSize + ' (' + queue.length + ' left)');
          isGenerating = true;
          const batchStart = performance.now();

          try {
            // SmolVLM (WebGPU) and Tesseract OCR run simultaneously.
            const [captions, ocrTexts] = await withTimeout(
              Promise.all([
                generateCaptionBatch(batch.map(item => item.imageData)),
                Promise.all(batch.map(item => precomputeOcr(item))),
              ]),
              CAPTION_TIMEOUT_MS
            );

            const results = data.captionResults || {};
            for (let i = 0; i < batch.length; i++) {
              const item = batch[i];
              ocrCache.delete(item.gifId);
              let finalCaption = captions[i];
              if (ocrTexts[i] && ocrTexts[i].length > 3) finalCaption += '. Text: ' + ocrTexts[i];
              finalCaption = finalCaption.replace(/\s+/g, ' ').trim();
              results[item.gifId] = { caption: finalCaption, ocrText: ocrTexts[i], time: 0 };
              captionCount++;
              log('[INF] ✓ [' + captionCount + '] "' + finalCaption + '"');
            }

            const batchTime = Math.round(performance.now() - batchStart);
            log('[INF] Batch done in ' + batchTime + 'ms');
            await setStorage({ captionResults: results });
            await updateStatus({ captionCount });
            consecutiveErrors = 0;

          } catch (err) {
            log('[INF] Batch failed: ' + err.message);
            consecutiveErrors++;
            if (consecutiveErrors < 3) {
              const currentData = await getStorage('captionQueue');
              const currentQueue = currentData.captionQueue || [];
              currentQueue.unshift(...batch);
              await setStorage({ captionQueue: currentQueue });
            } else {
              log('[INF] Dropping batch (' + batch.map(b => b.gifId).join(', ') + ')');
              for (const item of batch) ocrCache.delete(item.gifId);
            }
          } finally {
            isGenerating = false;
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

// Reload the inference page when the user switches models from the test bench.
// Reloading the page is the only reliable way to fully dispose WebGPU/ONNX sessions.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.selectedModelId) {
    const newId = changes.selectedModelId.newValue;
    if (newId && newId !== MODEL_ID) {
      log('[INF] Model switch detected: ' + newId + ' — reloading page...');
      location.reload();
    }
  }
});

loadModel();
