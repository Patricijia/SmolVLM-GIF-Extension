import { pipeline, env } from '@huggingface/transformers';

env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/');
env.allowLocalModels = false;
env.useBrowserCache = true;

let captioner = null;
let isLoaded = false;
let captionCount = 0;
let isGenerating = false;
let device = 'unknown';
let consecutiveErrors = 0;

console.log('[OFF] ========== OFFSCREEN STARTED ==========');

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

async function loadModel() {
  if (isLoaded) return;
  
  console.log('[OFF] Loading model...');
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
      console.log('[OFF] Loading with WebGPU...');
      try {
        captioner = await pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning', {
          device: 'webgpu',
          dtype: 'fp32',
        });
        device = 'webgpu';
        console.log('[OFF] ✅ WebGPU loaded!');
      } catch (e) {
        console.log('[OFF] WebGPU failed:', e.message);
        useWebGPU = false;
      }
    }
    
    if (!captioner) {
      console.log('[OFF] Loading with WASM...');
      captioner = await pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning');
      device = 'wasm';
      console.log('[OFF] ✅ WASM loaded');
    }
    
    isLoaded = true;
    const loadTime = Math.round(performance.now() - start);
    await updateStatus({ status: 'ready', progress: 100, loadTime });
    console.log('[OFF] Model ready (' + device + ') in ' + loadTime + 'ms');
    
    processQueue();
    
  } catch (err) {
    console.error('[OFF] Load failed:', err);
    await updateStatus({ status: 'error', message: err.message });
  }
}

async function generateCaption(imageData) {
  if (!isLoaded || !captioner) return { error: 'Not loaded' };
  if (isGenerating) return { error: 'Busy' };
  
  isGenerating = true;
  const start = performance.now();
  
  try {
    const result = await captioner(imageData, {
      max_new_tokens: 20,
    });
    
    const caption = result[0].generated_text.trim();
    const time = Math.round(performance.now() - start);
    
    captionCount++;
    consecutiveErrors = 0;
    await updateStatus({ captionCount });
    
    console.log('[OFF] ✓ "' + caption + '" (' + time + 'ms)');
    
    isGenerating = false;
    return { caption, time };
    
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

async function processQueue() {
  console.log('[OFF] Queue processor started');
  
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
          
          const result = await generateCaption(item.imageData);
          
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
}

init();