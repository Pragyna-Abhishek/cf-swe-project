// Bundles scripts/spikes-driver.ts and runs it. See docs/spikes.md.
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/spikes-driver.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/spikes/driver.mjs",
  logLevel: "error",
});
execFileSync("node", ["dist/spikes/driver.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
