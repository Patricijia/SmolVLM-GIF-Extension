import {
  AutoProcessor,
  AutoModelForVision2Seq,
  load_image,
  env,
} from '@huggingface/transformers';

// Use local WASM files instead of CDN (blocked by extension CSP)
env.backends.onnx.wasm.wasmPaths = self.location.href.replace(/vlm-worker\.js$/, 'wasm/');
env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';

let processor = null;
let model = null;

async function loadModel() {
  self.postMessage({ type: 'status', status: 'loading' });

  processor = await AutoProcessor.from_pretrained(MODEL_ID);

  // Try WebGPU first, fall back to WASM
  // Try WebGPU first (works in regular extension pages, not offscreen docs)
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) {
      console.log('[VLM Worker] WebGPU adapter found, loading with fp32...');
      model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
        dtype: 'fp32',
        device: 'webgpu',
      });
      console.log('[VLM Worker] ✅ Model loaded (WebGPU fp32)');
      self.postMessage({ type: 'status', status: 'ready', device: 'webgpu' });
      return;
    }
  } catch (e) {
    console.log('[VLM Worker] WebGPU failed:', e.message, '— falling back to WASM');
  }

  // Fallback to WASM q4
  console.log('[VLM Worker] Loading SmolVLM with WASM (q4)...');
  model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
    dtype: 'q4',
    device: 'wasm',
  });
  console.log('[VLM Worker] ✅ Model loaded (WASM q4)');
  self.postMessage({ type: 'status', status: 'ready', device: 'wasm' });
}

async function generate(imageData) {
  if (!processor || !model) {
    self.postMessage({ type: 'result', error: 'Model not loaded' });
    return;
  }

  try {
    console.log('[VLM Worker] Starting generation...');

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image' },
          { type: 'text', text: 'Describe this GIF briefly.' },
        ],
      },
    ];

    const text = processor.apply_chat_template(messages, {
      add_generation_prompt: true,
    });

    console.log('[VLM Worker] Loading image...');
    const image = await load_image(imageData);

    console.log('[VLM Worker] Processing inputs...');
    const inputs = await processor(text, [image]);

    console.log('[VLM Worker] Running model.generate...');
    const output = await model.generate({
      ...inputs,
      do_sample: false,
      max_new_tokens: 20,
      repetition_penalty: 1.1,
    });

    console.log('[VLM Worker] Decoding output...');
    // Decode the full output, skip special tokens
    const decoded = processor.batch_decode(output, {
      skip_special_tokens: true,
    });

    // The decoded text includes the prompt, extract just the response
    const fullText = decoded[0] || '';
    // SmolVLM chat format: prompt ends with "Assistant:", response follows
    const assistantIdx = fullText.lastIndexOf('Assistant:');
    const caption = (assistantIdx >= 0 ? fullText.slice(assistantIdx + 10) : fullText)
      .trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');

    console.log('[VLM Worker] Caption: "' + caption + '"');
    self.postMessage({ type: 'result', caption });
  } catch (e) {
    console.error('[VLM Worker] Generate error:', e);
    self.postMessage({ type: 'result', error: e.message });
  }
}

self.addEventListener('message', async (e) => {
  const { type, data } = e.data;
  switch (type) {
    case 'load':
      await loadModel();
      break;
    case 'generate':
      await generate(data.imageData);
      break;
  }
});
