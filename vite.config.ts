import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const config = {
  base: './',
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    fs: { deny: ['.materials/**', '.venv/**'] },
    watch: { ignored: ['**/.materials/**', '**/.venv/**'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
}

export default defineConfig(config)
