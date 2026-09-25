// Recursive descent parser for the Rules language subset.
//
//   expression = or_expr ;
//   or_expr    = and_expr { "or" and_expr } ;
//   and_expr   = not_expr { "and" not_expr } ;
//   not_expr   = [ "not" ] primary ;
//   primary    = "(" expression ")" | comparison ;
//   comparison = term ( "eq" | "ne" | "contains" ) literal
//              | term "in" "{" literal { literal } "}" ;
//   term       = field | "lower" "(" field ")" ;
//   literal    = string_lit | number_lit ;
//
// One method per production. `and` and `or` are left associative. Precedence, tightest first:
// lower(), not, and, or.
//
// The grammar here is syntactic. Which literal type goes with which field is the type
// checker's job, so a type error gets a precise diagnostic instead of "unexpected token". Two
// type errors cannot be represented in RuleAST at all (contains on a number field, contains
// with a number literal), so the parser reports those two itself.

import type { Diagnostic, RuleAST, RuleField, Span } from "../types";
import { diag } from "./diagnostics";
import { isRuleField, isStringField, LIMITS } from "./fields";
import { describeToken, lex, type Token } from "./lexer";
import { type NodeParts, type SpanMap, spansByPath } from "./spans";

export type ParseResult =
  | { ok: true; ast: RuleAST; spans: SpanMap }
  | { ok: false; diagnostics: Diagnostic[] };

class ParseError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

export function parse(text: string): ParseResult {
  const lexed = lex(text);
  if (!lexed.ok) return lexed;
  const p = new Parser(lexed.tokens);
  try {
    const ast = p.expression(0);
    p.expectEnd();
    return { ok: true, ast, spans: spansByPath(ast, p.nodeSpans, p.parts) };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, diagnostics: [e.diagnostic] };
    throw e;
  }
}

class Parser {
  readonly nodeSpans = new WeakMap<RuleAST, Span>();
  readonly parts = new WeakMap<RuleAST, NodeParts>();
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    const t = this.tokens[Math.min(this.pos, this.tokens.length - 1)];
    if (!t) throw new Error("token stream is empty; the lexer always emits eof");
    return t;
  }

  private advance(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  private atKeyword(value: string): boolean {
    const t = this.peek();
    return t.kind === "keyword" && t.value === value;
  }

  private fail(expected: string): never {
    const t = this.peek();
    const code = t.kind === "eof" ? "E_UNEXPECTED_EOF" : "E_UNEXPECTED_TOKEN";
    throw new ParseError(diag(code, `Expected ${expected}, found ${describeToken(t)}.`, t.span));
  }

  private expect(kind: Token["kind"], expected: string): Token {
    if (this.peek().kind !== kind) this.fail(expected);
    return this.advance();
  }

  private spanOf(node: RuleAST): Span {
    const s = this.nodeSpans.get(node);
    if (!s) throw new Error("parser recorded no span for a node it built");
    return s;
  }

  /** Every node the parser builds goes through here, so every node has a span. */
  private node<T extends RuleAST>(ast: T, span: Span): T {
    this.nodeSpans.set(ast, span);
    return ast;
  }

  private guardDepth(depth: number, span: Span): void {
    // Bounds recursion on hostile input like "((((((...". The structural caps in limits.ts
    // are checked again on the finished AST.
    if (depth > LIMITS.maxDepth) {
      throw new ParseError(diag("E_AST_TOO_DEEP", `Limit is ${LIMITS.maxDepth}.`, span));
    }
  }

  expectEnd(): void {
    const t = this.peek();
    if (t.kind !== "eof") throw new ParseError(diag("E_TRAILING_INPUT", `Found ${describeToken(t)}.`, t.span));
  }

  // expression = or_expr
  expression(depth: number): RuleAST {
    return this.binary("or", () => this.binary("and", () => this.notExpr(depth), depth), depth);
  }

  // or_expr  = and_expr { "or" and_expr }
  // and_expr = not_expr { "and" not_expr }
  // Same shape at both levels, folded to the left: a op b op c is (a op b) op c.
  private binary(op: "or" | "and", operand: () => RuleAST, depth: number): RuleAST {
    let left = operand();
    let chain = 1;
    while (this.atKeyword(op)) {
      this.advance();
      const right = operand();
      chain++;
      const span = { start: this.spanOf(left).start, end: this.spanOf(right).end };
      this.guardDepth(depth + chain, span);
      left = this.node({ kind: op, left, right }, span);
    }
    return left;
  }

  // not_expr = [ "not" ] primary
  private notExpr(depth: number): RuleAST {
    if (!this.atKeyword("not")) return this.primary(depth);
    const notTok = this.advance();
    this.guardDepth(depth + 1, notTok.span);
    const operand = this.primary(depth + 1);
    return this.node({ kind: "not", operand }, { start: notTok.span.start, end: this.spanOf(operand).end });
  }

  // primary = "(" expression ")" | comparison
  private primary(depth: number): RuleAST {
    const open = this.peek();
    if (open.kind !== "lparen") return this.comparison();
    this.advance();
    this.guardDepth(depth + 1, open.span);
    const inner = this.expression(depth + 1);
    const close = this.expect("rparen", '")"');
    // Parentheses are not an AST node. Widen the inner node's span to cover them so a
    // highlighted group shows its parentheses.
    this.nodeSpans.set(inner, { start: open.span.start, end: close.span.end });
    return inner;
  }

  // term = field | "lower" "(" field ")"
  private term(): { field: RuleField; fieldSpan: Span; lower: boolean; span: Span } {
    const t = this.peek();
    if (t.kind === "keyword" && t.value === "lower") {
      this.advance();
      this.expect("lparen", '"(" after lower');
      const f = this.field();
      const close = this.expect("rparen", '")" after the field');
      return { field: f.field, fieldSpan: f.span, lower: true, span: { start: t.span.start, end: close.span.end } };
    }
    const f = this.field();
    return { field: f.field, fieldSpan: f.span, lower: false, span: f.span };
  }

  private field(): { field: RuleField; span: Span } {
    const t = this.peek();
    if (t.kind !== "ident") this.fail("a field name");
    this.advance();
    if (!isRuleField(t.value)) throw new ParseError(diag("E_UNKNOWN_FIELD", `Found "${t.value}".`, t.span));
    return { field: t.value, span: t.span };
  }

  private literal(): { value: string | number; span: Span } {
    const t = this.peek();
    if (t.kind !== "string" && t.kind !== "number") this.fail("a string or number literal");
    this.advance();
    return { value: t.value, span: t.span };
  }

  // comparison = term ( "eq" | "ne" | "contains" ) literal | term "in" "{" literal { literal } "}"
  private comparison(): RuleAST {
    const term = this.term();
    const opTok = this.peek();
    if (opTok.kind === "ident") {
      // A word in operator position that is not ours, such as "matches" or "gt".
      throw new ParseError(diag("E_UNKNOWN_OPERATOR", `Found "${opTok.value}".`, opTok.span));
    }
    if (opTok.kind !== "keyword") this.fail('an operator: "eq", "ne", "contains" or "in"');
    const lower = term.lower ? { lower: true as const } : {};

    switch (opTok.value) {
      case "in": {
        this.advance();
        const open = this.expect("lbrace", '"{" to start a set');
        const values: Array<string | number> = [];
        const valueSpans: Span[] = [];
        while (this.peek().kind !== "rbrace") {
          if (this.peek().kind === "eof") this.fail('"}" to close the set');
          const lit = this.literal();
          values.push(lit.value);
          valueSpans.push(lit.span);
        }
        const close = this.advance();
        const setSpan = { start: open.span.start, end: close.span.end };
        const ast = this.node({ kind: "in", field: term.field, values, ...lower }, { start: term.span.start, end: close.span.end });
        this.parts.set(ast, { field: term.fieldSpan, values: valueSpans, set: setSpan });
        return ast;
      }
      case "contains": {
        this.advance();
        const lit = this.literal();
        if (!isStringField(term.field)) {
          throw new ParseError(diag("E_CONTAINS_ON_NUMBER", `Field is ${term.field}.`, term.fieldSpan));
        }
        if (typeof lit.value !== "string") {
          throw new ParseError(diag("E_TYPE_MISMATCH", "contains needs a string literal.", lit.span));
        }
        const ast = this.node(
          { kind: "contains", field: term.field, value: lit.value, ...lower },
          { start: term.span.start, end: lit.span.end },
        );
        this.parts.set(ast, { field: term.fieldSpan, value: lit.span });
        return ast;
      }
      case "eq":
      case "ne": {
        this.advance();
        const lit = this.literal();
        const ast = this.node(
          { kind: "compare", field: term.field, op: opTok.value, value: lit.value, ...lower },
          { start: term.span.start, end: lit.span.end },
        );
        this.parts.set(ast, { field: term.fieldSpan, value: lit.span });
        return ast;
      }
      default:
        return this.fail('an operator: "eq", "ne", "contains" or "in"');
    }
  }
}
