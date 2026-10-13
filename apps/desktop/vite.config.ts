import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  plugins: [react()],
  base: './',
  optimizeDeps: {
    // A cold dev cache serves the linked workspace CJS subpath as a native
    // ESM module, so the named import in App.tsx fails to load. Route it
    // through the esbuild interop instead of relying on a warm .vite/deps.
    include: ['@industrial-agent-harness/viewer-core/result-preview'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: [path.resolve(import.meta.dirname, '../..')] },
  },
});
