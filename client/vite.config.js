import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4310',
        changeOrigin: true,
        // OG Main scrapes can exceed 30 minutes, so keep the proxy connection open much longer.
        timeout: 2 * 60 * 60 * 1000,
        proxyTimeout: 2 * 60 * 60 * 1000,
      },
    },
  },
});
