import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev (`pnpm --filter @qbee/spa dev`), forward /api/* to the standalone worker.
// QBEE_WORKER_PORT matches the worker's default. In the editor, the spaProxyService
// handles the same routing, so this only matters for `vite dev`.
const workerPort = process.env.QBEE_WORKER_PORT ?? '8421'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${workerPort}`,
        changeOrigin: false,
        ws: false,
      },
    },
  },
})
