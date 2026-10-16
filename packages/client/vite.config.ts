import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: dir,
  base: './',
  resolve: {
    alias: { '@shared': path.resolve(dir, '../shared/src') },
  },
  build: {
    outDir: path.resolve(dir, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://127.0.0.1:3000', ws: true } },
  },
});
