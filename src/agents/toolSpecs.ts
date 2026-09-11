import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DeepError } from "../util/result.ts";
import { canonicalJson } from "../util/json.ts";
import { sha256Bytes } from "../util/sha256.ts";
import { assertContained, assertNoEscapingLinks, assertSafeRelativePath } from "../workspaces/guards.ts";
import {
  AnalysisRecordSchema,
  PatchRecordPayloadSchema,
  PlanRecordSchema,
  ReviewRecordSchema,
  type ConverterDiagnostic,
} from "../evidence/schemas.ts";
import type { InventoryRecord } from "../indexing/inventory.ts";
import { assertAllowed } from "../integration/allowlist.ts";
import { RESULT_TOOL_NAMES, roleConfig } from "./roles.ts";
import type { ToolContext, ToolOutcome, ToolSpec } from "./runtime.ts";
import type { AgentRoleName, TaskRecord } from "../storage/types.ts";

export const MAX_READ_BYTES = 64 * 1024;
export const MAX_GREP_RESULTS = 200;
export const MAX_EVIDENCE_BYTES = 96 * 1024;

export type ToolRoot = "source" | "baseline" | "port" | "task" | "evidence";

const TEXT_EXTENSIONS = [
  ".gml",
  ".gd",
  ".tscn",
  ".tres",
  ".yy",
  ".yyp",
  ".json",
  ".md",
  ".txt",
  ".cfg",
  ".godot",
  ".csv",
  ".ini",
];

export interface ToolBuildDeps {
  readonly context: ToolContext;
  readonly task: TaskRecord;
  readonly unitId: string;
  readonly unitSourcePaths: readonly string[];
  readonly unitGeneratedOutputs: readonly string[];
  readonly converterDiagnostics: readonly ConverterDiagnostic[];
  readonly inventory: InventoryRecord;
}

function logicalId(root: ToolRoot, relativePath: string): string {
  return `${root}:${relativePath}`;
}

/** Allowlist membership at a path-segment boundary, so `gm2godot/**` never matches `gm2godotX`. */
function allowlistAllows(entries: readonly string[], candidate: string): boolean {
  return entries.some((entry) => {
    if (entry === candidate) return true;
    const normalised = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    return candidate.startsWith(`${normalised}/`);
  });
}

function deny(context: ToolContext, tool: string, reason: string, path?: string): never {
  context.recordPolicyDenial({ tool, reason, ...(path === undefined ? {} : { path }) });
  throw new DeepError("GM2DEEP-TOOL-DENIED", reason, { tool, path: path ?? null });
}

/** Resolve a tool-requested read against the task-scoped roots; deny on any guard violation. */
function resolveRead(deps: ToolBuildDeps, tool: string, root: ToolRoot, relativePath: string): string {
  try {
    assertSafeRelativePath(relativePath, "path");
  } catch (error) {
    deny(deps.context, tool, error instanceof Error ? error.message : String(error), relativePath);
  }
  const rootDir = deps.context.workspaceRoots[root];
  let absolute: string;
  try {
    absolute = assertContained(rootDir, relativePath);
    assertNoEscapingLinks(rootDir, relativePath);
  } catch (error) {
    deny(deps.context, tool, error instanceof Error ? error.message : String(error), relativePath);
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new DeepError("GM2DEEP-TOOL-NOT-FOUND", `${logicalId(root, relativePath)} does not exist`, {
      path: relativePath,
    });
  }
  if (!allowlistAllows(deps.context.allowlist.read, logicalId(root, relativePath))) {
    deny(deps.context, tool, `${logicalId(root, relativePath)} is outside this task's read allowlist`, relativePath);
  }
  return absolute;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n… [truncated at ${limit} characters]`, truncated: true };
}

function allowedTextFiles(deps: ToolBuildDeps, root: ToolRoot): string[] {
  return deps.context.allowlist.read
    .filter((entry) => entry.startsWith(`${root}:`))
    .map((entry) => entry.slice(root.length + 1))
    .filter((candidate) => TEXT_EXTENSIONS.some((extension) => candidate.endsWith(extension)))
    .sort();
}

function grep(deps: ToolBuildDeps, tool: string, root: ToolRoot, pattern: string, maxResults: number): ToolOutcome {
  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch (error) {
    throw new DeepError("GM2DEEP-TOOL-BAD-PATTERN", "pattern is not a valid regular expression", {
      pattern,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const hits: string[] = [];
  let scanned = 0;
  let skipped = 0;
  let truncated = false;
  for (const candidate of allowedTextFiles(deps, root)) {
    let absolute: string;
    try {
      absolute = resolveRead(deps, tool, root, candidate);
    } catch {
      skipped += 1;
      continue;
    }
    scanned += 1;
    const lines = readFileSync(absolute, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] as string;
      if (!expression.test(line)) continue;
      if (hits.length >= maxResults) {
        truncated = true;
        break;
      }
      hits.push(`${logicalId(root, candidate)}:${index + 1}: ${line.trim().slice(0, 400)}`);
    }
    if (truncated) break;
  }
  return {
    text: hits.length === 0 ? "(no matches)" : hits.join("\n"),
    details: { hits: hits.length, scanned, skipped, truncated },
  };
}

const ReadFileArgs = z.strictObject({ path: z.string().min(1) });
const GrepArgs = z.strictObject({
  pattern: z.string().min(1),
  maxResults: z.number().int().positive().max(MAX_GREP_RESULTS).optional(),
});
const ReadEvidenceArgs = z.strictObject({
  artifact: z.enum(["inventory", "gml-api", "analysis", "review", "contracts", "plan", "baseline"]),
  unitId: z.string().min(1).optional(),
  version: z.number().int().positive().optional(),
});

function evidenceOutcome(bytes: string): ToolOutcome {
  const capped = truncate(bytes, MAX_EVIDENCE_BYTES);
  return { text: capped.text, details: { truncated: capped.truncated, bytes: bytes.length } };
}

function resultTool(name: string, schema: z.ZodTypeAny, description: string): ToolSpec {
  return {
    name,
    description,
    schema,
    execute: async (args: unknown): Promise<ToolOutcome> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        throw new DeepError("GM2DEEP-RESULT-INVALID", `the ${name} payload does not match the required schema`, {
          issues: parsed.error.issues.slice(0, 20).map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        });
      }
      return { text: "accepted", details: parsed.data, terminate: true };
    },
  };
}

const AnalystSubmissionSchema = AnalysisRecordSchema.omit({
  unitId: true,
  unitKind: true,
  sourceSnapshotId: true,
  baselineId: true,
  generatedOutputs: true,
  producedBy: true,
});

const ReviewerSubmissionSchema = ReviewRecordSchema.omit({ unitId: true, producedBy: true });

const ReconcilerSubmissionSchema = PlanRecordSchema.omit({ version: true, createdAt: true, producedBy: true });

export const ImplementerSubmissionSchema = PatchRecordPayloadSchema.omit({
  taskId: true,
  attempt: true,
  basePortRevision: true,
  inputHash: true,
  contractVersions: true,
  producedBy: true,
});

export type ImplementerSubmission = z.output<typeof ImplementerSubmissionSchema>;

/** `null` bytes, and brackets that do not balance, cannot be parsed by Godot — reject before publishing. */
export function checkGdSyntax(path: string, content: string): void {
  if (content.includes("\0")) {
    throw new DeepError("GM2DEEP-PATCH-SYNTAX", `${path} contains a NUL byte`);
  }
  const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  let inString: string | null = null;
  let escaped = false;
  for (const character of content) {
    if (inString !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === inString) inString = null;
      continue;
    }
    if (character === '"' || character === "'") {
      inString = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character === ")" || character === "]" || character === "}") {
      if (stack.pop() !== closers[character]) {
        throw new DeepError("GM2DEEP-PATCH-SYNTAX", `${path} has unbalanced brackets`);
      }
    }
  }
  if (stack.length > 0) throw new DeepError("GM2DEEP-PATCH-SYNTAX", `${path} has unbalanced brackets`);
}

/**
 * Validate a proposed patch against the protected paths, the task write allowlist, the declared content
 * hashes and Godot's bracket structure. Called by the `propose_patch` tool and again before publishing,
 * because the payload crosses a process boundary the model controls.
 */
export function validateProposedPatch(task: TaskRecord, submission: ImplementerSubmission): void {
  if (submission.files.length === 0) {
    throw new DeepError("GM2DEEP-PATCH-EMPTY", "a patch must change at least one file");
  }
  const seen = new Set<string>();
  for (const file of submission.files) {
    assertAllowed(task, file.path, file.action);
    if (seen.has(file.path)) {
      throw new DeepError("GM2DEEP-PATCH-DUPLICATE-PATH", `${file.path} appears more than once in the patch`);
    }
    seen.add(file.path);
    const actual = sha256Bytes(Buffer.from(file.content, "utf8"));
    if (actual !== file.contentSha256) {
      throw new DeepError(
        "GM2DEEP-PATCH-CONTENT-HASH",
        `${file.path} declares contentSha256 ${file.contentSha256} but its content hashes to ${actual}`,
      );
    }
    if (file.action === "delete" && file.preimageSha256 === null) {
      throw new DeepError("GM2DEEP-PATCH-BASE-MISMATCH", `${file.path} deletes a file without recording its pre-image hash`);
    }
    if (file.action !== "delete" && file.path.endsWith(".gd")) checkGdSyntax(file.path, file.content);
  }
}

function readEvidence(
  deps: ToolBuildDeps,
  request: { artifact: string; unitId?: string | undefined; version?: number | undefined },
): ToolOutcome {
  const evidenceDir = deps.context.workspaceRoots.evidence;
  const readIfPresent = (relativePath: string): ToolOutcome | null => {
    const absolute = join(evidenceDir, relativePath);
    if (!existsSync(absolute)) return null;
    return evidenceOutcome(readFileSync(absolute, "utf8"));
  };
  const encodedUnit = (unitId: string): string => unitId.replace(/:/g, "%3A").replace(/\//g, "%2F");
  switch (request.artifact) {
    case "inventory":
      return evidenceOutcome(canonicalJson(deps.inventory));
    case "gml-api":
      return readIfPresent("inventory/gml-api.json") ?? { text: "(gml-api manifest not recorded)", details: {} };
    case "baseline":
      return readIfPresent("inventory/baseline.json") ?? { text: "(baseline evidence not recorded)", details: {} };
    case "analysis": {
      const unitId = request.unitId ?? deps.unitId;
      return (
        readIfPresent(`analyses/${encodedUnit(unitId)}.json`) ?? {
          text: `(no analysis recorded for ${unitId})`,
          details: { unitId },
        }
      );
    }
    case "review": {
      const unitId = request.unitId ?? deps.unitId;
      return (
        readIfPresent(`analyses/${encodedUnit(unitId)}.review.json`) ?? {
          text: `(no review recorded for ${unitId})`,
          details: { unitId },
        }
      );
    }
    case "contracts": {
      const directory = join(evidenceDir, "contracts");
      if (!existsSync(directory)) return { text: "(no contracts recorded)", details: {} };
      const bodies = readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => `### ${name}\n${readFileSync(join(directory, name), "utf8")}`);
      return evidenceOutcome(bodies.join("\n"));
    }
    case "plan": {
      const version = request.version;
      if (version !== undefined) {
        return readIfPresent(`plans/plan.v${version}.json`) ?? { text: `(no plan v${version})`, details: { version } };
      }
      const directory = join(evidenceDir, "plans");
      if (!existsSync(directory)) return { text: "(no plan recorded)", details: {} };
      const names = readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort();
      const latest = names[names.length - 1];
      if (latest === undefined) return { text: "(no plan recorded)", details: {} };
      return evidenceOutcome(readFileSync(join(directory, latest), "utf8"));
    }
    default:
      throw new DeepError("GM2DEEP-TOOL-BAD-ARGUMENT", `unknown evidence artifact ${request.artifact}`);
  }
}

/**
 * Build the tool set for a role. Every handler runs in this process, resolves paths through the workspace
 * guards, records a `policy_denied` event and throws on violation, and returns text plus typed details.
 *
 * `propose_patch` only validates and returns the payload: the patch artifact is written by the scheduler
 * once the run's usage is known, so the recorded provenance is the host's, never the model's.
 */
export function buildToolSpecs(role: AgentRoleName, deps: ToolBuildDeps): ToolSpec[] {
  const config = roleConfig(role);

  const readSpec = (name: string, root: ToolRoot, description: string): ToolSpec => ({
    name,
    description,
    schema: ReadFileArgs,
    execute: async (args: unknown): Promise<ToolOutcome> => {
      const { path } = ReadFileArgs.parse(args);
      const absolute = resolveRead(deps, name, root, path);
      const { text, truncated } = truncate(readFileSync(absolute, "utf8"), MAX_READ_BYTES);
      return { text, details: { path: logicalId(root, path), truncated } };
    },
  });

  const available: Record<string, ToolSpec> = {
    read_source: readSpec("read_source", "source", "Read a GameMaker source file from the frozen snapshot."),
    read_generated: readSpec("read_generated", "baseline", "Read a file from the generated Godot baseline."),
    grep_source: {
      name: "grep_source",
      description: "Search the allowed source files with a regular expression.",
      schema: GrepArgs,
      execute: async (args: unknown): Promise<ToolOutcome> => {
        const parsed = GrepArgs.parse(args);
        return grep(deps, "grep_source", "source", parsed.pattern, parsed.maxResults ?? MAX_GREP_RESULTS);
      },
    },
    search_baseline: {
      name: "search_baseline",
      description: "Search the allowed generated baseline files with a regular expression.",
      schema: GrepArgs,
      execute: async (args: unknown): Promise<ToolOutcome> => {
        const parsed = GrepArgs.parse(args);
        return grep(deps, "search_baseline", "baseline", parsed.pattern, parsed.maxResults ?? MAX_GREP_RESULTS);
      },
    },
    get_converter_diagnostics: {
      name: "get_converter_diagnostics",
      description: "Return the GM2Godot diagnostics recorded for this unit.",
      schema: z.strictObject({}),
      execute: async (): Promise<ToolOutcome> =>
        evidenceOutcome(canonicalJson({ unitId: deps.unitId, diagnostics: deps.converterDiagnostics })),
    },
    list_unit_files: {
      name: "list_unit_files",
      description: "List this unit's source files and generated outputs.",
      schema: z.strictObject({}),
      execute: async (): Promise<ToolOutcome> =>
        evidenceOutcome(
          canonicalJson({
            unitId: deps.unitId,
            sourcePaths: deps.unitSourcePaths,
            generatedOutputs: deps.unitGeneratedOutputs,
          }),
        ),
    },
    read_evidence: {
      name: "read_evidence",
      description: "Read a slice of the recorded evidence: inventory, gml-api, analysis, review, contracts, plan, baseline.",
      schema: ReadEvidenceArgs,
      execute: async (args: unknown): Promise<ToolOutcome> => readEvidence(deps, ReadEvidenceArgs.parse(args)),
    },
    [RESULT_TOOL_NAMES.submit_analysis]: resultTool(
      RESULT_TOOL_NAMES.submit_analysis,
      AnalystSubmissionSchema,
      "Submit the analysis record for this unit and end the conversation.",
    ),
    [RESULT_TOOL_NAMES.submit_review]: resultTool(
      RESULT_TOOL_NAMES.submit_review,
      ReviewerSubmissionSchema,
      "Submit the review record and end the conversation.",
    ),
    [RESULT_TOOL_NAMES.submit_plan]: resultTool(
      RESULT_TOOL_NAMES.submit_plan,
      ReconcilerSubmissionSchema,
      "Submit the reconciled plan and end the conversation.",
    ),
    [RESULT_TOOL_NAMES.propose_patch]: {
      name: RESULT_TOOL_NAMES.propose_patch,
      description:
        "Propose a patch for this task. Paths are Godot-project-relative and must stay inside the task's write allowlist.",
      schema: ImplementerSubmissionSchema,
      execute: async (args: unknown): Promise<ToolOutcome> => {
        const submission = ImplementerSubmissionSchema.parse(args);
        try {
          validateProposedPatch(deps.task, submission);
        } catch (error) {
          const failure = error instanceof DeepError ? error : null;
          if (failure !== null && failure.code.startsWith("GM2DEEP-PATCH-")) {
            deps.context.recordPolicyDenial({ tool: RESULT_TOOL_NAMES.propose_patch, reason: failure.message });
          }
          throw error;
        }
        return {
          text: `accepted: ${submission.files.length} file(s) recorded`,
          details: submission,
          terminate: true,
        };
      },
    },
  };

  const missing = config.toolNames.filter((name) => !(name in available));
  if (missing.length > 0) {
    throw new DeepError("GM2DEEP-TOOL-UNKNOWN", `role ${role} requests tools that are not implemented`, { missing });
  }
  return config.toolNames.map((name) => available[name] as ToolSpec);
}
