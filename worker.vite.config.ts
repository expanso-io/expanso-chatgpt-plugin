import { builtinModules } from "node:module";
import { defineConfig } from "vite";

// Bundles the Worker ahead of time; wrangler then deploys dist/worker as-is
// (no_bundle), so local and CI builds produce the same artifact.
export default defineConfig({
  build: {
    ssr: "src/worker.ts",
    outDir: "dist/worker",
    emptyOutDir: true,
    target: "es2023",
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: [
        /^cloudflare:/,
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
      output: { entryFileNames: "worker.js", format: "es" },
    },
  },
  ssr: {
    target: "webworker",
    noExternal: true,
    resolve: {
      conditions: ["workerd", "worker", "browser", "import", "default"],
    },
  },
});
