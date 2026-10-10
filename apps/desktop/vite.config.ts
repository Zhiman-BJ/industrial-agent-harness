import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  plugins: [react()],
  base: './',
  // The renderer imports this CJS subpath by name (App.tsx). Without
  // pre-bundling, Vite's dev-time named-export interop fails on the .cjs file
  // and the whole app white-screens; `vite build` is unaffected.
  optimizeDeps: {
    include: ['@industrial-agent-harness/viewer-core/result-preview'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: [path.resolve(import.meta.dirname, '../..')] },
  },
});
