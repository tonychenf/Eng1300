import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 构建产物直接输出到 worker 的静态资源目录，由 Worker 一并托管
  build: { outDir: '../worker/public', emptyOutDir: true },
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
});
