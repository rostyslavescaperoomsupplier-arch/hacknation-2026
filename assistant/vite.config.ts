import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // the mascot lives in ../mewka: one copy of react / three for both packages
  resolve: { dedupe: ['react', 'react-dom', 'three'] },
  server: {
    fs: { allow: ['..'] },
    // ASSISTANT_API=https://jantar.byst.re npx vite  -> use the shared server (no local API key needed)
    proxy: {
      '/api': { target: process.env.ASSISTANT_API || 'http://127.0.0.1:8787', changeOrigin: true, ws: true },
      '/crew-video-ws': { target: (process.env.ASSISTANT_API || 'http://127.0.0.1:8787').replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
});
