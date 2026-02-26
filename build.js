import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

mkdirSync('dist/wasm', { recursive: true });

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