// Unit tests: plain Vitest in Node, no Workers runtime. The deterministic core is pure
// TypeScript, so most tests live here and run fast.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "istanbul",
      include: ["src/core/**"],
      reporter: ["text-summary", "text"],
    },
  },
});
