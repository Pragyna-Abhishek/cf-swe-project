// Benchmarks. Excluded from the normal test run. See docs/spikes.md.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/bench/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
  },
});
