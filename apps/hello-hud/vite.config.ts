import { defineConfig } from 'vite';

export default defineConfig({
  // The Even app loads this page over the LAN from your phone, so dev must bind
  // to all interfaces rather than localhost.
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  // `evenhub pack` takes a built folder and app.json; relative asset paths keep
  // the bundle loadable from the packaged entrypoint.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
