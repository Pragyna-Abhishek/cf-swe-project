// Architecture checks that are cheap to automate.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSymptom, MAX_SYMPTOM_CHARS, sanitizeAttribute } from "../../src/core/sanitize";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("CLAUDE.md invariant 6: the deterministic core imports nothing platform specific", () => {
  it("src/core only imports relative modules", () => {
    for (const file of filesUnder("src/core")) {
      const src = readFileSync(file, "utf8");
      const imports = [...src.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms)].map((m) => m[1] ?? "");
      for (const spec of imports) expect(spec.startsWith("."), `${file} imports ${spec}`).toBe(true);
      expect(src).not.toMatch(/cloudflare:|\bagents\b\/|env\.AI/);
    }
  });
});

describe("sanitize", () => {
  it("strips control characters and caps length visibly", () => {
    expect(sanitizeAttribute("a\u0000b\nc d")).toBe("abcd");
    const long = sanitizeAttribute("x".repeat(500));
    expect(long.endsWith("...[truncated]")).toBe(true);
    expect(long.length).toBeLessThan(200);
  });

  it("rejects an oversized symptom instead of truncating it", () => {
    expect(checkSymptom("x".repeat(MAX_SYMPTOM_CHARS + 1)).ok).toBe(false);
    expect(checkSymptom("   ").ok).toBe(false);
    expect(checkSymptom(42).ok).toBe(false);
    expect(checkSymptom("  users locked out  ")).toEqual({ ok: true, symptom: "users locked out" });
  });
});
