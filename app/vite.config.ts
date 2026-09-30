import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The MCP App is served as one self-contained HTML resource, so scripts and
// styles are inlined; the host's iframe CSP blocks external assets.
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
