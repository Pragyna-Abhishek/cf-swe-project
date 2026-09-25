// Integration tests: the real Worker, Agent and Workflow running in workerd through
// @cloudflare/vitest-plugin. Run with --max-workers=1 --no-isolate (see package.json), because
// WebSockets with Durable Objects are unsupported under per-file storage isolation.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Vite 8 transpiles with Oxc, which does not handle TC39 decorators yet; @callable() needs this.
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The AI binding is remote-only. Tests use the fake model, so no remote session is opened.
      remoteBindings: false,
      // The fake model: integration tests need no Cloudflare credentials.
      miniflare: { bindings: { MODEL_MODE: "fake" } },
    }),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
