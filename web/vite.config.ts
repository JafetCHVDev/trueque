import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves the app under /<repo>/; local dev and other hosts use /.
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  define: { global: "globalThis" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
