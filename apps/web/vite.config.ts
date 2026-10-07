import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Страница импортирует ядро прямо из исходников packages/core — ту же логику, что у CLI и агента.
export default defineConfig({
  plugins: [react()],
});
