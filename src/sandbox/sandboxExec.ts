/**
 * macOS `sandbox-exec` backend (SBPL profile, fail-closed isolation).
 *
 * The profile is `(deny default)` plus an explicit grant list:
 *   - system libraries / dyld shared cache / the pinned interpreter prefix, so a real Python or
 *     Node process can start at all;
 *   - metadata access to every ancestor directory of every granted path, plus `/` itself — without
 *     this dyld aborts during boot (silently, with SIGABRT) instead of reporting a denial;
 *   - read for every mount, read+write for every `rw` mount;
 *   - read+write on a private scratch directory holding the profile.
 * Everything else in the filesystem is denied, and the network is denied unless the spec allows it.
 */

import { existsSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildSubprocessEnv } from "./env.ts";
import {
  assertSandboxSpec,
  runSandboxCapture,
  type SandboxBackend,
  type SandboxSpec,
  type SandboxResult,
} from "./backend.ts";

export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** The probe profile used both for availability detection and by callers in `doctor`. */
export const SANDBOX_EXEC_PROBE_ARGS: readonly string[] = [
  SANDBOX_EXEC_PATH,
  "-p",
  "(version 1)(allow default)",
  "/bin/echo",
  "ok",
];

/**
 * System paths a dyld- and libc-linked process needs. Missing entries are skipped, so the profile
 * stays identical in meaning across macOS versions.
 */
const SYSTEM_READ_PATHS: readonly string[] = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/sbin",
  "/usr/share",
  "/System",
  "/private/etc",
  "/private/var/db/timezone",
  "/private/var/folders",
  "/private/var/select",
  "/Library/Apple",
];

/** Character devices that are safe to grant; `/dev` as a whole is not. */
const DEVICE_PATHS: readonly string[] = ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"];

/** Quotes a filesystem path for SBPL. Escapes only the two characters SBPL treats specially. */
function sbplString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Canonical path as the kernel sees it (resolves `/tmp` → `/private/tmp`, symlinked prefixes). */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Every ancestor directory of `path`, from its parent up to (and including) `/`. */
function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let current = dirname(path);
  while (current !== "/" && current !== "." && current.length > 1) {
    ancestors.push(current);
    current = dirname(current);
  }
  return ancestors;
}

/**
 * Read roots for the executable named by `argv[0]`: every directory the binary's symlink chain
 * passes through, plus the install prefix of the final target (`<prefix>/bin/<exe>` → `<prefix>`,
 * which is where Node keeps its modules and a virtualenv keeps its `lib/pythonX.Y` tree). A venv
 * `bin/python` therefore grants the venv root, the user-local shim directory and the real Python
 * home — each of which is dereferenced while the kernel execs the binary. A bare command name is
 * resolved through the spec's `PATH`. Top-level directories (`/`, `/usr`, `/opt`) are never granted
 * by this rule: they are either in the system list or too broad to hand to a sandboxed tool.
 */
function executableReadRoots(spec: SandboxSpec): string[] {
  const argv0 = spec.argv[0] ?? "";
  const resolved = argv0.includes("/") ? resolve(argv0) : findByPath(argv0, spec.env["PATH"]);
  if (resolved === null) return [];
  const roots: string[] = [];
  for (const link of resolveChain(resolved)) {
    roots.push(dirname(link));
    const prefix = dirname(dirname(link));
    if (prefix.split("/").filter((part) => part.length > 0).length >= 2) roots.push(prefix);
  }
  return roots;
}

/** Every path a symlink chain passes through, from `path` to its final target (hops bounded). */
function resolveChain(path: string): string[] {
  const chain: string[] = [path];
  let current = path;
  for (let hops = 0; hops < 32; hops++) {
    let target: string;
    try {
      target = readlinkSync(current);
    } catch {
      break;
    }
    current = isAbsolute(target) ? target : resolve(dirname(current), target);
    chain.push(current);
  }
  return chain;
}

/** Resolve a bare executable name against an explicit `PATH` string, without touching the host env. */
function findByPath(name: string, pathValue: string | undefined): string | null {
  if (name.length === 0 || pathValue === undefined) return null;
  for (const entry of pathValue.split(":")) {
    if (!isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface ProfilePathSet {
  readonly subtrees: readonly string[];
  readonly literals: readonly string[];
}

/** Split canonical paths into SBPL `subpath`/`literal` grants, adding ancestor metadata access. */
function splitProfilePaths(paths: readonly string[]): ProfilePathSet {
  const subtrees = new Set<string>();
  const literals = new Set<string>(["/"]);
  for (const path of paths) {
    const target = canonical(path);
    let isDirectory = false;
    try {
      isDirectory = statSync(target).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (isDirectory) subtrees.add(target);
    else literals.add(target);
    for (const ancestor of ancestorsOf(target)) literals.add(ancestor);
  }
  return {
    subtrees: [...subtrees].sort(),
    literals: [...literals].sort(),
  };
}

function renderPaths(paths: ProfilePathSet, indent: string): string {
  const lines: string[] = [];
  for (const literal of paths.literals) lines.push(`${indent}(literal ${sbplString(literal)})`);
  for (const subtree of paths.subtrees) lines.push(`${indent}(subpath ${sbplString(subtree)})`);
  return lines.join("\n");
}

/**
 * Build the SBPL profile for one run. `scratchDir` is the only writable location besides the
 * spec's `rw` mounts; it is created and deleted by the backend around each run.
 */
export function buildSandboxExecProfile(spec: SandboxSpec, scratchDir: string): string {
  const readPaths: string[] = [...SYSTEM_READ_PATHS.filter((path) => existsSync(path)), ...DEVICE_PATHS];
  for (const root of executableReadRoots(spec)) readPaths.push(root);
  for (const mount of spec.mounts) readPaths.push(mount.hostPath);
  readPaths.push(spec.cwd, scratchDir);

  const writePaths: string[] = [scratchDir, ...DEVICE_PATHS];
  for (const mount of spec.mounts) {
    if (mount.mode === "rw") writePaths.push(mount.hostPath);
  }

  const read = splitProfilePaths(readPaths);
  const write = splitProfilePaths(writePaths);

  const sections = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow signal (target self))",
    `(allow file-read* file-map-executable\n${renderPaths(read, "  ")})`,
    `(allow file-write*\n${renderPaths(write, "  ")})`,
    spec.networkAllowed ? "(allow network*)" : "(deny network*)",
  ];
  return `${sections.join("\n")}\n`;
}

/** Write the profile into a private scratch directory, run the command, then delete the directory. */
async function runWithScratchDir(spec: SandboxSpec): Promise<SandboxResult> {
  assertSandboxSpec(spec);
  const scratchDir = realpathSync(mkdtempSync(join(tmpdir(), "gm2deep-sandbox-")));
  try {
    const profilePath = join(scratchDir, "profile.sb");
    writeFileSync(profilePath, buildSandboxExecProfile(spec, scratchDir), { encoding: "utf8", mode: 0o600 });
    return await runSandboxCapture("sandbox-exec", spec, [
      SANDBOX_EXEC_PATH,
      "-f",
      profilePath,
      "--",
      ...spec.argv,
    ]);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** True when `/usr/bin/sandbox-exec` runs its own allow-everything probe successfully. */
export async function probeSandboxExec(): Promise<boolean> {
  try {
    const result = await runSandboxCapture("sandbox-exec", {
      argv: SANDBOX_EXEC_PROBE_ARGS,
      cwd: process.cwd(),
      mounts: [],
      env: buildSubprocessEnv(),
      networkAllowed: false,
      timeoutSeconds: 15,
      maxOutputBytes: 64 * 1024,
    });
    return result.exitCode === 0;
  } catch {
    // The probe *is* the availability question: a failed spawn (binary absent) means "unavailable".
    return false;
  }
}

export function createSandboxExecBackend(): SandboxBackend {
  return {
    id: "sandbox-exec",
    available: probeSandboxExec,
    run: runWithScratchDir,
  };
}
