import { join } from "node:path";
import { z } from "zod";
import { DeepError } from "../../util/result.ts";
import { spawnCapture } from "../../util/proc.ts";
import { repoRoot } from "../../util/package.ts";
import { buildSubprocessEnv } from "../../sandbox/env.ts";
import { assertSupportedToolVersion, SUPPORTED_GM2GODOT_VERSIONS } from "./versions.ts";

export const BRIDGE_API_MISMATCH = "GM2DEEP-BRIDGE-API-MISMATCH";

export interface BridgeOptions {
  readonly checkout: string;
  readonly python: string;
  readonly timeoutSeconds?: number;
  readonly maxOutputBytes?: number;
}

export interface BridgeInvocation {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export const Gm2GodotProbeSchema = z.strictObject({
  gm2godotVersion: z.string().min(1),
  pythonVersion: z.string().min(1),
  pythonExecutable: z.string().min(1),
  checkout: z.string().min(1),
  commit: z.string().nullable(),
});
export type Gm2GodotProbe = z.output<typeof Gm2GodotProbeSchema>;

const ExtensionFunctionSchema = z.strictObject({
  name: z.string(),
  externalName: z.string().nullable(),
  argCount: z.number().int().nullable(),
  fileName: z.string(),
});

export const BridgeInventorySchema = z.strictObject({
  project: z.strictObject({
    name: z.string(),
    yypPath: z.string().nullable(),
    ideVersion: z.string(),
    resourceType: z.string(),
    resourceVersion: z.string(),
  }),
  resources: z.array(
    z.strictObject({
      name: z.string(),
      kind: z.string(),
      typeName: z.string(),
      yypPath: z.string(),
      sourcePaths: z.array(z.string()),
      godotPath: z.string().nullable(),
    }),
  ),
  objects: z.array(
    z.strictObject({
      name: z.string(),
      parentObjectName: z.string().nullable(),
      persistent: z.boolean(),
      solid: z.boolean(),
      spriteName: z.string().nullable(),
      events: z.array(
        z.strictObject({
          eventType: z.number().int(),
          eventNum: z.number().int(),
          file: z.string().nullable(),
        }),
      ),
    }),
  ),
  rooms: z.array(
    z.strictObject({
      name: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      persistent: z.boolean(),
      parentRoomName: z.string().nullable(),
      creationCodeFile: z.string().nullable(),
      ordered: z.boolean(),
      layers: z.array(
        z.strictObject({
          name: z.string(),
          resourceType: z.string(),
          depth: z.number().nullable(),
          order: z.number().int().nullable(),
        }),
      ),
      instances: z.array(
        z.strictObject({
          name: z.string().nullable(),
          objectName: z.string().nullable(),
          x: z.number().nullable(),
          y: z.number().nullable(),
        }),
      ),
    }),
  ),
  scripts: z.array(z.strictObject({ name: z.string(), gmlPath: z.string().nullable() })),
  sprites: z.array(
    z.strictObject({ name: z.string(), width: z.number().int(), height: z.number().int(), frameCount: z.number().int() }),
  ),
  shaders: z.array(
    z.strictObject({ name: z.string(), vertexPath: z.string().nullable(), fragmentPath: z.string().nullable() }),
  ),
  extensions: z.array(z.strictObject({ name: z.string(), functions: z.array(ExtensionFunctionSchema) })),
  diagnostics: z.array(z.unknown()),
});
export type BridgeInventory = z.output<typeof BridgeInventorySchema>;

export const GmlApiEntrySchema = z.strictObject({
  name: z.string(),
  category: z.string(),
  status: z.string(),
  issueNumber: z.number().int(),
  ownerModule: z.string(),
  parserSupport: z.string(),
  emitterSupport: z.string(),
  runtimeSupport: z.string(),
  smokeCoverage: z.string(),
  docsUrl: z.string(),
  notes: z.string(),
});
export type GmlApiEntry = z.output<typeof GmlApiEntrySchema>;

const GmlApiPayloadSchema = z.strictObject({ entries: z.array(GmlApiEntrySchema) });

function bridgeScriptPath(): string {
  return join(repoRoot, "tools", "gm2godot_bridge.py");
}

/** Run the bridge and return raw stdout/stderr with the exit status — no interpretation. */
export async function invokeBridge(options: BridgeOptions, args: readonly string[]): Promise<BridgeInvocation> {
  const argv = [
    options.python,
    bridgeScriptPath(),
    "--checkout",
    options.checkout,
    ...args,
  ];
  const result = await spawnCapture({
    argv,
    cwd: repoRoot,
    env: buildSubprocessEnv({ PYTHONDONTWRITEBYTECODE: "1" }),
    timeoutSeconds: options.timeoutSeconds ?? 300,
    maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024,
  });
  return {
    argv,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };
}

/**
 * Run the bridge, require exit 0, and parse stdout as JSON. A bridge exit of 3 means the pinned
 * GM2Godot API changed shape: that is fatal and must never be downgraded to a partial result.
 */
export async function runBridgeJson(options: BridgeOptions, args: readonly string[]): Promise<unknown> {
  const invocation = await invokeBridge(options, args);
  if (invocation.exitCode !== 0) {
    const mismatch = parseMismatch(invocation.stdout);
    if (invocation.exitCode === 3 || mismatch !== null) {
      throw new DeepError(
        BRIDGE_API_MISMATCH,
        `the pinned GM2Godot API at ${options.checkout} does not expose what the bridge expects`,
        { argv: invocation.argv, detail: mismatch ?? invocation.stdout.slice(0, 2000), stderr: invocation.stderr.slice(0, 2000) },
      );
    }
    throw new DeepError("GM2DEEP-BRIDGE-FAILED", `gm2godot bridge ${args.join(" ")} failed`, {
      argv: invocation.argv,
      exitCode: invocation.exitCode,
      stdout: invocation.stdout.slice(0, 2000),
      stderr: invocation.stderr.slice(0, 4000),
      timedOut: invocation.timedOut,
    });
  }
  try {
    return JSON.parse(invocation.stdout);
  } catch (error) {
    throw new DeepError("GM2DEEP-BRIDGE-MALFORMED", `gm2godot bridge ${args.join(" ")} did not print JSON`, {
      argv: invocation.argv,
      stdout: invocation.stdout.slice(0, 2000),
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseMismatch(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed && parsed.error === "BRIDGE_API_MISMATCH") {
      return "detail" in parsed ? JSON.stringify(parsed.detail) : "BRIDGE_API_MISMATCH";
    }
  } catch {
    return null;
  }
  return null;
}

export async function probeGm2Godot(options: BridgeOptions, expectedVersions: readonly string[] = SUPPORTED_GM2GODOT_VERSIONS): Promise<Gm2GodotProbe> {
  const probe = Gm2GodotProbeSchema.parse(await runBridgeJson(options, ["probe"]));
  assertSupportedToolVersion("GM2Godot", probe.gm2godotVersion, expectedVersions);
  return probe;
}

export async function bridgeInventory(options: BridgeOptions, gmProjectPath: string): Promise<BridgeInventory> {
  return BridgeInventorySchema.parse(await runBridgeJson(options, ["inventory", "--gm-project", gmProjectPath]));
}

export async function bridgeGmlApi(options: BridgeOptions): Promise<GmlApiEntry[]> {
  return GmlApiPayloadSchema.parse(await runBridgeJson(options, ["gml-api"])).entries;
}
