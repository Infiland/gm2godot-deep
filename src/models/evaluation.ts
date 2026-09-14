import { createHash } from "node:crypto";
import type { AgentRoleName } from "../agents/runtime.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../util/json.ts";
import {
  BENCHMARKS,
  BENCHMARK_VERSION,
  type BenchmarkCase,
} from "./benchmarks.ts";
import { isVerifiedFree, modelFingerprint } from "./freePolicy.ts";
import type { OpenCodeModel } from "../agents/external/opencode.ts";
export const TOOL_CONTRACT_VERSION = "host-tools-2";
export const EvaluationAnswerSchema = z.strictObject({
  facts: z.record(z.string(), z.boolean()),
  citations: z
    .array(
      z.strictObject({ path: z.string(), line: z.number().int().positive() }),
    )
    .min(1),
  uncertain: z.boolean(),
  gdscript: z.string().optional(),
});
export type EvaluationAnswer = z.output<typeof EvaluationAnswerSchema>;
export interface EvaluationResult {
  model: string;
  provider: string;
  score: number;
  caseScores: Record<string, number>;
  passed: boolean;
  latencyMs: number;
  reason: string;
}
export function scoreAnswer(
  test: BenchmarkCase,
  answer: unknown,
  toolUsed: boolean,
): number {
  const parsed = EvaluationAnswerSchema.safeParse(answer);
  if (!parsed.success || !toolUsed) return 0;
  const correct =
    Object.entries(test.expected).filter(
      ([key, value]) => parsed.data.facts[key] === value,
    ).length / Object.keys(test.expected).length;
  const paths = [...test.source.matchAll(/^\/\/ (.+)$/gm)].map((m) => m[1]);
  const citations = parsed.data.citations.every(
    (c) => paths.includes(c.path) && c.line <= test.source.split("\n").length,
  );
  if (!citations) return 0;
  if (
    test.id === "gdscript" &&
    (!/func\s+_physics_process\s*\(/.test(parsed.data.gdscript ?? "") ||
      !/position\.x\s*\+=\s*2\b/.test(parsed.data.gdscript ?? "") ||
      /2\s*\*\s*(?:_?delta)/.test(parsed.data.gdscript ?? ""))
  )
    return 0;
  return (
    correct * 70 +
    (citations ? 20 : 0) +
    (parsed.data.uncertain === test.uncertain ? 10 : 0)
  );
}
export async function evaluateFreeModels(options: {
  models: readonly OpenCodeModel[];
  cacheDir: string;
  preferredModel?: string;
  signal: AbortSignal;
  run: (
    model: OpenCodeModel,
    test: BenchmarkCase,
    signal: AbortSignal,
  ) => Promise<{ answer: unknown; toolUsed: boolean }>;
}): Promise<EvaluationResult[]> {
  const candidates = options.models
    .filter(isVerifiedFree)
    .sort(
      (a, b) =>
        Number(b.id === options.preferredModel) -
          Number(a.id === options.preferredModel) || a.id.localeCompare(b.id),
    )
    .slice(0, 5);
  const key =
    modelFingerprint(candidates) +
    `-${BENCHMARK_VERSION}-${TOOL_CONTRACT_VERSION}-${createHash("sha256").update(JSON.stringify(BENCHMARKS)).digest("hex")}`;
  const path = join(options.cacheDir, `${key}.json`);
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, "utf8")) as {
      at: string;
      results: EvaluationResult[];
    };
    if (Date.now() - Date.parse(cached.at) < 7 * 86_400_000)
      return cached.results;
  }
  const results: EvaluationResult[] = [];
  let transientFailure = false;
  for (const model of candidates) {
    options.signal.throwIfAborted();
    const started = Date.now();
    const scores: number[] = [];
    for (const test of BENCHMARKS) {
      options.signal.throwIfAborted();
      try {
        const reply = await options.run(
          model,
          test,
          AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]),
        );
        scores.push(scoreAnswer(test, reply.answer, reply.toolUsed));
      } catch {
        options.signal.throwIfAborted();
        transientFailure = true;
        scores.push(0);
      }
    }
    const score = scores.reduce((a, b) => a + b, 0) / BENCHMARKS.length;
    const passed = scores.every((s) => s >= 80);
    results.push({
      model: model.id,
      provider: model.provider,
      score,
      caseScores: Object.fromEntries(
        BENCHMARKS.map((test, index) => [test.id, scores[index] ?? 0]),
      ),
      passed,
      latencyMs: Date.now() - started,
      reason: `${score.toFixed(1)}/100 on four shipped cases; ${passed ? "all cases passed" : "at least one case failed"}`,
    });
  }
  results.sort(
    (a, b) =>
      Number(b.passed) - Number(a.passed) ||
      b.score - a.score ||
      a.latencyMs - b.latencyMs,
  );
  options.signal.throwIfAborted();
  if (!transientFailure)
    writeJsonAtomic(path, { at: new Date().toISOString(), results });
  return results;
}

/** Research favors state/dependencies; implementation favors conversion; all roles require every case to pass. */
export function rankForRole(
  results: readonly EvaluationResult[],
  role: AgentRoleName,
): EvaluationResult[] {
  const weights: Record<string, number> =
    role === "implementer"
      ? { lifecycle: 1, dependencies: 1, gdscript: 4, unsupported: 2 }
      : role === "analyst" || role === "reconciler"
        ? { lifecycle: 2, dependencies: 3, gdscript: 1, unsupported: 2 }
        : { lifecycle: 2, dependencies: 2, gdscript: 2, unsupported: 3 };
  const score = (r: EvaluationResult): number =>
    Object.entries(weights).reduce(
      (sum, [key, weight]) => sum + (r.caseScores[key] ?? 0) * weight,
      0,
    );
  return results
    .filter((r) => r.passed)
    .sort((a, b) => score(b) - score(a) || a.latencyMs - b.latencyMs);
}
