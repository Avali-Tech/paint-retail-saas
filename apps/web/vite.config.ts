import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// The browser calls the API at /api/... on the web app's own origin (no CORS
// needed); this proxy forwards it to the API. Production puts the same rule in
// the CDN or load balancer. API_URL points it elsewhere (the e2e tests use it).
const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: process.env.API_URL ?? 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // registerServiceWorker() in src/pwa registers it, only in production builds.
      injectRegister: false,
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Paint Retail',
        short_name: 'Paint Retail',
        description: 'Stock, customers and orders for paint dealers.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        lang: 'en-IN',
        // The installed app's splash colours; inside the app the business's theme applies.
        theme_color: '#1d4ed8',
        background_color: '#f6f8fc',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The app shell is cached; every screen falls back to it offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        // API answers are never cached: stock and money must be live.
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: { port: 4173, strictPort: true, proxy: apiProxy },
  build: { target: 'es2022', sourcemap: true },
});
