import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `changeOrigin: false` keeps the Host header as `localhost:5173`, which
      // matches the browser's own Origin header. The manager compares the two
      // to reject cross-site requests; with the default `changeOrigin: true`
      // the proxy rewrites Host to the backend's address and every request -
      // including sign-in - is refused as a foreign origin.
      '/api': { target: 'http://127.0.0.1:7860', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
