import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const devPort = Number(process.env.VITE_DEV_PORT ?? 5173);
const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8787';
const devOrigin = `http://127.0.0.1:${devPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: devPort, strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            // Wrangler uses its listening origin. Translate only our exact dev origin.
            if (request.headers.origin === devOrigin) {
              proxyRequest.setHeader('origin', apiTarget);
            }
          });
        },
      },
    },
  },
  build: { outDir: 'dist' },
});
