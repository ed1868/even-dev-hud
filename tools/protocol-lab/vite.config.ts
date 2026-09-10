import { defineConfig } from 'vite';

// Web Bluetooth requires a secure context. `localhost` counts as secure, so the
// lab is deliberately localhost-only — unlike the app, it is not exposed on the LAN.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { outDir: 'dist', target: 'es2022' },
});
