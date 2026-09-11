import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '0.0.0.0', port: 5176, strictPort: true },
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
