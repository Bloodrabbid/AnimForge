import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Service Worker сайта: ядро и CLI одним файлом sw.js, модули Node подменены заглушками из sw/shims.
const req = createRequire(import.meta.url);
const shim = (f: string) => fileURLToPath(new URL(`sw/shims/${f}`, import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      { find: /^(node:)?fs$/, replacement: shim("fs.ts") },
      { find: /^(node:)?os$/, replacement: shim("os.ts") },
      { find: /^(node:)?url$/, replacement: shim("url.ts") },
      { find: /^(node:)?child_process$/, replacement: shim("child_process.ts") },
      { find: /^(node:)?path$/, replacement: req.resolve("path-browserify") },
      { find: /^(node:)?stream$/, replacement: shim("stream.ts") },
      { find: /^(node:)?events$/, replacement: req.resolve("events/") },
      { find: /^node:buffer$/, replacement: req.resolve("buffer/") },
    ],
  },
  build: {
    outDir: "../../out/site",
    emptyOutDir: false,
    minify: true,
    chunkSizeWarningLimit: 8000,
    lib: { entry: fileURLToPath(new URL("sw/sw.ts", import.meta.url)), formats: ["iife"], name: "afsw", fileName: () => "sw.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
