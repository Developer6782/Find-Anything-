import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev/prod server is a single Express process (server/index.ts) that mounts Vite
// in middleware mode. Everything is served from ONE origin so the browser only ever
// talks to relative URLs (/api/*) — no CORS problems, no key in a URL.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5180,
    strictPort: false,
    // The sandbox/preview and tunnel hosts are dynamic, so accept them.
    allowedHosts: true,
    cors: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
  },
});
