import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The OAuth library imports the Workers runtime module; tests run the
      // Worker in Node with real local bindings from wrangler.
      "cloudflare:workers": fileURLToPath(
        new URL("./test/cloudflare-workers-shim.ts", import.meta.url).href,
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
