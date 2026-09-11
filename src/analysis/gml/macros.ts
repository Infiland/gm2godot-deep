import { lineStarts, offsetOf, snippetAt, tokenize } from "./lexer.ts";
import type { LiteralValue, MacroDefinition, MacroTable, SourceLocation, Token } from "./types.ts";

/**
 * `#macro` collection and resolution.
 *
 * A macro resolves only when its value is a literal (number/string/bool, optionally negated) or the
 * name of another macro that itself resolves. Anything else — expressions, calls, template strings,
 * asset lookups — stays unresolved and is reported by name. The collector never guesses a value.
 */

function parseNumber(text: string): number | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
    const value = Number.parseInt(text.slice(2), 16);
    return Number.isNaN(value) ? null : value;
  }
  if (!/^\d/.test(text) && !/^\.\d/.test(text)) return null;
  const value = Number(text);
  return Number.isNaN(value) ? null : value;
}

function unescape(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index] ?? "";
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const escaped = text[index + 1] ?? "";
    index += 1;
    if (escaped === "n") out += "\n";
    else if (escaped === "r") out += "\r";
    else if (escaped === "t") out += "\t";
    else if (escaped === "0") out += "\0";
    else if (escaped === "u") {
      const hex = text.slice(index + 1, index + 5);
      const code = /^[0-9a-fA-F]{4}$/.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
      if (Number.isNaN(code)) out += "u";
      else {
        out += String.fromCharCode(code);
        index += 4;
      }
    } else out += escaped;
  }
  return out;
}

/** Contents of a string literal token, or `null` when the token is not a plain string literal. */
function stringLiteralValue(text: string): string | null {
  if (text.startsWith('@"') || text.startsWith("@'")) return text.slice(2, -1);
  if (text.startsWith('"') || text.startsWith("'")) {
    if (!text.endsWith(text[0] ?? "")) return null;
    return unescape(text.slice(1, -1));
  }
  return null;
}

interface RawMacro {
  readonly name: string;
  readonly value: string;
  readonly valueTokens: readonly Token[];
  readonly location: SourceLocation;
}

export function collectMacros(
  scans: readonly { readonly path: string; readonly source: string }[],
): MacroTable {
  const raw: Record<string, RawMacro> = {};

  for (const scan of scans) {
    const starts = lineStarts(scan.source);
    const tokens = tokenize(scan.source).filter((token) => token.kind !== "comment");
    for (let index = 0; index + 2 < tokens.length; index += 1) {
      const hash = tokens[index];
      const keyword = tokens[index + 1];
      const name = tokens[index + 2];
      if (hash === undefined || hash.kind !== "punctuation" || hash.text !== "#") continue;
      if (keyword === undefined || keyword.kind !== "identifier" || keyword.text !== "macro") continue;
      if (name === undefined || name.kind !== "identifier") continue;

      const valueTokens: Token[] = [];
      let cursor = index + 3;
      for (; cursor < tokens.length; cursor += 1) {
        const token = tokens[cursor];
        if (token === undefined || token.kind === "newline") break;
        valueTokens.push(token);
      }

      const first = valueTokens[0];
      const last = valueTokens[valueTokens.length - 1];
      const value =
        first === undefined || last === undefined
          ? ""
          : scan.source
              .slice(offsetOf(starts, first), offsetOf(starts, last) + last.text.length)
              .trim();

      raw[name.text] = {
        name: name.text,
        value,
        valueTokens,
        location: {
          path: scan.path,
          line: name.line,
          column: name.column,
          snippet: snippetAt(scan.source, offsetOf(starts, name)),
        },
      };
      index = cursor;
    }
  }

  const resolved: Record<string, LiteralValue | null> = {};

  const resolveTokens = (tokens: readonly Token[], stack: readonly string[]): LiteralValue | null => {
    const first = tokens[0];
    if (first === undefined) return null;
    if (
      tokens.length === 2 &&
      first.kind === "operator" &&
      first.text === "-" &&
      tokens[1]?.kind === "number"
    ) {
      const magnitude = parseNumber(tokens[1].text);
      return magnitude === null ? null : { type: "number", value: -magnitude };
    }
    if (tokens.length !== 1) return null;
    if (first.kind === "number") {
      const value = parseNumber(first.text);
      return value === null ? null : { type: "number", value };
    }
    if (first.kind === "string") {
      const value = stringLiteralValue(first.text);
      return value === null ? null : { type: "string", value };
    }
    if (first.kind === "identifier") {
      if (first.text === "true") return { type: "bool", value: true };
      if (first.text === "false") return { type: "bool", value: false };
      if (raw[first.text] !== undefined) return resolveName(first.text, stack);
    }
    return null;
  };

  const resolveName = (name: string, stack: readonly string[]): LiteralValue | null => {
    const cached = resolved[name];
    if (cached !== undefined) return cached;
    if (stack.includes(name)) return null;
    const definition = raw[name];
    if (definition === undefined) return null;
    const value = resolveTokens(definition.valueTokens, [...stack, name]);
    resolved[name] = value;
    return value;
  };

  const definitions: Record<string, MacroDefinition> = {};
  const unresolvedMacroNames: string[] = [];
  for (const name of Object.keys(raw).sort()) {
    const definition = raw[name];
    if (definition === undefined) continue;
    const value = resolveName(name, []);
    definitions[name] = {
      name,
      value: definition.value,
      resolved: value,
      location: definition.location,
    };
    if (value === null) unresolvedMacroNames.push(name);
  }

  return { definitions, unresolvedMacroNames };
}

export function resolveMacro(table: MacroTable, name: string): LiteralValue | null {
  return table.definitions[name]?.resolved ?? null;
}

/**
 * Resolve `text` to a string using the macro table.
 *
 * Literal string parts and resolvable macros are substituted (`"spr_" + SPR_ID` is not computed —
 * only `+` concatenation of already-known parts is folded). The result is `null` whenever any part
 * cannot be resolved, so callers record an uncertainty instead of a fabricated name.
 */
export function applyMacroString(table: MacroTable, text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const tokens = tokenize(trimmed).filter((token) => token.kind !== "comment" && token.kind !== "newline");
  if (tokens.length === 0) return null;

  let out = "";
  for (const token of tokens) {
    if (token.kind === "string") {
      const value = stringLiteralValue(token.text);
      if (value === null) return null;
      out += value;
      continue;
    }
    if (token.kind === "identifier") {
      const value = resolveMacro(table, token.text);
      if (value === null) return null;
      if (value.type === "string") out += value.value;
      else if (value.type === "number") out += String(value.value);
      else out += value.value ? "true" : "false";
      continue;
    }
    if (token.kind === "operator" && token.text === "+") continue;
    return null;
  }
  return out;
}
