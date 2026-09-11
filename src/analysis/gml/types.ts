/**
 * The GML static-analysis vocabulary. Every shape produced by the lexer, the macro collector and the
 * scanner is declared here and nowhere else, so `src/analysis/*` and the analysis-record schema cannot
 * drift apart.
 *
 * This vocabulary is deliberately incomplete: GML's dynamic asset/script/instance lookups cannot be
 * resolved statically, and the scanner records them as `unresolved` instead of guessing.
 */

export type TokenKind =
  | "identifier"
  | "number"
  | "string"
  | "template_string"
  | "punctuation"
  | "operator"
  | "comment"
  | "newline";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

/** A location a claim can be attributed to. `snippet` is the trimmed source line. */
export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly snippet: string;
}

export type LiteralValue =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "bool"; readonly value: boolean };

export interface MacroDefinition {
  readonly name: string;
  /** The raw right-hand side as written. */
  readonly value: string;
  /** Resolved only when the value is a literal or another resolvable macro; otherwise `null`. */
  readonly resolved: LiteralValue | null;
  readonly location: SourceLocation;
}

export interface MacroTable {
  readonly definitions: Readonly<Record<string, MacroDefinition>>;
  /** Macros whose value could not be resolved to a literal, reported rather than guessed. */
  readonly unresolvedMacroNames: readonly string[];
}

/** `confirmed` = literally present in the source. `inferred` = derived from a resolvable macro. */
export type Confidence = "confirmed" | "inferred";

export interface CallSite {
  readonly name: string;
  readonly argumentCount: number;
  readonly location: SourceLocation;
}

export interface MemberCallSite {
  readonly receiver: string;
  readonly name: string;
  readonly argumentCount: number;
  readonly location: SourceLocation;
}

export interface InstanceCreation {
  readonly functionName: string;
  /** Literal object name, macro-resolved name, or `null` when the argument is not statically known. */
  readonly objectName: string | null;
  readonly confidence: Confidence;
  readonly location: SourceLocation;
}

export interface InstanceDestruction {
  readonly functionName: string;
  readonly location: SourceLocation;
}

export interface WithBlock {
  readonly expression: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly location: SourceLocation;
}

export interface GlobalAccess {
  readonly name: string;
  readonly location: SourceLocation;
}

export interface RoomReference {
  readonly functionName: string;
  readonly roomName: string | null;
  /** True when the room name came from an expression or macro rather than a literal identifier. */
  readonly inferred: boolean;
  readonly location: SourceLocation;
}

export interface ResourceReference {
  readonly name: string;
  readonly location: SourceLocation;
}

export interface InheritanceCall {
  readonly name: string;
  readonly location: SourceLocation;
}

/** A function declared in a file. GameMaker 2.3+ puts functions inside script resources. */
export interface FunctionDefinition {
  readonly name: string;
  readonly location: SourceLocation;
}

/** A reference the scanner refuses to resolve, with the reason it refused. */
export interface UnresolvedReference {
  readonly symbol: string;
  readonly reason: string;
  readonly location: SourceLocation;
}

export interface ScanResult {
  readonly path: string;
  readonly calls: readonly CallSite[];
  readonly memberCalls: readonly MemberCallSite[];
  readonly instanceCreates: readonly InstanceCreation[];
  readonly instanceDestroys: readonly InstanceDestruction[];
  readonly withBlocks: readonly WithBlock[];
  readonly globalReads: readonly GlobalAccess[];
  readonly globalWrites: readonly GlobalAccess[];
  readonly roomRefs: readonly RoomReference[];
  readonly resourceRefs: readonly ResourceReference[];
  readonly inheritanceCalls: readonly InheritanceCall[];
  /** Functions declared in this file, so a call to a function can resolve to its owning script. */
  readonly functionDefinitions: readonly FunctionDefinition[];
  readonly unresolved: readonly UnresolvedReference[];
}

export const EMPTY_SCAN_RESULT = (path: string): ScanResult => ({
  path,
  calls: [],
  memberCalls: [],
  instanceCreates: [],
  instanceDestroys: [],
  withBlocks: [],
  globalReads: [],
  globalWrites: [],
  roomRefs: [],
  resourceRefs: [],
  inheritanceCalls: [],
  functionDefinitions: [],
  unresolved: [],
});

/** Functions that create instances; the first argument names the object. */
export const INSTANCE_CREATE_FUNCTIONS: readonly string[] = [
  "instance_create_layer",
  "instance_create_depth",
  "instance_create",
];

export const INSTANCE_DESTROY_FUNCTIONS: readonly string[] = ["instance_destroy"];

export const INSTANCE_DEACTIVATE_PREFIX = "instance_deactivate_";
export const INSTANCE_ACTIVATE_PREFIX = "instance_activate_";

export const ROOM_FUNCTIONS: readonly string[] = [
  "room_goto",
  "room_goto_next",
  "room_goto_previous",
  "room_restart",
  "room_set_width",
  "room_set_height",
  "room_set_persistent",
  "room_set_view_enabled",
];

/** Calls whose target cannot be known statically; recorded verbatim, never resolved by guessing. */
export const DYNAMIC_LOOKUP_FUNCTIONS: readonly string[] = [
  "script_execute",
  "asset_get_index",
  "asset_get_type",
  "variable_instance_get",
  "variable_instance_set",
  "variable_struct_get",
  "variable_struct_set",
  "method",
];

export const GLOBAL_VARIABLE_FUNCTIONS: readonly string[] = ["variable_global_get", "variable_global_set"];

export const INHERITANCE_FUNCTIONS: readonly string[] = ["event_inherited", "event_perform", "event_user"];
