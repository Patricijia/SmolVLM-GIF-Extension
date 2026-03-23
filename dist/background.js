// Background service worker - opens inference tab for WebGPU-accelerated SmolVLM

console.log('[BG] Background started');

let inferenceTabId = null;

async function findInferenceTab() {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('inference.html') });
  if (tabs.length > 0) {
    inferenceTabId = tabs[0].id;
    return true;
  }
  return false;
}

async function ensureInferenceTab() {
  // Check if tab still exists
  if (inferenceTabId) {
    try {
      await chrome.tabs.get(inferenceTabId);
      return;
    } catch (e) {
      inferenceTabId = null;
    }
  }

  // Check if already open
  if (await findInferenceTab()) {
    console.log('[BG] Inference tab found');
    return;
  }

  // Open new tab
  console.log('[BG] Opening inference tab...');
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL('inference.html'),
    active: false,  // Open in background
    pinned: true,
  });
  inferenceTabId = tab.id;
  console.log('[BG] Inference tab opened (id=' + tab.id + ')');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[BG] Message:', msg.type);

  if (msg.type === 'loadModel') {
    ensureInferenceTab().then(() => {
      // The inference page auto-loads the model on open
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
  console.log('[BG] Installed — clearing storage & opening inference tab');
  resetStorage();
  ensureInferenceTab();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[BG] Browser started — clearing stale queue & opening inference tab');
  resetStorage();
  ensureInferenceTab();
});
