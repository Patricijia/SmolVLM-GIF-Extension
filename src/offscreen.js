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
      langPath: chrome.runtime.getURL('tesseract/lang-data'),
      corePath: chrome.runtime.getURL('tesseract/tesseract-core.wasm.js'),
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

async function extractText(imageData) {
  if (!ocrWorker) return '';

  try {
    // Get actual image dimensions from the data URL
    const dims = await getImageDimensions(imageData);

    // Only OCR the bottom 30% of the image (where meme text usually is)
    const result = await ocrWorker.recognize(imageData, {
      rectangle: {
        top: Math.floor(dims.height * 0.7),
        left: 0,
        width: dims.width,
        height: Math.floor(dims.height * 0.3)
      }
    });

    const text = result.data.text.trim();
    if (text.length > 3) {
      console.log('[OFF] OCR found: "' + text.substring(0, 50) + '"');
    }
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
    // Load both models in parallel
    const loadPromises = [];
    
    // 1. Load captioning model (GPU)
    if (useWebGPU) {
      console.log('[OFF] Loading captioner with WebGPU...');
      loadPromises.push(
        pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning', {
          device: 'webgpu',
          dtype: 'fp32',
        }).then(model => {
          captioner = model;
          device = 'webgpu';
          console.log('[OFF] ✅ Captioner loaded (WebGPU)');
        }).catch(e => {
          console.log('[OFF] WebGPU captioner failed:', e.message);
          return pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning').then(model => {
            captioner = model;
            device = 'wasm';
            console.log('[OFF] ✅ Captioner loaded (WASM fallback)');
          });
        })
      );
    } else {
      loadPromises.push(
        pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning').then(model => {
          captioner = model;
          device = 'wasm';
          console.log('[OFF] ✅ Captioner loaded (WASM)');
        })
      );
    }
    
    // 2. Load OCR worker (CPU) - in parallel
    loadPromises.push(initOCR());
    
    // Wait for both
    await Promise.all(loadPromises);
    
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

async function generateCaptionWithOCR(imageData) {
  if (!isLoaded || !captioner) return { error: 'Not loaded' };
  if (isGenerating) return { error: 'Busy' };
  
  isGenerating = true;
  const start = performance.now();
  
  try {
    // Run BOTH in parallel:
    // - Captioning on GPU (WebGPU)
    // - OCR on CPU (WASM)
    const [captionResult, ocrText] = await Promise.all([
      // Caption generation (GPU)
      captioner(imageData, { max_new_tokens: 20 }),
      // OCR text extraction (CPU) - runs simultaneously!
      ocrWorker ? extractText(imageData) : Promise.resolve('')
    ]);
    
    let caption = captionResult[0].generated_text.trim();
    
    // Combine caption with OCR text if found
    if (ocrText && ocrText.length > 3) {
      caption = caption + ' [Text: "' + ocrText + '"]';
    }
    
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
    
    if (consecutiveErrors >= 3 && device === 'webgpu') {
      await recoverWithWasm();
    }
    
    return { error: err.message };
  }
}

// Legacy function for backward compatibility
async function generateCaption(imageData) {
  return generateCaptionWithOCR(imageData);
}

// ============================================================
// RECOVERY
// ============================================================

async function recoverWithWasm() {
  console.log('[OFF] Recovering with WASM...');
  
  captioner = null;
  isLoaded = false;
  consecutiveErrors = 0;
  
  try {
    captioner = await pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning');
    device = 'wasm';
    isLoaded = true;
    await updateStatus({ status: 'ready', device: 'wasm' });
    console.log('[OFF] ✅ Recovered with WASM');
  } catch (e) {
    console.error('[OFF] Recovery failed:', e.message);
    await updateStatus({ status: 'error', message: 'Recovery failed' });
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
  
  while (true) {
    try {
      if (!isGenerating && isLoaded) {
        const data = await getStorage(['captionQueue', 'captionResults']);
        const queue = data.captionQueue || [];
        
        if (queue.length > 0) {
          const item = queue.shift();
          await setStorage({ captionQueue: queue });
          
          console.log('[OFF] Processing: ' + item.gifId + ' (' + queue.length + ' left)');
          
          const result = await generateCaptionWithOCR(item.imageData);
          
          if (!result.error) {
            const results = data.captionResults || {};
            results[item.gifId] = result;
            await setStorage({ captionResults: results });
          } else if (consecutiveErrors < 3) {
            // Re-queue on error
            const currentData = await getStorage('captionQueue');
            const currentQueue = currentData.captionQueue || [];
            currentQueue.push(item);
            await setStorage({ captionQueue: currentQueue });
          }
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