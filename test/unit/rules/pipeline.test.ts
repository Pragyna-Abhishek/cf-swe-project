import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODES } from "../../../src/core/rules/diagnostics";
import { parse } from "../../../src/core/rules/parser";
import { checkRuleText, modelFailureOutcome, verifyAst, verifyModelDraft } from "../../../src/core/rules/pipeline";
import { print } from "../../../src/core/rules/printer";
import type { RuleAST } from "../../../src/core/types";

const wrap = (rule: unknown) => JSON.stringify({ rule });
const good: RuleAST = {
  kind: "and",
  left: { kind: "compare", field: "http.request.uri.path", op: "eq", value: "/login" },
  right: { kind: "contains", field: "http.user_agent", value: "okhttp", lower: true },
};

describe("verification pipeline", () => {
  it("a good draft is valid, printed, and round-tripped", () => {
    const out = verifyModelDraft(wrap(good));
    expect(out.status).toBe("valid");
    expect(out.text).toBe('http.request.uri.path eq "/login" and lower(http.user_agent) contains "okhttp"');
    expect(out.ast).toEqual(good);
    expect(out.diagnostics).toEqual([]);
  });

  it("schema failures are invalid-schema, with no AST and no text", () => {
    expect(verifyModelDraft("{")).toMatchObject({ status: "invalid-schema", ast: null, text: null });
    expect(verifyModelDraft(wrap({ kind: "nope" }))).toMatchObject({ status: "invalid-schema", ast: null });
  });

  it("limit failures are invalid-schema, refused before printing", () => {
    const values = Array.from({ length: 33 }, (_, i) => `v${i}`);
    const out = verifyAst({ kind: "in", field: "http.user_agent", values });
    expect(out).toMatchObject({ status: "invalid-schema", ast: null, text: null });
  });

  it("type failures are invalid-types, still printed so the operator can see them, with spans", () => {
    const out = verifyModelDraft(wrap({ kind: "compare", field: "ip.src.asnum", op: "eq", value: "64500" }));
    expect(out.status).toBe("invalid-types");
    expect(out.text).toBe('ip.src.asnum eq "64500"');
    const d = out.diagnostics[0];
    expect(d?.code).toBe("E_TYPE_MISMATCH");
    expect(d?.span && out.text?.slice(d.span.start, d.span.end)).toBe('"64500"');
  });

  it("warnings alone leave a rule valid", () => {
    const out = verifyAst({ kind: "contains", field: "http.user_agent", value: "OkHttp", lower: true });
    expect(out.status).toBe("valid");
    expect(out.diagnostics.map((d) => d.code)).toEqual(["W_LOWER_UPPERCASE_LITERAL"]);
  });

  it("a printer bug fails loudly as roundtrip-failed", () => {
    const brokenPrinter: typeof print = (ast) => {
      const p = print(ast);
      return { ...p, text: p.text.replace(" and ", " or ") };
    };
    const out = verifyAst(good, { print: brokenPrinter, parse });
    expect(out.status).toBe("roundtrip-failed");
    expect(out.diagnostics[0]?.code).toBe("E_ROUNDTRIP_MISMATCH");
  });

  it("a printer that emits unparseable text also fails as roundtrip-failed", () => {
    const out = verifyAst(good, { print: (ast) => ({ ...print(ast), text: "((" }), parse });
    expect(out.status).toBe("roundtrip-failed");
  });

  it("model calls that return no text become diagnosed schema failures", () => {
    expect(modelFailureOutcome("json-mode-failed", "JSON Mode couldn't be met").diagnostics[0]?.code).toBe("E_JSON_MODE_FAILED");
    expect(modelFailureOutcome("error", "boom")).toMatchObject({ status: "invalid-schema", ast: null });
    expect(modelFailureOutcome("error", "boom").diagnostics[0]?.code).toBe("E_MODEL_ERROR");
  });

  it("operator-typed text goes through the parser and the same checks", () => {
    expect(checkRuleText('http.user_agent eq "x"').diagnostics).toEqual([]);
    expect(checkRuleText("http.user_agent eq").diagnostics[0]?.code).toBe("E_UNEXPECTED_EOF");
    const wide = (d: number): RuleAST =>
      d === 0 ? { kind: "compare", field: "ip.src.asnum", op: "eq", value: d } : { kind: "or", left: wide(d - 1), right: wide(d - 1) };
    expect(checkRuleText(print(wide(7)).text).diagnostics.map((d) => d.code)).toEqual(["E_AST_TOO_MANY_NODES"]);
  });
});

describe("every diagnostic code is produced by at least one test", () => {
  // The list of codes each test file exercises. If a code is added to diagnostics.ts without a
  // test producing it, this fails. The lookups below produce each code here as well, so the
  // table cannot drift from reality.
  const produce: Record<string, () => string[]> = {
    E_INPUT_TOO_LONG: () => checkRuleText(" ".repeat(9000)).diagnostics.map((d) => d.code),
    E_UNEXPECTED_CHAR: () => checkRuleText("a == b").diagnostics.map((d) => d.code),
    E_UNTERMINATED_STRING: () => checkRuleText('http.user_agent eq "x').diagnostics.map((d) => d.code),
    E_INVALID_ESCAPE: () => checkRuleText('http.user_agent eq "\\n"').diagnostics.map((d) => d.code),
    E_CONTROL_CHAR: () => checkRuleText('http.user_agent eq "\t"').diagnostics.map((d) => d.code),
    E_INVALID_NUMBER: () => checkRuleText("ip.src.asnum eq 01").diagnostics.map((d) => d.code),
    E_NUMBER_OUT_OF_RANGE: () => checkRuleText("http.response.code eq 7").diagnostics.map((d) => d.code),
    E_UNEXPECTED_TOKEN: () => checkRuleText("and").diagnostics.map((d) => d.code),
    E_UNEXPECTED_EOF: () => checkRuleText("").diagnostics.map((d) => d.code),
    E_UNKNOWN_FIELD: () => checkRuleText('http.host eq "x"').diagnostics.map((d) => d.code),
    E_UNKNOWN_OPERATOR: () => checkRuleText("ip.src.asnum ge 1").diagnostics.map((d) => d.code),
    E_TRAILING_INPUT: () => checkRuleText("ip.src.asnum eq 1 1").diagnostics.map((d) => d.code),
    E_TYPE_MISMATCH: () => checkRuleText("ip.src.country eq 1").diagnostics.map((d) => d.code),
    E_CONTAINS_ON_NUMBER: () => checkRuleText('ip.src.asnum contains "1"').diagnostics.map((d) => d.code),
    E_LOWER_ON_NUMBER: () => checkRuleText("lower(ip.src.asnum) eq 1").diagnostics.map((d) => d.code),
    E_EMPTY_SET: () => checkRuleText("ip.src.asnum in {}").diagnostics.map((d) => d.code),
    E_SET_NOT_HOMOGENEOUS: () => checkRuleText('ip.src.asnum in {1 "x"}').diagnostics.map((d) => d.code),
    W_LOWER_UPPERCASE_LITERAL: () => checkRuleText('lower(http.user_agent) eq "X"').diagnostics.map((d) => d.code),
    W_EMPTY_CONTAINS: () => checkRuleText('http.user_agent contains ""').diagnostics.map((d) => d.code),
    W_DUPLICATE_SET_VALUE: () => checkRuleText("ip.src.asnum in {1 1}").diagnostics.map((d) => d.code),
    E_AST_TOO_DEEP: () => checkRuleText(`${"(".repeat(50)}ip.src.asnum eq 1${")".repeat(50)}`).diagnostics.map((d) => d.code),
    E_AST_TOO_MANY_NODES: () => verifyAst(balanced(7)).diagnostics.map((d) => d.code),
    E_SET_TOO_LARGE: () => verifyAst({ kind: "in", field: "ip.src.asnum", values: Array.from({ length: 33 }, (_, i) => i) }).diagnostics.map((d) => d.code),
    E_STRING_TOO_LONG: () => verifyAst({ kind: "contains", field: "http.user_agent", value: "x".repeat(300) }).diagnostics.map((d) => d.code),
    E_SCHEMA_NOT_JSON: () => verifyModelDraft("nope").diagnostics.map((d) => d.code),
    E_SCHEMA_INVALID: () => verifyModelDraft("{}").diagnostics.map((d) => d.code),
    E_JSON_MODE_FAILED: () => modelFailureOutcome("json-mode-failed", "x").diagnostics.map((d) => d.code),
    E_MODEL_ERROR: () => modelFailureOutcome("error", "x").diagnostics.map((d) => d.code),
    E_ROUNDTRIP_MISMATCH: () =>
      verifyAst(good, { print: (a) => ({ ...print(a), text: 'http.user_agent eq "different"' }), parse }).diagnostics.map((d) => d.code),
  };

  function balanced(d: number): RuleAST {
    return d === 0
      ? { kind: "compare", field: "ip.src.asnum", op: "eq", value: 1 }
      : { kind: "or", left: balanced(d - 1), right: balanced(d - 1) };
  }

  it("the table covers every code", () => {
    expect(Object.keys(produce).sort()).toEqual(Object.keys(DIAGNOSTIC_CODES).sort());
  });

  for (const [code, fn] of Object.entries(produce)) {
    it(`${code} is produced`, () => {
      expect(fn()).toContain(code);
    });
  }
});
