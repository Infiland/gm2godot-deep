import { lineStarts, offsetOf, snippetAt, tokenize } from "./lexer.ts";
import { applyMacroString, resolveMacro } from "./macros.ts";
import {
  DYNAMIC_LOOKUP_FUNCTIONS,
  GLOBAL_VARIABLE_FUNCTIONS,
  INHERITANCE_FUNCTIONS,
  INSTANCE_ACTIVATE_PREFIX,
  INSTANCE_CREATE_FUNCTIONS,
  INSTANCE_DEACTIVATE_PREFIX,
  INSTANCE_DESTROY_FUNCTIONS,
  ROOM_FUNCTIONS,
} from "./types.ts";
import type {
  CallSite,
  FunctionDefinition,
  GlobalAccess,
  InheritanceCall,
  InstanceCreation,
  InstanceDestruction,
  MacroTable,
  MemberCallSite,
  ResourceReference,
  RoomReference,
  ScanResult,
  SourceLocation,
  Token,
  UnresolvedReference,
  WithBlock,
} from "./types.ts";

/**
 * Conservative single-pass GML scanner.
 *
 * The scanner produces *references*, never resolutions it cannot prove: dynamic asset/script
 * lookups, computed `with` targets and calls to unknown names are recorded as `unresolved` with the
 * reason, so downstream dependency analysis can carry the uncertainty instead of inventing an edge.
 */

/** The resource names a unit may reference, grouped by kind. All sets are optional in the source. */
export interface KnownNames {
  readonly scripts: ReadonlySet<string>;
  readonly objects: ReadonlySet<string>;
  readonly rooms: ReadonlySet<string>;
  readonly sprites: ReadonlySet<string>;
  readonly sounds: ReadonlySet<string>;
  readonly fonts: ReadonlySet<string>;
  readonly tilesets: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
  readonly sequences: ReadonlySet<string>;
  readonly shaders: ReadonlySet<string>;
  readonly extensionFunctions: ReadonlySet<string>;
  readonly gmlApi: ReadonlySet<string>;
}

/** Adapt a plain inventory-shaped object (for example the bridge's `inventory` payload) to `KnownNames`. */
export function knownNamesFromInventory(inventoryLike: {
  readonly scripts?: readonly { readonly name: string }[] | undefined;
  readonly objects?: readonly { readonly name: string }[] | undefined;
  readonly rooms?: readonly { readonly name: string }[] | undefined;
  readonly sprites?: readonly { readonly name: string }[] | undefined;
  readonly sounds?: readonly { readonly name: string }[] | undefined;
  readonly fonts?: readonly { readonly name: string }[] | undefined;
  readonly tilesets?: readonly { readonly name: string }[] | undefined;
  readonly paths?: readonly { readonly name: string }[] | undefined;
  readonly sequences?: readonly { readonly name: string }[] | undefined;
  readonly shaders?: readonly { readonly name: string }[] | undefined;
  readonly extensions?:
    | readonly {
        readonly name: string;
        readonly functions?: readonly { readonly name: string }[] | undefined;
      }[]
    | undefined;
  readonly gmlApiEntries?: readonly { readonly name: string }[] | undefined;
}): KnownNames {
  const collect = (entries: readonly { readonly name: string }[] | undefined): ReadonlySet<string> =>
    new Set((entries ?? []).map((entry) => entry.name));
  const extensionFunctions = new Set<string>();
  for (const extension of inventoryLike.extensions ?? []) {
    for (const fn of extension.functions ?? []) extensionFunctions.add(fn.name);
  }
  return {
    scripts: collect(inventoryLike.scripts),
    objects: collect(inventoryLike.objects),
    rooms: collect(inventoryLike.rooms),
    sprites: collect(inventoryLike.sprites),
    sounds: collect(inventoryLike.sounds),
    fonts: collect(inventoryLike.fonts),
    tilesets: collect(inventoryLike.tilesets),
    paths: collect(inventoryLike.paths),
    sequences: collect(inventoryLike.sequences),
    shaders: collect(inventoryLike.shaders),
    extensionFunctions,
    gmlApi: collect(inventoryLike.gmlApiEntries),
  };
}

const INSTANCE_CREATE_SET: ReadonlySet<string> = new Set(INSTANCE_CREATE_FUNCTIONS);
const INSTANCE_DESTROY_SET: ReadonlySet<string> = new Set(INSTANCE_DESTROY_FUNCTIONS);
const ROOM_FUNCTION_SET: ReadonlySet<string> = new Set(ROOM_FUNCTIONS);
const GLOBAL_VARIABLE_SET: ReadonlySet<string> = new Set(GLOBAL_VARIABLE_FUNCTIONS);
const INHERITANCE_SET: ReadonlySet<string> = new Set(INHERITANCE_FUNCTIONS);
const DYNAMIC_LOOKUP_SET: ReadonlySet<string> = new Set(DYNAMIC_LOOKUP_FUNCTIONS);

/** Room functions that take no room argument. */
const ROOMS_WITHOUT_ARGUMENT: ReadonlySet<string> = new Set([
  "room_goto_next",
  "room_goto_previous",
  "room_restart",
]);

/** Resource kinds that become `resourceRefs`; objects/rooms/scripts have dedicated rules. */
const RESOURCE_KINDS: readonly (keyof KnownNames)[] = [
  "sprites",
  "sounds",
  "fonts",
  "tilesets",
  "paths",
  "sequences",
  "shaders",
];

const LANGUAGE_KEYWORDS: ReadonlySet<string> = new Set([
  "var",
  "globalvar",
  "global",
  "function",
  "with",
  "if",
  "else",
  "while",
  "for",
  "do",
  "until",
  "repeat",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "exit",
  "try",
  "catch",
  "finally",
  "throw",
  "new",
  "delete",
  "static",
  "enum",
  "div",
  "mod",
  "and",
  "or",
  "not",
  "xor",
  "self",
  "other",
  "all",
  "noone",
  "true",
  "false",
  "undefined",
]);

const COMPOUND_ASSIGN_OPERATORS: ReadonlySet<string> = new Set([
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
]);

function globalAccessKind(after: Token | undefined): { read: boolean; write: boolean } {
  if (after === undefined || after.kind !== "operator") return { read: true, write: false };
  if (COMPOUND_ASSIGN_OPERATORS.has(after.text) || after.text === "++" || after.text === "--") {
    return { read: true, write: true };
  }
  if (after.text === "=") return { read: false, write: true };
  return { read: true, write: false };
}

function dynamicLookupReason(name: string): string {
  if (name === "script_execute") return "script_execute target is not statically known";
  if (name === "asset_get_index") return "asset_get_index argument is not a literal asset name";
  if (name === "asset_get_type") return "asset_get_type argument is not a literal asset name";
  if (name === "method") return "method() target is not statically known";
  return `${name} target name is not statically known`;
}

export function scanGml(
  path: string,
  source: string,
  macros: MacroTable,
  known: KnownNames,
): ScanResult {
  const tokens = tokenize(source);
  const starts = lineStarts(source);

  const calls: CallSite[] = [];
  const memberCalls: MemberCallSite[] = [];
  const instanceCreates: InstanceCreation[] = [];
  const instanceDestroys: InstanceDestruction[] = [];
  const withBlocks: WithBlock[] = [];
  const globalReads: GlobalAccess[] = [];
  const globalWrites: GlobalAccess[] = [];
  const roomRefs: RoomReference[] = [];
  const resourceRefs: ResourceReference[] = [];
  const inheritanceCalls: InheritanceCall[] = [];
  const functionDefinitions: FunctionDefinition[] = [];
  const unresolved: UnresolvedReference[] = [];

  const significant: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.kind === "comment" || token.kind === "newline") continue;
    significant.push(index);
  }
  const count = significant.length;
  const tokenAt = (position: number): Token | undefined => {
    const index = significant[position];
    return index === undefined ? undefined : tokens[index];
  };
  const located = (token: Token): SourceLocation => ({
    path,
    line: token.line,
    column: token.column,
    snippet: snippetAt(source, offsetOf(starts, token)),
  });
  const rawText = (list: readonly Token[]): string => {
    const first = list[0];
    const last = list[list.length - 1];
    if (first === undefined || last === undefined) return "";
    return source.slice(offsetOf(starts, first), offsetOf(starts, last) + last.text.length).trim();
  };
  const spanTokens = (span: { start: number; end: number }): Token[] => {
    const list: Token[] = [];
    for (let position = span.start; position < span.end; position += 1) {
      const token = tokenAt(position);
      if (token !== undefined) list.push(token);
    }
    return list;
  };

  const argumentsOf = (openPosition: number): { start: number; end: number }[] => {
    const spans: { start: number; end: number }[] = [];
    let depth = 0;
    let start = -1;
    for (let position = openPosition + 1; position < count; position += 1) {
      const token = tokenAt(position);
      if (token === undefined) break;
      if (token.kind === "punctuation") {
        if (token.text === "(" || token.text === "[" || token.text === "{") {
          if (start === -1) start = position;
          depth += 1;
          continue;
        }
        if (token.text === ")" || token.text === "]" || token.text === "}") {
          if (depth === 0) {
            if (start !== -1) spans.push({ start, end: position });
            return spans;
          }
          depth -= 1;
          continue;
        }
        if (token.text === "," && depth === 0) {
          if (start !== -1) spans.push({ start, end: position });
          start = -1;
          continue;
        }
      }
      if (start === -1) start = position;
    }
    if (start !== -1) spans.push({ start, end: count });
    return spans;
  };

  const matchingClose = (openPosition: number): number | undefined => {
    let depth = 0;
    for (let position = openPosition; position < count; position += 1) {
      const token = tokenAt(position);
      if (token === undefined) break;
      if (token.kind !== "punctuation") continue;
      if (token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
      else if (token.text === ")" || token.text === "]" || token.text === "}") {
        depth -= 1;
        if (depth === 0) return position;
      }
    }
    return undefined;
  };

  const declaredFunctionNames = new Set<string>();
  const recordFunction = (nameToken: Token): void => {
    if (declaredFunctionNames.has(nameToken.text)) return;
    declaredFunctionNames.add(nameToken.text);
    functionDefinitions.push({ name: nameToken.text, location: located(nameToken) });
  };

  // Identifiers sitting directly inside a function parameter list. They are parameters, never
  // top-level declarations, so `NAME = function(…)` must not claim one.
  const parameterPositions = new Set<number>();
  const markParameters = (openPosition: number): void => {
    let depth = 0;
    for (let position = openPosition; position < count; position += 1) {
      const token = tokenAt(position);
      if (token === undefined) break;
      if (token.kind === "punctuation") {
        if (token.text === "(" || token.text === "[" || token.text === "{") {
          depth += 1;
          continue;
        }
        if (token.text === ")" || token.text === "]" || token.text === "}") {
          depth -= 1;
          if (depth === 0) return;
          continue;
        }
        continue;
      }
      if (depth === 1 && token.kind === "identifier") parameterPositions.add(position);
    }
  };

  for (let position = 0; position < count; position += 1) {
    const token = tokenAt(position);
    if (token === undefined || token.kind !== "identifier") continue;
    const text = token.text;
    const previous = tokenAt(position - 1);
    const next = tokenAt(position + 1);
    const followedByParen =
      next !== undefined && next.kind === "punctuation" && next.text === "(";
    const precededByDot =
      previous !== undefined && previous.kind === "punctuation" && previous.text === ".";
    const precededByFunction =
      previous !== undefined && previous.kind === "identifier" && previous.text === "function";

    if (text === "function") {
      // `function NAME(params)` declares NAME; a bare `function(params)` is an expression, not a name.
      const candidate = tokenAt(position + 1);
      const named = candidate !== undefined && candidate.kind === "identifier";
      const open = named ? position + 2 : position + 1;
      const paren = tokenAt(open);
      if (paren !== undefined && paren.kind === "punctuation" && paren.text === "(") {
        markParameters(open);
        if (named && candidate !== undefined) recordFunction(candidate);
      }
      continue;
    }

    if (text === "globalvar") {
      for (let cursor = position + 1; cursor < count; cursor += 1) {
        const declared = tokenAt(cursor);
        if (declared === undefined || declared.line !== token.line) break;
        if (declared.kind === "punctuation" && declared.text === ";") break;
        if (declared.kind === "identifier") {
          globalWrites.push({ name: declared.text, location: located(declared) });
        }
      }
      continue;
    }

    if (text === "global") {
      const dot = next;
      const nameToken = tokenAt(position + 2);
      if (
        dot !== undefined &&
        dot.kind === "punctuation" &&
        dot.text === "." &&
        nameToken !== undefined &&
        nameToken.kind === "identifier"
      ) {
        const access = globalAccessKind(tokenAt(position + 3));
        if (access.read) globalReads.push({ name: nameToken.text, location: located(nameToken) });
        if (access.write) globalWrites.push({ name: nameToken.text, location: located(nameToken) });
      }
      continue;
    }

    if (text === "with" && followedByParen) {
      const close = matchingClose(position + 1);
      const spans = argumentsOf(position + 1);
      const expressionTokens = spans[0] === undefined ? [] : spanTokens(spans[0]);
      const plain =
        expressionTokens.length === 1 &&
        expressionTokens[0] !== undefined &&
        expressionTokens[0].kind === "identifier"
          ? expressionTokens[0].text
          : null;
      const expression = plain ?? rawText(expressionTokens);
      let endLine = token.line;
      if (close !== undefined) {
        const afterClose = tokenAt(close + 1);
        const closeToken = tokenAt(close);
        if (afterClose !== undefined && afterClose.kind === "punctuation" && afterClose.text === "{") {
          const braceClose = matchingClose(close + 1);
          const braceToken = braceClose === undefined ? undefined : tokenAt(braceClose);
          if (braceToken !== undefined) endLine = braceToken.line;
        } else if (closeToken !== undefined) endLine = closeToken.line;
      }
      withBlocks.push({ expression, startLine: token.line, endLine, location: located(token) });
      if (plain === null) {
        unresolved.push({
          symbol: expression,
          reason: `with expression '${expression}' is not a plain identifier`,
          location: located(token),
        });
      }
      continue;
    }

    if (LANGUAGE_KEYWORDS.has(text)) continue;

    // `NAME = function(params)` declares NAME unless NAME is a local/global declaration or a parameter.
    const declaredLocal =
      previous !== undefined &&
      previous.kind === "identifier" &&
      (previous.text === "var" || previous.text === "globalvar" || previous.text === "static");
    if (
      !precededByDot &&
      !precededByFunction &&
      !declaredLocal &&
      !parameterPositions.has(position) &&
      next !== undefined &&
      next.kind === "operator" &&
      next.text === "=" &&
      tokenAt(position + 2)?.text === "function" &&
      tokenAt(position + 3)?.text === "("
    ) {
      recordFunction(token);
      continue;
    }

    if (precededByDot) {
      if (followedByParen) {
        const receiverToken = tokenAt(position - 2);
        memberCalls.push({
          receiver: receiverToken?.kind === "identifier" ? receiverToken.text : "",
          name: text,
          argumentCount: argumentsOf(position + 1).length,
          location: located(token),
        });
      }
      continue;
    }

    if (precededByFunction) continue;

    if (!followedByParen) {
      for (const kind of RESOURCE_KINDS) {
        if (known[kind].has(text)) {
          resourceRefs.push({ name: text, location: located(token) });
          break;
        }
      }
      continue;
    }

    const location = located(token);
    const spans = argumentsOf(position + 1);
    calls.push({ name: text, argumentCount: spans.length, location });

    if (INSTANCE_CREATE_SET.has(text)) {
      const span = spans[spans.length - 1];
      const argumentTokens = span === undefined ? [] : spanTokens(span);
      const argumentText = rawText(argumentTokens);
      let objectName: string | null = null;
      const single = argumentTokens[0];
      if (argumentTokens.length === 1 && single !== undefined) {
        if (single.kind === "identifier" && known.objects.has(single.text)) {
          objectName = single.text;
        } else if (single.kind === "identifier") {
          const macro = resolveMacro(macros, single.text);
          if (macro !== null && macro.type === "string") objectName = macro.value;
        } else if (single.kind === "string") {
          const literal = applyMacroString(macros, single.text);
          if (literal !== null) objectName = literal;
        }
      }
      instanceCreates.push({ functionName: text, objectName, confidence: "confirmed", location });
      if (objectName === null) {
        unresolved.push({
          symbol: argumentText === "" ? text : argumentText,
          reason: `${text} object argument '${
            argumentText === "" ? "(missing)" : argumentText
          }' is not a literal object name, a known object or a resolvable macro`,
          location,
        });
      }
      continue;
    }

    if (
      INSTANCE_DESTROY_SET.has(text) ||
      text.startsWith(INSTANCE_DEACTIVATE_PREFIX) ||
      text.startsWith(INSTANCE_ACTIVATE_PREFIX)
    ) {
      instanceDestroys.push({ functionName: text, location });
      continue;
    }

    if (ROOM_FUNCTION_SET.has(text)) {
      const span = ROOMS_WITHOUT_ARGUMENT.has(text) ? undefined : spans[0];
      const argumentTokens = span === undefined ? [] : spanTokens(span);
      const single = argumentTokens[0];
      let roomName: string | null = null;
      if (argumentTokens.length === 1 && single !== undefined) {
        if (single.kind === "identifier" && known.rooms.has(single.text)) {
          roomName = single.text;
        } else if (single.kind === "identifier") {
          const macro = resolveMacro(macros, single.text);
          if (macro !== null && macro.type === "string") roomName = macro.value;
        } else if (single.kind === "string") {
          const literal = applyMacroString(macros, single.text);
          if (literal !== null) roomName = literal;
        }
      }
      roomRefs.push({
        functionName: text,
        roomName,
        inferred: roomName === null,
        location,
      });
      continue;
    }

    if (INHERITANCE_SET.has(text)) {
      inheritanceCalls.push({ name: text, location });
      continue;
    }

    if (GLOBAL_VARIABLE_SET.has(text)) {
      const span = spans[0];
      const argumentTokens = span === undefined ? [] : spanTokens(span);
      const single = argumentTokens[0];
      const name =
        argumentTokens.length === 1 && single !== undefined && single.kind === "string"
          ? applyMacroString(macros, single.text)
          : null;
      if (name === null || name === "") {
        unresolved.push({
          symbol: text,
          reason: `${text} first argument is not a literal global name`,
          location,
        });
      } else if (text === "variable_global_get") {
        globalReads.push({ name, location });
      } else {
        globalWrites.push({ name, location });
      }
      continue;
    }

    if (DYNAMIC_LOOKUP_SET.has(text)) {
      unresolved.push({ symbol: text, reason: dynamicLookupReason(text), location });
      continue;
    }

    // Call-target resolution is deliberately *not* recorded here. GameMaker 2.3+ declares functions
    // inside script resources, and a call names the function, not the resource: a single file cannot
    // tell a missing function from one declared in another unit. `src/analysis/dependencies.ts` owns
    // that judgement — it sees every unit's `functionDefinitions` — and records the unknown-call-target
    // unresolved entries itself. Flagging every callee here would contradict its confirmed `calls` edges.
  }

  return {
    path,
    calls,
    memberCalls,
    instanceCreates,
    instanceDestroys,
    withBlocks,
    globalReads,
    globalWrites,
    roomRefs,
    resourceRefs,
    inheritanceCalls,
    functionDefinitions,
    unresolved,
  };
}
