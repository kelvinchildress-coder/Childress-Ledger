import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icon-192.png", "icon-512.png", "icon-512-maskable.png"],
      manifest: {
        name: "The Family Ledger",
        short_name: "Ledger",
        description: "Shared household task ledger for the whole family.",
        theme_color: "#FAF7F2",
        background_color: "#FAF7F2",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon-192.png",          sizes: "192x192", type: "image/png", purpose: "any"      },
          { src: "/icon-512.png",          sizes: "512x512", type: "image/png", purpose: "any"      },
          { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "This Week", url: "/?view=dashboard", description: "What's on the ledger this week" },
          { name: "Add task",  url: "/?view=add",       description: "Add a new task" },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        importScripts: ["/sw-push.js"],
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) =>
              /^https:\/\/script\.google\.(?:com|usercontent\.com)\/.*/i.test(url.href) &&
              request.method === "GET",
            handler: "NetworkFirst",
            options: {
              cacheName: "sheets-api-cache",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url, request }) =>
              /^https:\/\/script\.google\.(?:com|usercontent\.com)\/.*/i.test(url.href) &&
              request.method === "POST",
            handler: "NetworkOnly",
            options: {
              backgroundSync: {
                name: "ledger-sync-queue",
                options: { maxRetentionTime: 24 * 60 },
              },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
