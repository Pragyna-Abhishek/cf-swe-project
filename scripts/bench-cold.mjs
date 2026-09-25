// Runs test/bench/cold.ts in many fresh Node processes and reports the p50 and max of each
// first-call timing. Usage: node scripts/bench-cold.mjs [runs]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { build } from "esbuild";

const runs = Number(process.argv[2] ?? "15");
mkdirSync("dist/bench", { recursive: true });
await build({
  entryPoints: ["test/bench/cold.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/bench/cold.mjs",
  logLevel: "error",
});
const keys = ["generate", "encode", "decode", "aggregate", "verify", "compile", "evaluate"];
console.log("| chunk | " + keys.map((k) => `${k} p50 / max`).join(" | ") + " |");
console.log("| ---: | " + keys.map(() => "---:").join(" | ") + " |");
for (const size of [500, 1000, 2000, 6000]) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    samples.push(JSON.parse(execFileSync("node", ["dist/bench/cold.mjs", String(size)]).toString()));
  }
  const cell = (k) => {
    const xs = samples.map((s) => s[k]).sort((a, b) => a - b);
    return `${xs[Math.floor(xs.length / 2)].toFixed(2)} / ${xs[xs.length - 1].toFixed(2)} ms`;
  };
  console.log(`| ${size} | ` + keys.map(cell).join(" | ") + " |");
}
