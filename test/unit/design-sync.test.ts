// DESIGN.md section 6 is a verbatim copy of src/core/types.ts. A design document that drifts
// from the code is worse than none (CLAUDE.md), so drift fails the build.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("DESIGN.md section 6 matches src/core/types.ts", () => {
  const types = readFileSync("src/core/types.ts", "utf8");
  const body = types.slice(types.indexOf("// ---------------------------------------------------------------------------\n// Traffic")).trimEnd();
  const design = readFileSync("DESIGN.md", "utf8");
  const section = design.slice(design.indexOf("## 6. Data model"), design.indexOf("## 7."));
  const block = section.slice(section.indexOf("```ts\n") + 6, section.lastIndexOf("```")).trimEnd();
  expect(block).toBe(body);
});
