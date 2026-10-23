import { z } from "zod";
import type { ToolDefinition } from "../core/types.js";

const MAX_EXPRESSION_LENGTH = 1_024;
const MAX_TOKENS = 512;
const MAX_DEPTH = 32;

const calculator: ToolDefinition = {
  name: "utility_calculate",
  description: "Evaluates arithmetic with numbers, parentheses, +, -, *, /, %, and **.",
  parameters: {
    type: "object",
    properties: { expression: { type: "string", maxLength: MAX_EXPRESSION_LENGTH } },
    required: ["expression"],
    additionalProperties: false,
  },
  argumentSchema: z.object({ expression: z.string().min(1).max(MAX_EXPRESSION_LENGTH) }).strict(),
  async execute(arguments_) {
    const expression = arguments_["expression"];
    if (typeof expression !== "string") throw new Error("Calculator expression must be a string");
    return new Parser(tokenize(expression)).parse();
  },
};

export default calculator;

type Operator = "+" | "-" | "*" | "/" | "%" | "**" | "(" | ")";
type Token = { kind: "number"; value: number } | { kind: "operator"; value: Operator };

function tokenize(expression: string): readonly Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < expression.length;) {
    const character = expression[index];
    if (character === undefined) break;
    if (/\s/u.test(character)) { index += 1; continue; }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(expression.slice(index));
    if (number?.[0] !== undefined) {
      tokens.push({ kind: "number", value: Number(number[0]) });
      index += number[0].length;
    } else if ("+-*/%()".includes(character)) {
      const value = character === "*" && expression[index + 1] === "*" ? "**" : character;
      tokens.push({ kind: "operator", value: value as Operator });
      index += value.length;
    } else {
      throw new Error("Calculator expression contains an unsafe token");
    }
    if (tokens.length > MAX_TOKENS) throw new Error("Calculator expression has too many tokens");
  }
  if (tokens.length === 0) throw new Error("Calculator expression is empty");
  return tokens;
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): number {
    const value = this.sum();
    if (this.peek() !== undefined) throw new Error("Calculator expression is malformed");
    return finite(value);
  }

  private sum(): number {
    let value = this.product();
    while (this.accept("+") || this.accept("-")) {
      const operator = this.tokens[this.index - 1];
      const right = this.product();
      value = finite(operator?.kind === "operator" && operator.value === "+" ? value + right : value - right);
    }
    return value;
  }

  private product(): number {
    let value = this.unary();
    while (this.accept("*") || this.accept("/") || this.accept("%")) {
      const operator = this.tokens[this.index - 1];
      const right = this.unary();
      if ((operator?.value === "/" || operator?.value === "%") && right === 0) throw new Error("Calculator division by zero");
      value = finite(operator?.value === "*" ? value * right : operator?.value === "/" ? value / right : value % right);
    }
    return value;
  }

  private unary(): number {
    if (this.accept("+")) return this.unary();
    if (this.accept("-")) return finite(-this.unary());
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    return this.accept("**") ? finite(base ** this.unary()) : base;
  }

  private primary(): number {
    const token = this.peek();
    if (token?.kind === "number") { this.index += 1; return finite(token.value); }
    if (this.accept("(")) {
      this.depth += 1;
      if (this.depth > MAX_DEPTH) throw new Error("Calculator expression is too deeply nested");
      const value = this.sum();
      this.depth -= 1;
      if (!this.accept(")")) throw new Error("Calculator expression has unclosed parenthesis");
      return value;
    }
    throw new Error("Calculator expression is malformed");
  }

  private accept(value: Operator): boolean {
    const token = this.peek();
    if (token?.kind !== "operator" || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private peek(): Token | undefined { return this.tokens[this.index]; }
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Calculator result is not finite");
  return value;
}
