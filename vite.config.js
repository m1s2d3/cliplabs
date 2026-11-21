import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = 'http://127.0.0.1:8000';
const proxy = { '/api': backend, '/media': backend };

// Gives every build its own service-worker cache so old assets are dropped on update.
const stampServiceWorker = () => ({
  name: 'stamp-service-worker',
  apply: 'build',
  closeBundle() {
    const file = resolve('dist/sw.js');
    writeFileSync(file, readFileSync(file, 'utf8').replace('__BUILD_ID__', Date.now().toString(36)));
  },
});

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
  server: { port: 4173, proxy },
  preview: { port: 4173, proxy },
});
