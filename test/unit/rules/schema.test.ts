import { describe, expect, it } from "vitest";
import { checkLimits } from "../../../src/core/rules/limits";
import { decodeModelOutput, decodeRuleAst, RULE_JSON_SCHEMA } from "../../../src/core/rules/schema";
import type { RuleAST } from "../../../src/core/types";

const firstCode = (raw: string) => {
  const r = decodeModelOutput(raw);
  return r.ok ? undefined : r.diagnostics[0]?.code;
};
const wrap = (rule: unknown) => JSON.stringify({ rule });

describe("model output decoder", () => {
  it("decodes every node kind", () => {
    const rule: RuleAST = {
      kind: "and",
      left: { kind: "not", operand: { kind: "compare", field: "ip.src.asnum", op: "ne", value: 1 } },
      right: {
        kind: "or",
        left: { kind: "contains", field: "http.user_agent", value: "x", lower: true },
        right: { kind: "in", field: "ip.src.country", values: ["GB"] },
      },
    };
    expect(decodeModelOutput(wrap(rule))).toEqual({ ok: true, ast: rule });
  });

  it("normalizes lower: false to absent, so the round trip compares like with like", () => {
    const r = decodeModelOutput(wrap({ kind: "compare", field: "http.user_agent", op: "eq", value: "x", lower: false }));
    expect(r).toEqual({ ok: true, ast: { kind: "compare", field: "http.user_agent", op: "eq", value: "x" } });
  });

  it("E_SCHEMA_NOT_JSON", () => {
    expect(firstCode("not json")).toBe("E_SCHEMA_NOT_JSON");
    expect(firstCode('{"rule": ')).toBe("E_SCHEMA_NOT_JSON");
  });

  it("E_SCHEMA_INVALID with a pointer to the problem", () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /expected an object with a "rule"/],
      [{}, /missing required property "rule"/],
      [{ rule: {}, extra: 1 }, /unexpected properties/],
    ];
    for (const [value, message] of cases) {
      const r = decodeModelOutput(JSON.stringify(value));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.diagnostics[0]?.message).toMatch(message);
    }
    const bad: Array<[unknown, RegExp]> = [
      [{ kind: "xor", left: 1, right: 2 }, /\/rule\/kind: unknown kind/],
      [{ kind: "compare", field: "http.host", op: "eq", value: "x" }, /\/rule\/field: unknown field/],
      [{ kind: "compare", field: "ip.src.asnum", op: "gt", value: 1 }, /\/rule\/op/],
      [{ kind: "compare", field: "ip.src.asnum", op: "eq", value: 1.5 }, /\/rule\/value/],
      [{ kind: "compare", field: "ip.src.asnum", op: "eq", value: -1 }, /\/rule\/value/],
      [{ kind: "compare", field: "ip.src.asnum", op: "eq" }, /missing required property "value"/],
      [{ kind: "compare", field: "ip.src.asnum", op: "eq", value: 1, why: "x" }, /unexpected property "why"/],
      [{ kind: "compare", field: "http.user_agent", op: "eq", value: "x", lower: "yes" }, /\/rule\/lower/],
      [{ kind: "contains", field: "ip.src.asnum", value: "1" }, /contains needs a string field/],
      [{ kind: "contains", field: "http.user_agent", value: 1 }, /\/rule\/value: expected a string/],
      [{ kind: "in", field: "ip.src.asnum", values: 1 }, /expected an array/],
      [{ kind: "in", field: "ip.src.asnum", values: [null] }, /\/rule\/values\/0/],
      [{ kind: "and", left: { kind: "not" }, right: null }, /\/rule\/left/],
      ["string", /expected an object/],
    ];
    for (const [rule, message] of bad) {
      const r = decodeModelOutput(wrap(rule));
      expect(r.ok, JSON.stringify(rule)).toBe(false);
      if (!r.ok) {
        expect(r.diagnostics[0]?.code).toBe("E_SCHEMA_INVALID");
        expect(r.diagnostics[0]?.message).toMatch(message);
      }
    }
  });

  it("refuses sets above the cap at the boundary", () => {
    const values = Array.from({ length: 40 }, (_, i) => i);
    expect(firstCode(wrap({ kind: "in", field: "ip.src.asnum", values }))).toBe("E_SCHEMA_INVALID");
  });

  it("stops recursing at the depth cap on hostile nesting", () => {
    // Built as text: stringifying a 5000-deep object would overflow the test's own stack.
    const leaf = '{"kind":"compare","field":"ip.src.asnum","op":"eq","value":1}';
    const raw = `{"rule":${'{"kind":"not","operand":'.repeat(5000)}${leaf}${"}".repeat(5000)}}`;
    expect(firstCode(raw)).toBe("E_AST_TOO_DEEP");
  });

  it("decodeRuleAst works without the wrapper", () => {
    expect(decodeRuleAst({ kind: "compare", field: "ip.src.asnum", op: "eq", value: 1 }).ok).toBe(true);
  });

  it("the JSON Schema names exactly the fields and kinds the decoder accepts", () => {
    const variants = RULE_JSON_SCHEMA.$defs.node.anyOf.map((v) => v.properties.kind.enum[0]);
    expect(variants).toEqual(["and", "or", "not", "compare", "contains", "in"]);
    expect(JSON.stringify(RULE_JSON_SCHEMA)).not.toContain("http.host");
  });
});

describe("structural limits", () => {
  const leaf: RuleAST = { kind: "compare", field: "ip.src.asnum", op: "eq", value: 1 };

  it("accepts rules within the caps", () => {
    expect(checkLimits(leaf)).toEqual([]);
  });

  it("E_AST_TOO_DEEP", () => {
    let deep: RuleAST = leaf;
    for (let i = 0; i < 40; i++) deep = { kind: "not", operand: deep };
    expect(checkLimits(deep).map((d) => d.code)).toContain("E_AST_TOO_DEEP");
  });

  it("E_AST_TOO_MANY_NODES", () => {
    // A balanced tree: shallow, but wide.
    const tree = (d: number): RuleAST => (d === 0 ? leaf : { kind: "or", left: tree(d - 1), right: tree(d - 1) });
    expect(checkLimits(tree(7)).map((d) => d.code)).toEqual(["E_AST_TOO_MANY_NODES"]);
  });

  it("E_SET_TOO_LARGE", () => {
    const values = Array.from({ length: 33 }, (_, i) => i);
    expect(checkLimits({ kind: "in", field: "ip.src.asnum", values }).map((d) => d.code)).toEqual(["E_SET_TOO_LARGE"]);
  });

  it("E_STRING_TOO_LONG", () => {
    const value = "x".repeat(300);
    expect(checkLimits({ kind: "contains", field: "http.user_agent", value }).map((d) => d.code)).toEqual(["E_STRING_TOO_LONG"]);
    expect(checkLimits({ kind: "in", field: "http.user_agent", values: [value] }).map((d) => d.code)).toEqual([
      "E_STRING_TOO_LONG",
    ]);
  });
});
