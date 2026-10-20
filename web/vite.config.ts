import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt', // UpdateToast asks the user before swapping versions
      includeAssets: ['favicon.ico', 'favicon.svg', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png', 'icon.svg', 'icon-dark.svg', 'logo-light.svg', 'logo-dark.svg'],
      manifest: {
        name: 'PlanAsBuilt',
        short_name: 'PlanAsBuilt',
        description: 'Mark up plans and document devices in the field, online or off.',
        theme_color: '#0F3D6E',
        background_color: '#F4F8FC',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // App shell incl. the pdf.js worker (.mjs) and fonts
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // No runtime caching: API data lives in Dexie (auth + offline write semantics).
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    host: true, // reachable from phones/tablets on the LAN
    proxy: { '/api': { target: 'http://localhost:3001', ws: true } },
  },
})
