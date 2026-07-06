import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import path from 'node:path';

// Standalone Vite config. In dev, /api and /uploads are proxied to the backend
// (default http://localhost:4000). In production the backend serves the built
// dist/ directly, so these proxies are dev-only.
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:4000';

export default defineConfig({
  // Some .js files in this project contain JSX (lib/ metrics + badge helpers).
  // Have the React plugin (automatic runtime) transform .js too, and default
  // esbuild's JSX to the automatic runtime so nothing relies on a React global.
  plugins: [react({ include: /\.(js|jsx|ts|tsx)$/ })],
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { esbuildOptions: { jsx: 'automatic' } },
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/uploads': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
