import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = path.resolve(rootDir, 'client/src');

// Canonical repository test runner. Tests live under client/src but exercise
// both client libraries and the self-hosted server/src/functions tree, so the
// runner is rooted at the repository rather than at client/.
//
// Some .js files in this project contain JSX (lib/ metric and badge helpers),
// which is why the esbuild loader is forced to jsx for source files. This
// mirrors the client vite.config.js react({ include: /\.(js|jsx|ts|tsx)$/ })
// behaviour without needing the React plugin at the repository root.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    loader: 'jsx',
    include: /\.[jt]sx?$/,
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: { jsx: 'automatic', loader: { '.js': 'jsx' } },
  },
  resolve: {
    alias: { '@': clientSrc },
  },
  test: {
    root: rootDir,
    environment: 'node',
    include: ['client/src/**/*.{test,spec}.{js,jsx}', 'server/test/**/*.{test,spec}.js'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Every test file runs behind the outbound network guard. Tests may only
    // reach loopback mock servers.
    setupFiles: [path.resolve(rootDir, 'vitest.setup.js')],
    reporters: ['default'],
  },
});
