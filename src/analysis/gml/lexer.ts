import type { Token, TokenKind } from "./types.ts";

/**
 * GML tokenizer. Every token carries a 1-based `line`/`column`, including comments and newlines,
 * because analysis records attribute claims to exact source locations.
 *
 * The lexer is deliberately faithful rather than clever: `#macro` is not special-cased here (the
 * `#` is punctuation and `macro` an identifier — `macros.ts` reassembles the directive), a leading
 * `-` is always an operator, and an unrecognised character becomes an `operator` token instead of
 * being dropped.
 */

/** Every symbol the lexer recognises. Longest match wins, so 3-char forms are checked first. */
const SYMBOL_KINDS: Readonly<Record<string, TokenKind>> = {
  "<<=": "operator",
  ">>=": "operator",
  "??=": "operator",
  "<<": "operator",
  ">>": "operator",
  "&&": "operator",
  "||": "operator",
  "==": "operator",
  "!=": "operator",
  "<=": "operator",
  ">=": "operator",
  "+=": "operator",
  "-=": "operator",
  "*=": "operator",
  "/=": "operator",
  "%=": "operator",
  "&=": "operator",
  "|=": "operator",
  "^=": "operator",
  "++": "operator",
  "--": "operator",
  "??": "operator",
  "?.": "operator",
  "=": "operator",
  "!": "operator",
  "<": "operator",
  ">": "operator",
  "+": "operator",
  "-": "operator",
  "*": "operator",
  "/": "operator",
  "%": "operator",
  "&": "operator",
  "|": "operator",
  "^": "operator",
  "?": "operator",
  "~": "operator",
  "(": "punctuation",
  ")": "punctuation",
  "{": "punctuation",
  "}": "punctuation",
  "[": "punctuation",
  "]": "punctuation",
  ",": "punctuation",
  ";": "punctuation",
  ":": "punctuation",
  ".": "punctuation",
};

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

const isHexDigit = (ch: string): boolean =>
  isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");

const isIdentifierStart = (ch: string): boolean =>
  (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";

const isIdentifierPart = (ch: string): boolean => isIdentifierStart(ch) || isDigit(ch);

function matchSymbol(source: string, index: number): { text: string; kind: TokenKind } | undefined {
  for (const length of [3, 2, 1]) {
    const candidate = source.slice(index, index + length);
    const kind = SYMBOL_KINDS[candidate];
    if (kind !== undefined) return { text: candidate, kind };
  }
  return undefined;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const total = source.length;
  let index = 0;
  let line = 1;
  let column = 1;

  const advance = (amount: number): void => {
    for (let step = 0; step < amount && index < total; step += 1) {
      const ch = source[index];
      index += 1;
      if (ch === "\n") {
        line += 1;
        column = 1;
      } else if (ch === "\r") {
        // A lone `\r` is a line break; inside `\r\n` the `\n` performs the break.
        if (source[index] === "\n") column += 1;
        else {
          line += 1;
          column = 1;
        }
      } else {
        column += 1;
      }
    }
  };

  const emit = (kind: TokenKind, startLine: number, startColumn: number, startIndex: number): void => {
    tokens.push({ kind, text: source.slice(startIndex, index), line: startLine, column: startColumn });
  };

  const scanQuoted = (quote: string, escapes: boolean): void => {
    advance(1);
    while (index < total) {
      const ch = source[index] ?? "";
      if (escapes && ch === "\\") {
        advance(2);
        continue;
      }
      advance(1);
      if (ch === quote) return;
    }
  };

  const scanNumber = (): void => {
    if (source[index] === "0" && (source[index + 1] === "x" || source[index + 1] === "X")) {
      advance(2);
      while (index < total && isHexDigit(source[index] ?? "")) advance(1);
      return;
    }
    while (index < total && isDigit(source[index] ?? "")) advance(1);
    if (source[index] === "." && isDigit(source[index + 1] ?? "")) {
      advance(1);
      while (index < total && isDigit(source[index] ?? "")) advance(1);
    }
    const exponent = source[index];
    if (exponent === "e" || exponent === "E") {
      const next = source[index + 1] ?? "";
      const signed = (next === "+" || next === "-") && isDigit(source[index + 2] ?? "");
      if (isDigit(next) || signed) {
        advance(1);
        if (source[index] === "+" || source[index] === "-") advance(1);
        while (index < total && isDigit(source[index] ?? "")) advance(1);
      }
    }
  };

  while (index < total) {
    const ch = source[index] ?? "";
    const startLine = line;
    const startColumn = column;
    const startIndex = index;

    if (ch === " " || ch === "\t" || ch === "\v" || ch === "\f" || ch === "\uFEFF") {
      advance(1);
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      advance(1);
      if (ch === "\r" && source[index] === "\n") advance(1);
      emit("newline", startLine, startColumn, startIndex);
      continue;
    }

    if (ch === "/" && source[index + 1] === "/") {
      while (index < total && source[index] !== "\n" && source[index] !== "\r") advance(1);
      emit("comment", startLine, startColumn, startIndex);
      continue;
    }

    if (ch === "/" && source[index + 1] === "*") {
      let depth = 0;
      while (index < total) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1;
          advance(2);
          continue;
        }
        if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1;
          advance(2);
          if (depth === 0) break;
          continue;
        }
        advance(1);
      }
      emit("comment", startLine, startColumn, startIndex);
      continue;
    }

    if (ch === "#") {
      advance(1);
      emit("punctuation", startLine, startColumn, startIndex);
      continue;
    }

    if (ch === "@" && (source[index + 1] === '"' || source[index + 1] === "'")) {
      advance(1);
      scanQuoted(source[index] ?? '"', false);
      emit("string", startLine, startColumn, startIndex);
      continue;
    }

    if (ch === "$" && (source[index + 1] === '"' || source[index + 1] === "'")) {
      advance(1);
      scanQuoted(source[index] ?? '"', true);
      emit("template_string", startLine, startColumn, startIndex);
      continue;
    }

    if (ch === '"' || ch === "'") {
      scanQuoted(ch, true);
      emit("string", startLine, startColumn, startIndex);
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(source[index + 1] ?? ""))) {
      scanNumber();
      emit("number", startLine, startColumn, startIndex);
      continue;
    }

    if (isIdentifierStart(ch)) {
      while (index < total && isIdentifierPart(source[index] ?? "")) advance(1);
      emit("identifier", startLine, startColumn, startIndex);
      continue;
    }

    const symbol = matchSymbol(source, index);
    if (symbol !== undefined) {
      advance(symbol.text.length);
      emit(symbol.kind, startLine, startColumn, startIndex);
      continue;
    }

    advance(1);
    emit("operator", startLine, startColumn, startIndex);
  }

  return tokens;
}

/** Byte offset of the start of each 1-based line, matching the lexer's line/column rules. */
export function lineStarts(source: string): readonly number[] {
  const starts: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "\n") starts.push(index + 1);
    else if (ch === "\r" && source[index + 1] !== "\n") starts.push(index + 1);
  }
  return starts;
}

/** Byte offset of a token's first character. */
export function offsetOf(starts: readonly number[], token: Token): number {
  const lineStart = starts[token.line - 1];
  return (lineStart ?? 0) + token.column - 1;
}

/** The trimmed source line containing `offset`; used as the `snippet` of a `SourceLocation`. */
export function snippetAt(source: string, offset: number): string {
  const before = Math.max(offset - 1, 0);
  let start = source.lastIndexOf("\n", before) + 1;
  const carriageReturn = source.lastIndexOf("\r", before);
  if (carriageReturn >= start) start = carriageReturn + 1;
  let end = source.indexOf("\n", offset);
  const nextCarriageReturn = source.indexOf("\r", offset);
  if (nextCarriageReturn !== -1 && (end === -1 || nextCarriageReturn < end)) end = nextCarriageReturn;
  if (end === -1) end = source.length;
  return source.slice(start, end).trim();
}
