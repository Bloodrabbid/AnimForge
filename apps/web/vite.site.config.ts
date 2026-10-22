import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Сайт (GitHub Pages): страница — как у dev-сервера, но с VITE_AF_WEB=1 и относительными путями (сайт живёт в подпапке).
// Service Worker собирает vite.sw.config.ts, данные кладёт build-site.ts.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  define: { "import.meta.env.VITE_AF_WEB": JSON.stringify("1") },
  build: { outDir: "../../out/site", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
