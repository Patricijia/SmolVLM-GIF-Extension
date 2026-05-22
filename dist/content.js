(() => {
  // src/content.js
  var PAGE_START = performance.now();
  console.log("[GIF] SmolVLM GIF Accessibility Reader running...");
  var OCR_ENABLED = new URLSearchParams(window.location.search).get("ocr") !== "off";
  console.log("[GIF] OCR " + (OCR_ENABLED ? "enabled" : "disabled"));
  var BENCHMARK_TOTAL_RUNS = parseInt(new URLSearchParams(window.location.search).get("runs") || "51", 10);
  var BENCHMARK_DELAY_MS = 1e4;
  var RUN_KEY = "benchmarkRun-ocr-" + (OCR_ENABLED ? "on" : "off");
  var seen = /* @__PURE__ */ new Set();
  var retryCount = /* @__PURE__ */ new Map();
  var MAX_RETRIES = 10;
  var labelsApplied = 0;
  var totalGifs = 0;
  var allMetrics = [];
  function publishMetrics() {
    try {
      document.documentElement.dataset.gifMetrics = JSON.stringify(allMetrics);
    } catch {
    }
  }
  var firstModelLoadMs = null;
  var firstOcrLoadMs = null;
  async function labelGif(gif) {
    const url = gif.src;
    if (seen.has(url)) return;
    seen.add(url);
    const t0 = performance.now();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "DESCRIBE_GIF",
        url,
        ocr: OCR_ENABLED
      });
      if (response.error) throw new Error(response.error);
      const label = response.caption;
      const metrics = response.metrics;
      gif.alt = label;
      gif.setAttribute("aria-label", label);
      gif.setAttribute("role", "img");
      gif.setAttribute("tabindex", "0");
      const tag = document.createElement("span");
      tag.innerText = label;
      tag.style.cssText = "background: #00c9a7; color: black; font-size: 12px; padding: 2px 4px; position: absolute; z-index: 9999; border-radius: 4px; left: " + (gif.getBoundingClientRect().right + window.scrollX + 5) + "px; top: " + (gif.getBoundingClientRect().top + window.scrollY) + "px; max-width: 300px; display: inline-block;";
      document.body.appendChild(tag);
      retryCount.delete(url);
      labelsApplied++;
      if (metrics) {
        if (firstModelLoadMs === null) firstModelLoadMs = metrics.modelLoadMs;
        if (firstOcrLoadMs === null) firstOcrLoadMs = metrics.ocrLoadMs;
        allMetrics.push({
          gifIndex: labelsApplied,
          url: url.slice(0, 80),
          caption: label,
          ...metrics,
          wallClockMs: Math.round(performance.now() - t0),
          sincePageLoadMs: Math.round(performance.now() - PAGE_START)
        });
        publishMetrics();
      }
      const elapsed = (performance.now() - t0).toFixed(0);
      const sincePageLoad = (performance.now() - PAGE_START).toFixed(0);
      console.log(
        "[GIF] " + labelsApplied + "/" + totalGifs + " labeled in " + elapsed + "ms (" + sincePageLoad + 'ms since load) | "' + label + '"' + (metrics ? " | grid: " + metrics.frameExtractionMs + "ms, inference: " + metrics.totalInferenceMs + "ms, OCR: " + (metrics.ocrDetected ? '"' + metrics.ocrText + '"' : "none") : "")
      );
      if (labelsApplied === totalGifs) {
        printFinalSummary();
      }
    } catch (err) {
      const attempts = (retryCount.get(url) || 0) + 1;
      if (attempts < MAX_RETRIES) {
        retryCount.set(url, attempts);
        seen.delete(url);
        console.warn("[GIF] Failed (attempt " + attempts + "/" + MAX_RETRIES + "), retrying:", url, err);
        labelGif(gif);
      } else {
        retryCount.delete(url);
        console.error("[GIF] Failed: giving up after " + MAX_RETRIES + " attempts:", url, err);
      }
    }
  }
  function printFinalSummary() {
    const totalTime = Math.round(performance.now() - PAGE_START);
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const min = (arr) => arr.length ? Math.round(Math.min(...arr)) : 0;
    const max = (arr) => arr.length ? Math.round(Math.max(...arr)) : 0;
    const sum = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0)) : 0;
    const frameExtractionTimes = allMetrics.map((m) => m.frameExtractionMs);
    const inferenceTimes = allMetrics.map((m) => m.totalInferenceMs);
    const totalTimes = allMetrics.map((m) => m.totalMs);
    const wallClockTimes = allMetrics.map((m) => m.wallClockMs);
    const ocrCount = allMetrics.filter((m) => m.ocrDetected).length;
    console.log("\n");
    console.log("=".repeat(70));
    console.log("  GIF ACCESSIBILITY BENCHMARK RESULTS");
    console.log("=".repeat(70));
    console.log("  Model:              SmolVLM-256M (" + (allMetrics[0]?.device || "unknown") + ")");
    console.log("  OCR:                Tesseract.js");
    console.log("  Frames per GIF:     16 (4x4 grid)");
    console.log("  Total GIFs:         " + totalGifs);
    console.log("-".repeat(70));
    console.log("  LOADING");
    console.log("    Model load:       " + firstModelLoadMs + "ms");
    console.log("    OCR load:         " + firstOcrLoadMs + "ms");
    console.log("-".repeat(70));
    console.log("  PER-GIF METRICS (ms)          Avg      Min      Max    Total");
    console.log("    Grid construction:    " + String(avg(frameExtractionTimes)).padStart(8) + String(min(frameExtractionTimes)).padStart(9) + String(max(frameExtractionTimes)).padStart(9) + String(sum(frameExtractionTimes)).padStart(9));
    console.log("    Inference:            " + String(avg(inferenceTimes)).padStart(8) + String(min(inferenceTimes)).padStart(9) + String(max(inferenceTimes)).padStart(9) + String(sum(inferenceTimes)).padStart(9));
    console.log("    Pipeline (total):     " + String(avg(totalTimes)).padStart(8) + String(min(totalTimes)).padStart(9) + String(max(totalTimes)).padStart(9) + String(sum(totalTimes)).padStart(9));
    console.log("    Wall clock:           " + String(avg(wallClockTimes)).padStart(8) + String(min(wallClockTimes)).padStart(9) + String(max(wallClockTimes)).padStart(9) + String(sum(wallClockTimes)).padStart(9));
    console.log("-".repeat(70));
    console.log("  OCR");
    console.log("    GIFs with text:   " + ocrCount + "/" + totalGifs);
    console.log("-".repeat(70));
    console.log("  TOTALS");
    console.log("    Page load \u2192 all accessible: " + totalTime + "ms (" + (totalTime / 1e3).toFixed(1) + "s)");
    console.log("    First GIF accessible at:    " + (allMetrics[0]?.sincePageLoadMs || "N/A") + "ms");
    console.log("    Last GIF accessible at:     " + (allMetrics[allMetrics.length - 1]?.sincePageLoadMs || "N/A") + "ms");
    console.log("    Avg time per GIF:           " + avg(wallClockTimes) + "ms");
    console.log("=".repeat(70));
    console.log("\n  PER-GIF BREAKDOWN:");
    console.log("  #   Frames  Grid     Inference  OCR     Total   Since Load");
    for (const m of allMetrics) {
      console.log(
        "  " + String(m.gifIndex).padStart(2) + "  " + String(m.framesExtracted + "/" + m.totalGifFrames).padStart(7) + "  " + String(m.frameExtractionMs).padStart(7) + "  " + String(m.totalInferenceMs).padStart(9) + "  " + String(m.ocrDetected ? "yes" : "no").padStart(3) + "  " + String(m.totalMs).padStart(7) + "  " + String(m.sincePageLoadMs).padStart(10)
      );
    }
    console.log("=".repeat(70));
    saveMetrics(totalTime, ocrCount);
  }
  function saveMetrics(totalTime, ocrCount) {
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const report = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      pageUrl: window.location.href,
      config: {
        model: "Patricijia/smolvlm-tgif-gif-descriptor",
        baseModel: "HuggingFaceTB/SmolVLM-256M-Instruct",
        device: allMetrics[0]?.device || "unknown",
        framesPerGif: 16,
        gridSize: "4x4",
        ocr: "tesseract.js"
      },
      summary: {
        totalGifs,
        modelLoadMs: firstModelLoadMs,
        ocrLoadMs: firstOcrLoadMs,
        pageLoadToAllAccessibleMs: totalTime,
        firstGifAccessibleMs: allMetrics[0]?.sincePageLoadMs || null,
        lastGifAccessibleMs: allMetrics[allMetrics.length - 1]?.sincePageLoadMs || null,
        avgWallClockPerGifMs: avg(allMetrics.map((m) => m.wallClockMs)),
        avgFrameExtractionMs: avg(allMetrics.map((m) => m.frameExtractionMs)),
        avgInferenceMs: avg(allMetrics.map((m) => m.totalInferenceMs)),
        gifsWithOcr: ocrCount
      },
      perGif: allMetrics
    };
    chrome.runtime.sendMessage({ type: "SAVE_METRICS", format: "json", ocrEnabled: OCR_ENABLED, data: JSON.stringify(report, null, 2) });
    const csvHeader = [
      "gif_index",
      "url",
      "total_gif_frames",
      "frames_extracted",
      "frame_extraction_ms",
      "total_inference_ms",
      "ocr_detected",
      "ocr_text",
      "total_pipeline_ms",
      "wall_clock_ms",
      "since_page_load_ms",
      "model_load_ms",
      "ocr_load_ms",
      "caption"
    ].join(",");
    const csvRows = allMetrics.map((m) => [
      m.gifIndex,
      '"' + (m.url || "").replace(/"/g, '""') + '"',
      m.totalGifFrames,
      m.framesExtracted,
      m.frameExtractionMs,
      m.totalInferenceMs,
      m.ocrDetected ? 1 : 0,
      '"' + (m.ocrText || "").replace(/"/g, '""') + '"',
      m.totalMs,
      m.wallClockMs,
      m.sincePageLoadMs,
      m.gifIndex === 1 ? firstModelLoadMs : 0,
      m.gifIndex === 1 ? firstOcrLoadMs : 0,
      '"' + (m.caption || "").replace(/"/g, '""') + '"'
    ].join(","));
    chrome.runtime.sendMessage({ type: "SAVE_METRICS", format: "csv", ocrEnabled: OCR_ENABLED, data: [csvHeader, ...csvRows].join("\n") });
    console.log("[GIF] Benchmark metrics saved to ~/Downloads/gif-benchmarks/");
    const runCount = parseInt(sessionStorage.getItem(RUN_KEY) || "0", 10) + 1;
    sessionStorage.setItem(RUN_KEY, String(runCount));
    console.log(`[GIF] Completed run ${runCount}/${BENCHMARK_TOTAL_RUNS} (OCR ${OCR_ENABLED ? "on" : "off"})`);
    if (runCount < BENCHMARK_TOTAL_RUNS) {
      console.log(`[GIF] Refreshing in ${BENCHMARK_DELAY_MS / 1e3}s for next run...`);
      setTimeout(() => location.reload(), BENCHMARK_DELAY_MS);
    } else {
      console.log(`[GIF] All benchmark runs complete! Run sessionStorage.removeItem('${RUN_KEY}') to reset.`);
      sessionStorage.removeItem(RUN_KEY);
    }
  }
  function isGif(img) {
    const src = img.src.toLowerCase();
    return src.endsWith(".gif") || src.includes("giphy") || src.includes("tenor");
  }
  function scanAndLabelGIFs() {
    const gifs = Array.from(document.querySelectorAll("img")).filter((img) => isGif(img) && !seen.has(img.src));
    if (gifs.length > 0) {
      totalGifs += gifs.length;
      console.log("[GIF] Found " + gifs.length + " new GIFs (" + totalGifs + " total)");
    }
    gifs.forEach(labelGif);
  }
  scanAndLabelGIFs();
  var observer = new MutationObserver(scanAndLabelGIFs);
  observer.observe(document.body, { childList: true, subtree: true });
})();
