import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

mkdirSync('dist/wasm', { recursive: true });
mkdirSync('dist/tesseract', { recursive: true });

// Copy WASM files
const srcDir = join(__dirname, 'node_modules/@huggingface/transformers/dist');
const destDir = join(__dirname, 'dist/wasm');

if (existsSync(srcDir)) {
  for (const file of readdirSync(srcDir)) {
    if (file.endsWith('.wasm') || file.endsWith('.mjs')) {
      copyFileSync(join(srcDir, file), join(destDir, file));
      console.log('Copied:', file);
    }
  }
}

// Copy Tesseract.js core WASM files
const tessSrcDir = join(__dirname, 'node_modules/tesseract.js-core');
const tessDestDir = join(__dirname, 'dist/tesseract');

if (existsSync(tessSrcDir)) {
  for (const file of readdirSync(tessSrcDir)) {
    if (file.startsWith('tesseract-core') && (file.endsWith('.wasm') || file.endsWith('.wasm.js'))) {
      copyFileSync(join(tessSrcDir, file), join(tessDestDir, file));
      console.log('Copied tesseract:', file);
    }
  }
}

// Copy Tesseract.js worker
const tessWorkerPath = join(__dirname, 'node_modules/tesseract.js/dist/worker.min.js');
if (existsSync(tessWorkerPath)) {
  copyFileSync(tessWorkerPath, join(tessDestDir, 'worker.min.js'));
  console.log('Copied tesseract: worker.min.js');
}

// Bundle offscreen.js
await esbuild.build({
  entryPoints: ['src/offscreen.js'],
  bundle: true,
  outfile: 'dist/offscreen.js',
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: false,
});

// Bundle content.js
await esbuild.build({
  entryPoints: ['src/content.js'],
  bundle: true,
  outfile: 'dist/content.js',
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: false,
});

console.log('✅ Build complete!');