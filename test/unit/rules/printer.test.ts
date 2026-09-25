import { describe, expect, it } from "vitest";
import { Rng } from "../../../src/core/random";
import { parse } from "../../../src/core/rules/parser";
import { astEqual } from "../../../src/core/rules/pipeline";
import { print } from "../../../src/core/rules/printer";
import type { RuleAST } from "../../../src/core/types";
import { anyAst } from "./gen";

const A: RuleAST = { kind: "compare", field: "ip.src.asnum", op: "eq", value: 1 };
const B: RuleAST = { kind: "compare", field: "ip.src.asnum", op: "eq", value: 2 };
const C: RuleAST = { kind: "compare", field: "ip.src.asnum", op: "eq", value: 3 };

describe("printer", () => {
  it("prints leaves in canonical form", () => {
    expect(print({ kind: "compare", field: "http.request.uri.path", op: "eq", value: "/login" }).text).toBe(
      'http.request.uri.path eq "/login"',
    );
    expect(print({ kind: "contains", field: "http.user_agent", value: "ok", lower: true }).text).toBe(
      'lower(http.user_agent) contains "ok"',
    );
    expect(print({ kind: "in", field: "ip.src.country", values: ["GB", "FR"] }).text).toBe('ip.src.country in {"GB" "FR"}');
  });

  it("escapes quotes and backslashes", () => {
    expect(print({ kind: "compare", field: "http.user_agent", op: "eq", value: 'a"b\\c' }).text).toBe(
      'http.user_agent eq "a\\"b\\\\c"',
    );
  });

  it("adds no parentheses where precedence already agrees", () => {
    expect(print({ kind: "or", left: A, right: { kind: "and", left: B, right: C } }).text).toBe(
      "ip.src.asnum eq 1 or ip.src.asnum eq 2 and ip.src.asnum eq 3",
    );
    expect(print({ kind: "and", left: { kind: "and", left: A, right: B }, right: C }).text).not.toContain("(");
  });

  it("parenthesizes a looser child, a right-nested same operator, and a non-leaf under not", () => {
    expect(print({ kind: "and", left: { kind: "or", left: A, right: B }, right: C }).text).toBe(
      "(ip.src.asnum eq 1 or ip.src.asnum eq 2) and ip.src.asnum eq 3",
    );
    expect(print({ kind: "and", left: A, right: { kind: "and", left: B, right: C } }).text).toBe(
      "ip.src.asnum eq 1 and (ip.src.asnum eq 2 and ip.src.asnum eq 3)",
    );
    expect(print({ kind: "not", operand: { kind: "not", operand: A } }).text).toBe("not (not ip.src.asnum eq 1)");
    expect(print({ kind: "not", operand: A }).text).toBe("not ip.src.asnum eq 1");
  });

  it("span map points at the printed text for every node", () => {
    const ast: RuleAST = { kind: "and", left: { kind: "or", left: A, right: B }, right: { kind: "not", operand: C } };
    const { text, spans } = print(ast);
    const at = (k: string) => {
      const s = spans.get(k);
      return s ? text.slice(s.start, s.end) : undefined;
    };
    expect(at("")).toBe(text);
    expect(at("left")).toBe("(ip.src.asnum eq 1 or ip.src.asnum eq 2)");
    expect(at("right.operand")).toBe("ip.src.asnum eq 3");
    expect(at("left.right#value")).toBe("2");
  });

  it("printer and parser agree on spans", () => {
    const ast: RuleAST = { kind: "or", left: { kind: "and", left: A, right: B }, right: { kind: "in", field: "ip.src.country", values: ["GB"] } };
    const printed = print(ast);
    const parsed = parse(printed.text);
    if (!parsed.ok) throw new Error("expected ok");
    expect(Object.fromEntries(parsed.spans)).toEqual(Object.fromEntries(printed.spans));
  });
});

describe("round-trip property", () => {
  it("1,000 generated ASTs all round-trip through printer and parser", () => {
    let checked = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      const ast = anyAst(new Rng(seed));
      const text = print(ast).text;
      const back = parse(text);
      if (!back.ok) throw new Error(`seed ${seed}: parser rejected ${text}: ${back.diagnostics[0]?.message}`);
      if (!astEqual(ast, back.ast)) throw new Error(`seed ${seed}: ${text} did not round-trip`);
      expect(back.ast).toEqual(ast);
      checked++;
    }
    expect(checked).toBe(1000);
  });
});
