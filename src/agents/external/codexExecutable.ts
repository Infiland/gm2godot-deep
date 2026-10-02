import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type CodexInstallationSource = "explicit" | "path" | "known-location" | "desktop";

export interface ResolvedCodex {
  executable: string;
  command: string;
  args: readonly string[];
  installationSource: CodexInstallationSource;
}

/** Overrides keep platform discovery testable without changing the host environment. */
export interface CodexExecutableOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<NodeJS.ProcessEnv>;
  home?: string;
  cwd?: string;
  execPath?: string;
  isFile?: (path: string) => boolean;
  isExecutable?: (path: string) => boolean;
}

const INVALID_SELECTION = "The selected Codex executable is missing, is not executable, or cannot be launched safely. Select an installed Codex binary or reinstall the Codex CLI.";

/** Resolve a local installation only; this neither launches Codex nor reads credentials. */
export function resolveCodexExecutable(
  explicit?: string | null,
  options: CodexExecutableOptions = {},
): ResolvedCodex | null {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const paths = windows ? win32 : posix;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const execPath = options.execPath ?? process.execPath;
  const isFile = options.isFile ?? regularFile;
  const isExecutable = options.isExecutable ?? executableFile;
  // Windows drive-relative and root-relative paths still depend on the current drive.
  const absolute = (path: string): boolean => windows
    ? /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(path)
    : paths.isAbsolute(path);
  const environment = (name: string): string | undefined => windows
    ? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    : env[name];
  const pathDirectories = (environment("PATH") ?? "").split(windows ? ";" : ":")
    .filter((directory) => absolute(directory) && !directory.includes("\0"));

  const resolveCandidate = (executable: string, installationSource: CodexInstallationSource): ResolvedCodex | null => {
    if (!isFile(executable)) return null;
    if (!windows) {
      return isExecutable(executable) ? { executable, command: executable, args: [], installationSource } : null;
    }
    const extension = paths.extname(executable).toLowerCase();
    if (extension === ".exe") return { executable, command: executable, args: [], installationSource };
    if (extension !== ".cmd" || paths.basename(executable).toLowerCase() !== "codex.cmd") return null;
    // npm's Windows shim cannot be spawned directly. Launch only its known Codex
    // package entry point with the Node runtime already running this engine.
    const entryPoint = paths.join(paths.dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!isFile(entryPoint) || !absolute(execPath) || !isFile(execPath)) return null;
    return { executable, command: execPath, args: [entryPoint], installationSource };
  };
  const names = (name: string): string[] => windows && !paths.extname(name)
    ? [`${name}.exe`, `${name}.cmd`]
    : [name];
  const searchPath = (name: string, source: CodexInstallationSource): ResolvedCodex | null => {
    for (const directory of pathDirectories) {
      for (const filename of names(name)) {
        const selected = resolveCandidate(paths.join(directory, filename), source);
        if (selected) return selected;
      }
    }
    return null;
  };

  if (explicit !== undefined && explicit !== null) {
    if (!explicit.trim() || explicit.includes("\0")) throw new Error(INVALID_SELECTION);
    const expanded = explicit.startsWith("~/") || (windows && explicit.startsWith("~\\"))
      ? paths.join(home, explicit.slice(2)) : explicit;
    const isPath = expanded.includes("/") || expanded.includes("\\") || (windows && /^[a-z]:/i.test(expanded));
    if (!isPath) {
      const selected = searchPath(expanded, "explicit");
      if (selected) return selected;
    } else if (absolute(expanded) || (absolute(cwd) && !(windows && /^[a-z]:[^\\/]/i.test(expanded)))) {
      const selected = resolveCandidate(paths.resolve(cwd, expanded), "explicit");
      if (selected) return selected;
    }
    throw new Error(INVALID_SELECTION);
  }

  const fromPath = searchPath("codex", "path");
  if (fromPath) return fromPath;

  const directories: string[] = [];
  const addDirectory = (directory: string | undefined): void => {
    if (directory && absolute(directory) && !directory.includes("\0") && !directories.includes(directory)) directories.push(directory);
  };
  addDirectory(paths.join(home, ".local", "bin"));
  addDirectory(paths.join(home, ".npm-global", windows ? "" : "bin"));
  addDirectory(paths.join(home, ".npm", windows ? "" : "bin"));
  addDirectory(paths.join(environment("VOLTA_HOME") ?? paths.join(home, ".volta"), "bin"));
  const npmPrefix = environment("NPM_CONFIG_PREFIX") ?? environment("npm_config_prefix");
  if (npmPrefix && absolute(npmPrefix)) addDirectory(windows ? npmPrefix : paths.join(npmPrefix, "bin"));
  addDirectory(environment("NVM_BIN"));
  if (windows) {
    const appData = environment("APPDATA");
    const localAppData = environment("LOCALAPPDATA");
    const programFiles = environment("PROGRAMFILES");
    if (appData) addDirectory(paths.join(appData, "npm"));
    if (localAppData) {
      addDirectory(paths.join(localAppData, "Microsoft", "WinGet", "Links"));
      addDirectory(paths.join(localAppData, "Programs", "Codex"));
    }
    if (programFiles) addDirectory(paths.join(programFiles, "Codex"));
  } else {
    if (platform === "darwin") addDirectory("/opt/homebrew/bin");
    addDirectory("/usr/local/bin");
    addDirectory("/usr/bin");
  }
  for (const directory of directories) {
    for (const filename of names("codex")) {
      const selected = resolveCandidate(paths.join(directory, filename), "known-location");
      if (selected) return selected;
    }
  }

  if (platform === "darwin") {
    for (const root of ["/Applications", paths.join(home, "Applications")].filter(absolute)) {
      for (const app of ["ChatGPT.app", "Codex.app"]) {
        for (const relative of [
          "Contents/Resources/codex-cli/bin/codex",
          "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
          "Contents/Resources/codex",
        ]) {
          const selected = resolveCandidate(paths.join(root, app, relative), "desktop");
          if (selected) return selected;
        }
      }
    }
  }
  return null;
}

function regularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function executableFile(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}
