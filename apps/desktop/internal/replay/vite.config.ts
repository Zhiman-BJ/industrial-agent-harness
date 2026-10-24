import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  publicDir: path.resolve(import.meta.dirname, '../../public'),
  base: './',
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: path.join(import.meta.dirname, 'dist'), emptyOutDir: true },
});
