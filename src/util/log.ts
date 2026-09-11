export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  /** Prefix every line with `[simulated]`. Set by the mock runtime. */
  simulated?: boolean;
  /** Sink override, for tests. Defaults to stderr for warn/error and stdout otherwise. */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface Logger {
  readonly simulated: boolean;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Derive a logger that prefixes `[simulated]`. */
  asSimulated(): Logger;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (process.env["DEEP_LOG_LEVEL"] as LogLevel | undefined) ?? "info";
  const simulated = options.simulated ?? false;
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  function emit(at: LogLevel, message: string): void {
    if (LEVEL_ORDER[at] < LEVEL_ORDER[level]) return;
    const prefix = simulated ? "[simulated] " : "";
    const line = `${prefix}${at === "info" ? "" : at + ": "}${message}`;
    if (at === "warn" || at === "error") stderr(line);
    else stdout(line);
  }

  const logger: Logger = {
    simulated,
    debug: (message) => emit("debug", message),
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
    asSimulated: () => createLogger({ ...options, level, simulated: true }),
  };
  return logger;
}

export const silentLogger: Logger = createLogger({
  level: "error",
  stdout: () => {},
  stderr: () => {},
});
