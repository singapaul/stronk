import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const api = "http://localhost:3000";

export default defineConfig({
  root: __dirname,
  plugins: [
    preact(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "stronk",
        short_name: "stronk",
        description: "Log your lifts against the targets Claude sets.",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Cache the app shell only. API calls always go to the network; offline writes use the outbox.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/, /^\/auth/, /^\/mcp/, /^\/docs/, /^\/openapi\.json/, /^\/health/],
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest,woff2}"],
      },
    }),
  ],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    port: 5173,
    proxy: { "/api": api, "/auth": api, "/mcp": api, "/docs": api, "/openapi.json": api },
  },
});
