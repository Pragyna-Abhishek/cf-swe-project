import { describe, expect, it } from "vitest";
import { checkRuleText } from "../../../src/core/rules/pipeline";
import { typecheck } from "../../../src/core/rules/typecheck";
import type { RuleAST } from "../../../src/core/types";

const codes = (ast: RuleAST) => typecheck(ast).map((d) => d.code);
const textCodes = (text: string) => checkRuleText(text).diagnostics.map((d) => d.code);

describe("type checker", () => {
  it("accepts well-typed rules with no diagnostics", () => {
    expect(textCodes('http.request.uri.path eq "/login" and ip.src.asnum in {64500 64520}')).toEqual([]);
    expect(textCodes('lower(http.user_agent) contains "okhttp"')).toEqual([]);
    expect(textCodes("not http.response.code ne 200")).toEqual([]);
  });

  it("string fields reject number literals", () => {
    expect(textCodes("http.request.uri.path eq 5")).toEqual(["E_TYPE_MISMATCH"]);
    expect(textCodes("ip.src.country in {5}")).toEqual(["E_TYPE_MISMATCH"]);
  });

  it("number fields reject string literals", () => {
    expect(textCodes('ip.src.asnum eq "64500"')).toEqual(["E_TYPE_MISMATCH"]);
    expect(textCodes('http.response.code in {"401"}')).toEqual(["E_TYPE_MISMATCH"]);
  });

  it("contains rejects number fields, even when the AST type was bypassed", () => {
    const forged = { kind: "contains", field: "ip.src.asnum", value: "1" } as unknown as RuleAST;
    expect(codes(forged)).toEqual(["E_CONTAINS_ON_NUMBER"]);
  });

  it("lower() rejects number fields", () => {
    expect(textCodes("lower(ip.src.asnum) eq 5")).toEqual(["E_LOWER_ON_NUMBER"]);
    expect(textCodes("lower(http.response.code) in {200}")).toEqual(["E_LOWER_ON_NUMBER"]);
  });

  it("in requires a non-empty homogeneous set", () => {
    expect(textCodes("ip.src.asnum in {}")).toEqual(["E_EMPTY_SET"]);
    expect(textCodes('ip.src.asnum in {1 "2"}')).toEqual(["E_SET_NOT_HOMOGENEOUS"]);
  });

  it("number literals must fit the field's range", () => {
    expect(textCodes("http.response.code eq 99")).toEqual(["E_NUMBER_OUT_OF_RANGE"]);
    expect(textCodes("http.response.code eq 600")).toEqual(["E_NUMBER_OUT_OF_RANGE"]);
    expect(textCodes("ip.src.asnum eq 4294967295")).toEqual([]);
  });

  it("warns, without failing, on rules that are legal but almost certainly wrong", () => {
    const d = checkRuleText('lower(http.user_agent) contains "OkHttp"').diagnostics;
    expect(d.map((x) => [x.code, x.severity])).toEqual([["W_LOWER_UPPERCASE_LITERAL", "warning"]]);
    expect(textCodes('http.user_agent contains ""')).toEqual(["W_EMPTY_CONTAINS"]);
    expect(textCodes('ip.src.country in {"GB" "GB"}')).toEqual(["W_DUPLICATE_SET_VALUE"]);
  });

  it("rejects fields and operators that are not in the subset, when the AST type was bypassed", () => {
    expect(codes({ kind: "compare", field: "http.host", op: "eq", value: "x" } as unknown as RuleAST)).toEqual([
      "E_UNKNOWN_FIELD",
    ]);
    expect(codes({ kind: "compare", field: "http.user_agent", op: "gt", value: "x" } as unknown as RuleAST)).toEqual([
      "E_UNKNOWN_OPERATOR",
    ]);
    expect(codes({ kind: "in", field: "nope", values: [1] } as unknown as RuleAST)).toEqual(["E_UNKNOWN_FIELD"]);
    expect(codes({ kind: "contains", field: "nope", value: "x" } as unknown as RuleAST)).toEqual(["E_UNKNOWN_FIELD"]);
  });

  it("checks every node, not just the first", () => {
    expect(textCodes('ip.src.asnum eq "a" or not ip.src.country eq 5')).toEqual(["E_TYPE_MISMATCH", "E_TYPE_MISMATCH"]);
  });

  it("diagnostics carry spans into the rule text", () => {
    const text = 'http.request.uri.path eq "/x" and ip.src.asnum eq "64500"';
    const [d] = checkRuleText(text).diagnostics;
    expect(d?.span && text.slice(d.span.start, d.span.end)).toBe('"64500"');
    const lowerText = "lower(ip.src.asnum) eq 5";
    const [l] = checkRuleText(lowerText).diagnostics;
    expect(l?.span && lowerText.slice(l.span.start, l.span.end)).toBe("ip.src.asnum");
  });
});
