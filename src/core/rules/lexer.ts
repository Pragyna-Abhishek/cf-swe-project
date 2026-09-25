// Lexer for the Rules language subset. Every token carries its span so diagnostics can point
// at the exact characters. Spans are JavaScript string offsets (UTF-16 code units), which is
// what the UI needs to highlight text.

import type { Diagnostic, Span } from "../types";
import { diag } from "./diagnostics";
import { LIMITS, MAX_NUMBER_LITERAL } from "./fields";

export type Keyword = "and" | "or" | "not" | "eq" | "ne" | "contains" | "in" | "lower";

export type Token =
  | { kind: "keyword"; value: Keyword; span: Span }
  | { kind: "ident"; value: string; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "number"; value: number; span: Span }
  | { kind: "lparen" | "rparen" | "lbrace" | "rbrace" | "eof"; span: Span };

const KEYWORDS: readonly Keyword[] = ["and", "or", "not", "eq", "ne", "contains", "in", "lower"];

export type LexResult = { ok: true; tokens: Token[] } | { ok: false; diagnostics: Diagnostic[] };

const isIdentStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string) => isIdentStart(c) || (c >= "0" && c <= "9") || c === ".";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Stops at the first error: one precise diagnostic beats a cascade of guesses. */
export function lex(text: string): LexResult {
  if (text.length > LIMITS.maxTextChars) {
    return {
      ok: false,
      diagnostics: [diag("E_INPUT_TOO_LONG", `Limit is ${LIMITS.maxTextChars}.`, { start: 0, end: text.length })],
    };
  }
  const tokens: Token[] = [];
  const fail = (d: Diagnostic): LexResult => ({ ok: false, diagnostics: [d] });
  let i = 0;

  while (i < text.length) {
    const c = text.charAt(i);
    if (isSpace(c)) {
      i++;
      continue;
    }
    const start = i;
    const single = ({ "(": "lparen", ")": "rparen", "{": "lbrace", "}": "rbrace" } as const)[
      c as "(" | ")" | "{" | "}"
    ];
    if (single) {
      tokens.push({ kind: single, span: { start, end: i + 1 } });
      i++;
      continue;
    }
    if (isIdentStart(c)) {
      while (i < text.length && isIdentPart(text.charAt(i))) i++;
      const word = text.slice(start, i);
      const kw = KEYWORDS.find((k) => k === word);
      tokens.push(
        kw
          ? { kind: "keyword", value: kw, span: { start, end: i } }
          : { kind: "ident", value: word, span: { start, end: i } },
      );
      continue;
    }
    if (isDigit(c)) {
      while (i < text.length && isDigit(text.charAt(i))) i++;
      const digits = text.slice(start, i);
      const span = { start, end: i };
      if (i < text.length && isIdentStart(text.charAt(i))) {
        return fail(diag("E_INVALID_NUMBER", `Found "${text.slice(start, i + 1)}".`, { start, end: i + 1 }));
      }
      if (digits.length > 1 && digits.startsWith("0")) {
        return fail(diag("E_INVALID_NUMBER", `Found "${digits}".`, span));
      }
      // Compare by length first so a thousand-digit literal never reaches Number().
      if (digits.length > 10 || Number(digits) > MAX_NUMBER_LITERAL) {
        return fail(diag("E_NUMBER_OUT_OF_RANGE", `Maximum is ${MAX_NUMBER_LITERAL}.`, span));
      }
      tokens.push({ kind: "number", value: Number(digits), span });
      continue;
    }
    if (c === '"') {
      i++;
      let value = "";
      let closed = false;
      while (i < text.length) {
        const ch = text.charAt(i);
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        if (ch === "\\") {
          const next = text.charAt(i + 1);
          if (next === '"' || next === "\\") {
            value += next;
            i += 2;
            continue;
          }
          return fail(diag("E_INVALID_ESCAPE", null, { start: i, end: Math.min(i + 2, text.length) }));
        }
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
          return fail(diag("E_CONTROL_CHAR", `Code ${code}.`, { start: i, end: i + 1 }));
        }
        value += ch;
        i++;
      }
      if (!closed) return fail(diag("E_UNTERMINATED_STRING", null, { start, end: text.length }));
      tokens.push({ kind: "string", value, span: { start, end: i } });
      continue;
    }
    return fail(diag("E_UNEXPECTED_CHAR", `Found ${JSON.stringify(c)}.`, { start, end: i + 1 }));
  }
  tokens.push({ kind: "eof", span: { start: text.length, end: text.length } });
  return { ok: true, tokens };
}

export function describeToken(t: Token): string {
  switch (t.kind) {
    case "keyword":
    case "ident":
      return `"${t.value}"`;
    case "string":
      return "a string literal";
    case "number":
      return "a number literal";
    case "lparen":
      return '"("';
    case "rparen":
      return '")"';
    case "lbrace":
      return '"{"';
    case "rbrace":
      return '"}"';
    case "eof":
      return "the end of the rule";
  }
}
