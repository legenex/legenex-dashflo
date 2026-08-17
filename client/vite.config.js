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
    // Source maps stay off in production. They would roughly double what is
    // published and hand a reader the unminified application.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Route-level splitting alone would copy these into many route chunks
        // or leave them in the entry. Pinning the large, stable dependencies to
        // their own files means a page visit downloads only what it adds, and a
        // release that touches application code does not invalidate the vendor
        // bytes a returning user already has.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // These tiny helpers are used by the entry and by recharts alike.
          // Left unassigned, Rollup hoists them into vendor-charts, which makes
          // the entry statically depend on it: the browser then preloads 110 KB
          // of charting on the login screen to get a few hundred bytes of class
          // name helper. Pinning them to the always-needed chunk removes that
          // edge entirely.
          if (/[\\/]node_modules[\\/](clsx|tailwind-merge|class-variance-authority)[\\/]/.test(id)) return 'vendor-react';
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-') || id.includes('node_modules/victory-vendor')) return 'vendor-charts';
          if (id.includes('node_modules/framer-motion')) return 'vendor-motion';
          if (id.includes('node_modules/@radix-ui')) return 'vendor-radix';
          if (id.includes('node_modules/html2canvas')) return 'vendor-canvas';
          return undefined;
        },
      },
    },
  },
});
