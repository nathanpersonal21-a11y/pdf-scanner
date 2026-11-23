import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'opencv.js'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 25 * 1024 * 1024,
        navigateFallback: 'index.html',
        globIgnores: ['ocr/**'],
        // OCR engine (~7 MB) is cached the first time it is used, then works offline
        runtimeCaching: [
          { urlPattern: ({ url }) => url.pathname.includes('/ocr/'), handler: 'CacheFirst', options: { cacheName: 'ocr-engine', expiration: { maxEntries: 8 }, cacheableResponse: { statuses: [0, 200] } } },
        ],
      },
      manifest: {
        name: 'DocScan',
        short_name: 'DocScan',
        description: 'Scan documents to PDF. Everything stays on your device.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f5f5f7',
        theme_color: '#f5f5f7',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: { chunkSizeWarningLimit: 1500 },
});
