// Background service worker - handles storage proxy for offscreen document

console.log('[BG] Background started');

async function setupOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  
  if (contexts.length > 0) {
    console.log('[BG] Offscreen exists');
    return;
  }
  
  console.log('[BG] Creating offscreen...');
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'ML model for GIF captioning'
  });
  console.log('[BG] Offscreen created');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[BG] Message:', msg.type);
  
  if (msg.type === 'loadModel') {
    // If model fell back to WASM, restart offscreen to retry WebGPU
    chrome.storage.local.get('modelStatus', async (data) => {
      const status = data.modelStatus || {};
      if (status.device === 'wasm' && status.status === 'ready') {
        console.log('[BG] Model on WASM, restarting offscreen for WebGPU...');
        try {
          await chrome.offscreen.closeDocument();
        } catch (e) {}
        resetStorage();
      }
      await setupOffscreenDocument();
      setTimeout(() => {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'loadModel' });
      }, 500);
    });
    sendResponse({ success: true });
    return true;
  }
  
  if (msg.type === 'STORAGE_GET') {
    chrome.storage.local.get(msg.keys, (data) => {
      sendResponse({ success: true, data });
    });
    return true;
  }
  
  if (msg.type === 'STORAGE_SET') {
    chrome.storage.local.set(msg.data, () => {
      sendResponse({ success: true });
    });
    return true;
  }
  
  if (msg.type === 'keepAlive') {
    sendResponse({ alive: true });
    return true;
  }
});

function resetStorage() {
  chrome.storage.local.set({
    modelStatus: { status: 'idle', progress: 0, captionCount: 0 },
    captionQueue: [],
    captionResults: {}
  });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[BG] Installed — clearing storage');
  resetStorage();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[BG] Browser started — clearing stale queue');
  resetStorage();
});