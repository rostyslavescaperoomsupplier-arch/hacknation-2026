import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // the mascot lives in ../mewka: one copy of react / three for both packages
  resolve: { dedupe: ['react', 'react-dom', 'three'] },
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://localhost:8787' },
  },
});
