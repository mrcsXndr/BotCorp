/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The build is committed (cockpit/web/dist) and served by cockpit/server.mjs as
// plain static files: update.ps1 -Apply runs no npm step on the live box.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // no inline polyfill script: the cockpit CSP is script-src 'self'
    modulePreload: { polyfill: false },
    assetsDir: 'assets',
    // one app chunk is fine here; the real budget is `npm run size` (450 KB gzip)
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  // `npm run preview` serves dist on the dev port with the cockpit's own CSP
  // (a copy of the CSP in cockpit/server.mjs), so a CSP break shows before the mount.
  preview: {
    port: 4478,
    strictPort: true,
    headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; connect-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    },
  },
  // tests read files beside the SPA (?raw): src/lib/parity.test.ts the classic
  // cockpit/public/*.js, src/api/queries.test.ts the routes in cockpit/server.mjs
  server: { fs: { allow: ['..'] } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
