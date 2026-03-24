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
  const inferenceUrl = chrome.runtime.getURL('inference.html');

  // Check if tab still exists and is actually showing inference.html (not a crash/error page)
  if (inferenceTabId) {
    try {
      const tab = await chrome.tabs.get(inferenceTabId);
      if (tab.url && tab.url.startsWith(inferenceUrl)) {
        return;
      }
      // Tab exists but shows error page — close it and reopen
      console.log('[BG] Inference tab crashed (' + tab.url + '), reopening...');
      await chrome.tabs.remove(inferenceTabId).catch(() => {});
      inferenceTabId = null;
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

async function closeAllInferenceTabs() {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('inference.html') });
  for (const tab of tabs) {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
  inferenceTabId = null;
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[BG] Installed — clearing storage & opening inference tab');
  await closeAllInferenceTabs();
  resetStorage();
  ensureInferenceTab();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[BG] Browser started — clearing stale queue & opening inference tab');
  await closeAllInferenceTabs();
  resetStorage();
  ensureInferenceTab();
});
