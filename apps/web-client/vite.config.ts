/**
 * Browser build.
 *
 * Source maps are OFF for the production build: the static handler refuses to
 * serve `.map` files anyway, and shipping them would put source in the release
 * artifact for no operational gain.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { duefoldBrowserEntries } from './build/browser-entries-plugin.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), duefoldBrowserEntries(repoRoot)],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // A predictable asset prefix lets the static handler distinguish a genuine
    // 404 on a build asset from a client-side route.
    assetsDir: 'assets',
  },
  server: {
    proxy: {
      '/api': {
        target: process.env['DUEFOLD_API_TARGET'] ?? 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
});
