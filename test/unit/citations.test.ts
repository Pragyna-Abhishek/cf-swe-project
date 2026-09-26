import { describe, expect, it } from "vitest";
import { checkCitations, extractCitations } from "../../src/core/citations";

describe("evidence citation extraction and checking", () => {
  it("extracts every ev_ token, de-duplicated, in order", () => {
    expect(extractCitations("see (ev_4) and also (ev_replay_1), plus ev_4 again")).toEqual(["ev_4", "ev_replay_1"]);
  });

  it("returns an empty list when nothing is cited", () => {
    expect(extractCitations("no evidence here")).toEqual([]);
  });

  it("does not match ev_ appearing mid-word, since underscore is a word character", () => {
    expect(extractCitations("device_ev_4 has no word boundary before ev_ here")).toEqual([]);
  });

  it("ok when every citation is known", () => {
    const known = new Set(["ev_1", "ev_4"]);
    expect(checkCitations("supported by (ev_1) and (ev_4)", known)).toEqual({ ok: true });
  });

  it("flags a fabricated citation not present in the known set", () => {
    const known = new Set(["ev_1"]);
    const result = checkCitations("supported by (ev_1) and (ev_9999)", known);
    expect(result).toEqual({ ok: false, fabricated: ["ev_9999"] });
  });

  it("a hypothesis with no citations at all is not fabrication", () => {
    expect(checkCitations("no evidence cited", new Set())).toEqual({ ok: true });
  });
});
