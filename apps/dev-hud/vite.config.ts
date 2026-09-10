import { defineConfig } from 'vite';

export default defineConfig({
  // The Even app loads this over the LAN from the phone, so bind all interfaces.
  server: { host: '0.0.0.0', port: 5175, strictPort: true },
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
