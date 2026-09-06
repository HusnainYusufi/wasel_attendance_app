import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * The dev server proxies `/api` to the local NestJS instance so a browser
 * session can run without CORS preflight noise. On a device the app is served
 * from `capacitor://localhost`, where no proxy exists — hence VITE_API_BASE_URL
 * must be an absolute origin for any real build.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '');
  const apiTarget = env.VITE_DEV_API_PROXY_TARGET || 'http://localhost:3000';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      host: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
    preview: { port: 4173, strictPort: true },
    build: {
      // Capacitor serves from a file-backed origin; relative asset URLs keep the
      // bundle working there as well as under a web sub-path.
      outDir: 'dist',
      sourcemap: true,
      target: 'es2022',
      rollupOptions: {
        output: {
          // Framework code changes far less often than app code; pinning it to
          // its own chunk keeps it cached across deploys instead of being
          // re-downloaded whenever a screen changes.
          manualChunks: (id: string) => {
            if (!id.includes('node_modules')) return undefined;
            if (
              /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
                id,
              )
            ) {
              return 'framework';
            }
            if (id.includes('@tanstack')) return 'query';
            return undefined;
          },
        },
      },
    },
  };
});
