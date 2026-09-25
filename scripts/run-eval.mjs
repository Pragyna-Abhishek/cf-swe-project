// Bundles scripts/eval-driver.ts and runs it. See PLAN.md Phase 5 and docs/eval-results/.
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/eval-driver.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/eval/driver.mjs",
  logLevel: "error",
});
execFileSync("node", ["dist/eval/driver.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
