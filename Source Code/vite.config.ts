import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

  return {
    plugins: [react()],
    base: '/',
    build: {
      // Keep build output separate from `public/` static assets.
      outDir: 'dist',
      sourcemap: false
    },
    // ES-format workers so they can code-split (the xlsx parser worker
    // dynamic-imports the xlsx package, which IIFE workers cannot do).
    worker: {
      format: 'es' as const,
    },
    server: {
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      }
    }
  };
});
