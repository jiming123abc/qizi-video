import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      outDir: 'dist',
    },
    server: {
      port: 3002,
      host: '0.0.0.0',
      open: '/',
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        '/api': {
          target: env.VITE_API_BASE_URL || 'http://localhost:3001',
          changeOrigin: true,
          configure: (proxy, _options) => {
            proxy.on('error', (err, _req, _res) => {
              console.log('proxy error', err);
            });
            proxy.on('proxyReq', (proxyReq, req, _res) => {
              req.setTimeout(180000);
              proxyReq.setTimeout(180000);
            });
          },
          timeout: 180000,
          proxyTimeout: 180000,
        },
        '/uploads': {
          target: env.VITE_API_BASE_URL || 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
