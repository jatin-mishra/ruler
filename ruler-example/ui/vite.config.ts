import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev` on :5173 proxies the API to the running ruler-example (:9090).
// Build: `npm run build` → dist/, which ruler-example copies into static/ (served at http://localhost:9090/).
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { proxy: { '/ruler': 'http://localhost:9090' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
