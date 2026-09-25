import { describe, expect, it } from "vitest";
import { parse } from "../../../src/core/rules/parser";
import type { RuleAST } from "../../../src/core/types";

function ast(text: string): RuleAST {
  const r = parse(text);
  if (!r.ok) throw new Error(`${text}: ${JSON.stringify(r.diagnostics)}`);
  return r.ast;
}

function code(text: string): string | undefined {
  const r = parse(text);
  return r.ok ? undefined : r.diagnostics[0]?.code;
}

const A = { kind: "compare", field: "ip.src.asnum", op: "eq", value: 1 } as const;
const B = { kind: "compare", field: "ip.src.asnum", op: "eq", value: 2 } as const;
const C = { kind: "compare", field: "ip.src.asnum", op: "eq", value: 3 } as const;
const a = "ip.src.asnum eq 1";
const b = "ip.src.asnum eq 2";
const c = "ip.src.asnum eq 3";

describe("parser: one positive and one negative test per production", () => {
  it("comparison, eq and ne", () => {
    expect(ast('http.request.uri.path eq "/login"')).toEqual({
      kind: "compare",
      field: "http.request.uri.path",
      op: "eq",
      value: "/login",
    });
    expect(ast("http.response.code ne 200")).toEqual({ kind: "compare", field: "http.response.code", op: "ne", value: 200 });
    expect(code("http.response.code eq")).toBe("E_UNEXPECTED_EOF");
    expect(code("http.response.code eq eq")).toBe("E_UNEXPECTED_TOKEN");
  });

  it("comparison, contains", () => {
    expect(ast('http.user_agent contains "okhttp"')).toEqual({ kind: "contains", field: "http.user_agent", value: "okhttp" });
    expect(code("ip.src.asnum contains 5")).toBe("E_CONTAINS_ON_NUMBER");
    expect(code("http.user_agent contains 5")).toBe("E_TYPE_MISMATCH");
  });

  it("comparison, in with a set", () => {
    expect(ast('ip.src.country in {"GB" "FR"}')).toEqual({ kind: "in", field: "ip.src.country", values: ["GB", "FR"] });
    expect(ast("ip.src.asnum in {1}")).toEqual({ kind: "in", field: "ip.src.asnum", values: [1] });
    expect(code('ip.src.country in "GB"')).toBe("E_UNEXPECTED_TOKEN");
    expect(code('ip.src.country in {"GB"')).toBe("E_UNEXPECTED_EOF");
    expect(code('ip.src.country in {"GB", "FR"}')).toBe("E_UNEXPECTED_CHAR");
  });

  it("an empty set parses; the type checker rejects it", () => {
    expect(ast("ip.src.asnum in {}")).toEqual({ kind: "in", field: "ip.src.asnum", values: [] });
  });

  it("term with lower()", () => {
    expect(ast('lower(http.user_agent) eq "x"')).toEqual({
      kind: "compare",
      field: "http.user_agent",
      op: "eq",
      value: "x",
      lower: true,
    });
    expect(ast('lower(http.user_agent) in {"x"}')).toMatchObject({ kind: "in", lower: true });
    expect(code('lower http.user_agent eq "x"')).toBe("E_UNEXPECTED_TOKEN");
    expect(code('lower(http.user_agent eq "x"')).toBe("E_UNEXPECTED_TOKEN");
    expect(code('lower("x") eq "x"')).toBe("E_UNEXPECTED_TOKEN");
  });

  it("field names", () => {
    expect(code('http.host eq "x"')).toBe("E_UNKNOWN_FIELD");
    expect(code('"x" eq "x"')).toBe("E_UNEXPECTED_TOKEN");
  });

  it("operators outside the subset", () => {
    expect(code('http.request.uri.path matches "^/api"')).toBe("E_UNKNOWN_OPERATOR");
    expect(code("http.response.code gt 400")).toBe("E_UNKNOWN_OPERATOR");
    expect(code("http.response.code ( 400")).toBe("E_UNEXPECTED_TOKEN");
  });

  it("not_expr", () => {
    expect(ast(`not ${a}`)).toEqual({ kind: "not", operand: A });
    expect(ast(`not (not ${a})`)).toEqual({ kind: "not", operand: { kind: "not", operand: A } });
    // The grammar allows one "not" per primary; a double not needs parentheses.
    expect(code(`not not ${a}`)).toBe("E_UNEXPECTED_TOKEN");
    expect(code("not")).toBe("E_UNEXPECTED_EOF");
  });

  it("and_expr", () => {
    expect(ast(`${a} and ${b}`)).toEqual({ kind: "and", left: A, right: B });
    expect(code(`${a} and`)).toBe("E_UNEXPECTED_EOF");
    expect(code(`and ${a}`)).toBe("E_UNEXPECTED_TOKEN");
  });

  it("or_expr", () => {
    expect(ast(`${a} or ${b}`)).toEqual({ kind: "or", left: A, right: B });
    expect(code(`${a} or or ${b}`)).toBe("E_UNEXPECTED_TOKEN");
  });

  it("primary with parentheses", () => {
    expect(ast(`(${a})`)).toEqual(A);
    expect(ast(`((${a}))`)).toEqual(A);
    expect(code(`(${a}`)).toBe("E_UNEXPECTED_EOF");
    expect(code(`()`)).toBe("E_UNEXPECTED_TOKEN");
  });

  it("expression must consume all input", () => {
    expect(code(`${a} ${b}`)).toBe("E_TRAILING_INPUT");
    expect(code(`${a})`)).toBe("E_TRAILING_INPUT");
    expect(code("")).toBe("E_UNEXPECTED_EOF");
  });
});

describe("parser: precedence and associativity", () => {
  it("a or b and c is a or (b and c)", () => {
    expect(ast(`${a} or ${b} and ${c}`)).toEqual({ kind: "or", left: A, right: { kind: "and", left: B, right: C } });
  });

  it("a and b or c is (a and b) or c", () => {
    expect(ast(`${a} and ${b} or ${c}`)).toEqual({ kind: "or", left: { kind: "and", left: A, right: B }, right: C });
  });

  it("not a and b is (not a) and b", () => {
    expect(ast(`not ${a} and ${b}`)).toEqual({ kind: "and", left: { kind: "not", operand: A }, right: B });
  });

  it("not binds to a parenthesized group when one follows", () => {
    expect(ast(`not (${a} and ${b})`)).toEqual({ kind: "not", operand: { kind: "and", left: A, right: B } });
  });

  it("and and or are left associative", () => {
    expect(ast(`${a} and ${b} and ${c}`)).toEqual({ kind: "and", left: { kind: "and", left: A, right: B }, right: C });
    expect(ast(`${a} or ${b} or ${c}`)).toEqual({ kind: "or", left: { kind: "or", left: A, right: B }, right: C });
  });

  it("parentheses override precedence", () => {
    expect(ast(`(${a} or ${b}) and ${c}`)).toEqual({ kind: "and", left: { kind: "or", left: A, right: B }, right: C });
  });
});

describe("parser: spans and limits", () => {
  it("records spans for nodes, fields and literals", () => {
    const text = `not ${a} and http.user_agent contains "ok"`;
    const r = parse(text);
    if (!r.ok) throw new Error("expected ok");
    const at = (k: string) => {
      const s = r.spans.get(k);
      return s ? text.slice(s.start, s.end) : undefined;
    };
    expect(at("")).toBe(text);
    expect(at("left")).toBe(`not ${a}`);
    expect(at("left.operand")).toBe(a);
    expect(at("right")).toBe('http.user_agent contains "ok"');
    expect(at("right#field")).toBe("http.user_agent");
    expect(at("right#value")).toBe('"ok"');
  });

  it("a parenthesized node's span includes its parentheses", () => {
    const text = `(${a} or ${b}) and ${c}`;
    const r = parse(text);
    if (!r.ok) throw new Error("expected ok");
    const s = r.spans.get("left");
    expect(s && text.slice(s.start, s.end)).toBe(`(${a} or ${b})`);
  });

  it("set value spans", () => {
    const text = 'ip.src.country in {"GB" "FR"}';
    const r = parse(text);
    if (!r.ok) throw new Error("expected ok");
    const s = r.spans.get("#values.1");
    expect(s && text.slice(s.start, s.end)).toBe('"FR"');
  });

  it("E_AST_TOO_DEEP on hostile nesting, without overflowing the stack", () => {
    expect(code(`${"(".repeat(3000)}${a}${")".repeat(3000)}`)).toBe("E_AST_TOO_DEEP");
    expect(code(`${"not (".repeat(40)}${a}${")".repeat(40)}`)).toBe("E_AST_TOO_DEEP");
    expect(code(Array.from({ length: 40 }, () => a).join(" and "))).toBe("E_AST_TOO_DEEP");
  });
});
