import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [
      react(),
      tailwindcss(),
      legacy({
        targets: ['chrome >= 50', 'android >= 5', 'ios >= 10', 'safari >= 10'],
        additionalLegacyPolyfills: ['regenerator-runtime/runtime'],
        modernPolyfills: ['es.array.flat', 'es.array.flat-map', 'es.object.from-entries'],
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      outDir: 'dist',
      target: 'es2020',
      cssTarget: 'chrome80',
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
