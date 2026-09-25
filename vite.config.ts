// Builds the React UI into dist/client, which wrangler.jsonc serves as static assets. The
// Worker itself is bundled by Wrangler (esbuild, keep_names), not by Vite.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  plugins: [react()],
  build: { outDir: "../dist/client", emptyOutDir: true },
});
