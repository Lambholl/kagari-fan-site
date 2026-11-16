import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: false,
    fs: { deny: ['.materials/**', '.venv/**'] },
    watch: { ignored: ['**/.materials/**', '**/.venv/**'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
