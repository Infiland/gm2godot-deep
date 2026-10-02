import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCodexOptions {
  scenario?: "complete" | "bad-json" | "failed-turn" | "disconnect" | "stall" | "discovery-stall" | "initialize-error" | "bad-wire" | "turn-error" | "bad-account" | "model-error" | "repeated-cursor";
  account?: { account: unknown; requiresOpenaiAuth?: boolean };
  output?: unknown;
  pages?: { data: { id: string; model?: string; displayName?: string }[]; nextCursor?: string | null }[];
}

export interface FakeCodexRecord {
  event?: string;
  argv?: string[];
  cwd?: string;
  executable?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

/** This subprocess implements only synthetic JSONL responses; it never calls a provider. */
export function fakeCodex(options: FakeCodexOptions = {}): {
  executable: string;
  directory: string;
  records: () => FakeCodexRecord[];
  cleanup: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "deep-codex-test-"));
  const binaryDirectory = join(directory, "Codex tools ; literal");
  mkdirSync(binaryDirectory);
  const executable = join(binaryDirectory, process.platform === "win32" ? "codex.cmd" : "codex");
  const entry = process.platform === "win32"
    ? join(binaryDirectory, "node_modules", "@openai", "codex", "bin", "codex.js") : executable;
  if (process.platform === "win32") {
    mkdirSync(join(binaryDirectory, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    writeFileSync(executable, "This shim is never executed.\n");
  }
  const logPath = join(directory, "protocol.jsonl");
  const source = `#!${process.execPath}
const { createInterface } = require("node:readline");
const { appendFileSync } = require("node:fs");
const options = ${JSON.stringify(options)};
const logPath = ${JSON.stringify(logPath)};
const record = (value) => appendFileSync(logPath, JSON.stringify(value) + "\\n");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
record({event: "started", argv: process.argv.slice(2), cwd: process.cwd(), executable: process.argv[1]});
process.stderr.write("secret-provider-diagnostic\\n");
if (process.argv[2] === "auth") {
  process.stdout.write(JSON.stringify({loggedIn: true}));
  process.exit(0);
}
let page = 0;
let rejectedNativeRequests = 0;
const finish = () => {
  const text = options.scenario === "bad-json" ? "not json" : JSON.stringify(options.output ?? {ok: true});
  emit({method: "item/agentMessage/delta", params: {delta: text.slice(0, 3)}});
  emit({method: "item/agentMessage/delta", params: {delta: text.slice(3)}});
  emit({method: "item/completed", params: {item: {type: "agentMessage", text}}});
  emit({method: "turn/completed", params: {turn: {status: options.scenario === "failed-turn" ? "failed" : "completed"}}});
};
createInterface({input: process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  record(request);
  const reply = (result) => emit({id: request.id, result});
  const fail = () => emit({id: request.id, error: {message: "secret-provider-error", code: -32000}});
  if (request.id === "native-tool" || request.id === "native-approval") {
    if (!request.error || request.error.code !== -32601) process.exit(7);
    if (++rejectedNativeRequests === 2) finish();
    return;
  }
  if (request.method === "initialize") {
    if (options.scenario === "initialize-error") return fail();
    if (options.scenario === "bad-wire") return process.stdout.write("null\\n");
    return reply({});
  }
  if (request.method === "account/read") {
    return reply(options.scenario === "bad-account" ? {account: "secret-invalid-account"}
      : options.account ?? {account: {type: "chatgpt", email: "secret-account@example.test", accessToken: "secret-token"}, requiresOpenaiAuth: true});
  }
  if (request.method === "model/list") {
    if (options.scenario === "discovery-stall") return;
    if (options.scenario === "model-error") return fail();
    if (options.scenario === "repeated-cursor") return reply({data: [], nextCursor: "same"});
    return reply(options.pages?.[page++] ?? {data: [{id: "synthetic-model", displayName: "Synthetic model"}], nextCursor: null});
  }
  if (request.method === "thread/start") return reply({thread: {id: "synthetic-thread"}});
  if (request.method === "turn/start") {
    emit({method: "thread/tokenUsage/updated", params: {tokenUsage: {total: {inputTokens: 12, cachedInputTokens: 2, outputTokens: 3}}}});
    if (options.scenario === "turn-error") return fail();
    reply({turn: {id: "synthetic-turn"}});
    if (options.scenario === "disconnect") return process.exit(17);
    if (options.scenario === "stall") return;
    emit({id: "native-tool", method: "item/tool/call", params: {tool: "shell"}});
    emit({id: "native-approval", method: "item/commandExecution/requestApproval", params: {command: "unsafe"}});
  }
});
`;
  writeFileSync(entry, source, { mode: 0o700 });
  return {
    executable, directory,
    records: () => {
      try { return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line: string) => JSON.parse(line) as FakeCodexRecord); }
      catch { return []; }
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export async function waitForCodexRecord(
  fixture: ReturnType<typeof fakeCodex>,
  predicate: (record: FakeCodexRecord) => boolean,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!fixture.records().some(predicate)) {
    if (Date.now() > deadline) throw new Error("Synthetic Codex did not reach the expected protocol request");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
