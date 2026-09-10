import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.API_TARGET || 'http://localhost:8080';

export default defineConfig({
  // Project pages live under /<repo>/, so the base path is configurable.
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
});
