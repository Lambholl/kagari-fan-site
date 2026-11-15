import { defineConfig } from 'vite';
import { sceneAssets } from './scripts/scene-assets.js';

export default defineConfig({
  base: './',
  plugins: [sceneAssets()],
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
