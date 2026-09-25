import { describe, expect, it } from "vitest";
import { lex } from "../../../src/core/rules/lexer";

function codes(text: string): string[] {
  const r = lex(text);
  return r.ok ? [] : r.diagnostics.map((d) => d.code);
}

describe("lexer", () => {
  it("tokenizes every token kind with exact spans", () => {
    const text = 'lower(http.user_agent) in {"a b" 42}';
    const r = lex(text);
    if (!r.ok) throw new Error("expected ok");
    expect(r.tokens.map((t) => t.kind)).toEqual([
      "keyword",
      "lparen",
      "ident",
      "rparen",
      "keyword",
      "lbrace",
      "string",
      "number",
      "rbrace",
      "eof",
    ]);
    for (const t of r.tokens.slice(0, -1)) {
      const slice = text.slice(t.span.start, t.span.end);
      if (t.kind === "string") expect(slice).toBe('"a b"');
      if (t.kind === "ident") expect(slice).toBe("http.user_agent");
    }
    expect(r.tokens.at(-1)?.span).toEqual({ start: text.length, end: text.length });
  });

  it("recognizes every keyword and nothing that merely starts like one", () => {
    const r = lex("and or not eq ne contains in lower android");
    if (!r.ok) throw new Error("expected ok");
    expect(r.tokens.slice(0, 8).every((t) => t.kind === "keyword")).toBe(true);
    expect(r.tokens[8]).toMatchObject({ kind: "ident", value: "android" });
  });

  it("decodes the two escapes", () => {
    const r = lex('"a\\"b\\\\c"');
    if (!r.ok) throw new Error("expected ok");
    expect(r.tokens[0]).toMatchObject({ kind: "string", value: 'a"b\\c' });
  });

  it("keeps non-ASCII characters and reports spans as string offsets", () => {
    const text = '"é🙂" eq';
    const r = lex(text);
    if (!r.ok) throw new Error("expected ok");
    expect(r.tokens[0]).toMatchObject({ kind: "string", value: "é🙂", span: { start: 0, end: 5 } });
    expect(r.tokens[1]?.span).toEqual({ start: 6, end: 8 });
  });

  it("accepts the largest number and zero", () => {
    const r = lex("4294967295 0");
    if (!r.ok) throw new Error("expected ok");
    expect(r.tokens[0]).toMatchObject({ value: 4294967295 });
    expect(r.tokens[1]).toMatchObject({ value: 0 });
  });

  it("E_UNEXPECTED_CHAR with the offending character's span", () => {
    const r = lex("http.request.method == 1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]).toMatchObject({ code: "E_UNEXPECTED_CHAR", span: { start: 20, end: 21 } });
    expect(codes("a ; b")).toEqual(["E_UNEXPECTED_CHAR"]);
  });

  it("E_UNTERMINATED_STRING", () => {
    expect(codes('http.user_agent eq "abc')).toEqual(["E_UNTERMINATED_STRING"]);
  });

  it("E_INVALID_ESCAPE", () => {
    expect(codes('"a\\nb"')).toEqual(["E_INVALID_ESCAPE"]);
    expect(codes('"trailing\\')).toEqual(["E_INVALID_ESCAPE"]);
  });

  it("E_CONTROL_CHAR", () => {
    expect(codes('"a\nb"')).toEqual(["E_CONTROL_CHAR"]);
    expect(codes('"a\u007fb"')).toEqual(["E_CONTROL_CHAR"]);
  });

  it("E_INVALID_NUMBER for leading zeros and digits glued to letters", () => {
    expect(codes("007")).toEqual(["E_INVALID_NUMBER"]);
    expect(codes("12abc")).toEqual(["E_INVALID_NUMBER"]);
  });

  it("E_NUMBER_OUT_OF_RANGE", () => {
    expect(codes("4294967296")).toEqual(["E_NUMBER_OUT_OF_RANGE"]);
    expect(codes("9".repeat(400))).toEqual(["E_NUMBER_OUT_OF_RANGE"]);
  });

  it("E_INPUT_TOO_LONG", () => {
    expect(codes(" ".repeat(9000))).toEqual(["E_INPUT_TOO_LONG"]);
  });
});
