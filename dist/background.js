// Service worker — manages offscreen document and routes messages.
// Same architecture as vit-gpt2 extension.

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'SmolVLM model inference with WebGPU',
  });
}

// Pre-create offscreen document so model starts loading immediately
ensureOffscreen();

// Separate run counters for OCR-on vs OCR-off so the runs don't interleave.
let runCounter = 0;
let runCounterNoOcr = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle benchmark file saving
  if (message.type === 'SAVE_METRICS') {
    const ocrOff = message.ocrEnabled === false;
    if (message.format === 'json') {
      if (ocrOff) runCounterNoOcr++; else runCounter++;
    }
    const id = ocrOff ? runCounterNoOcr : runCounter;
    const suffix = ocrOff ? '-no-ocr' : '';
    const mimeType = message.format === 'json' ? 'application/json' : 'text/csv';
    const dataUrl = 'data:' + mimeType + ';base64,' + btoa(unescape(encodeURIComponent(message.data)));
    const filename = 'smolvlm-base-benchmark' + suffix + '-run' + id + '.' + message.format;

    chrome.downloads.download({
      url: dataUrl,
      filename: 'gif-benchmarks/' + filename,
      conflictAction: 'overwrite',
      saveAs: false,
    }, () => {
      sendResponse({ ok: true, runId: id });
    });

    return true;
  }

  // Route DESCRIBE_GIF from content script → offscreen document
  if (message.type !== 'DESCRIBE_GIF') return;
  if (message.target === 'offscreen') return;

  console.log('[background] Forwarding DESCRIBE_GIF to offscreen');

  ensureOffscreen()
    .then(() =>
      chrome.runtime.sendMessage({ ...message, target: 'offscreen' })
    )
    .then((response) => {
      console.log('[background] Got response from offscreen:', response);
      sendResponse(response);
    })
    .catch((err) => {
      console.error('[background] Error:', err);
      sendResponse({ error: err.message });
    });

  return true;
});
