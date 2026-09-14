import { createHash } from "node:crypto";
import type { OpenCodeModel } from "../agents/external/opencode.ts";
/** Only authoritative complete zero prices qualify; absent cache pricing is NOT a free tier. */
export function isVerifiedFree(model: OpenCodeModel): boolean {
  if (
    model.provider !== "opencode" ||
    !model.toolcall ||
    model.status === "deprecated"
  )
    return false;
  if (!model.cost || typeof model.cost !== "object") return false;
  const cost = model.cost as Record<string, unknown>;
  if (cost["input"] !== 0 || cost["output"] !== 0) return false;
  const cache = cost["cache"] as Record<string, unknown> | undefined;
  if (!cache || cache["read"] !== 0 || cache["write"] !== 0) return false;
  const zeroTree = (value: unknown): boolean =>
    typeof value === "number"
      ? value === 0
      : typeof value === "object" &&
        value !== null &&
        Object.values(value).every(zeroTree);
  return Object.values(cost).every(zeroTree);
}
export function modelFingerprint(models: readonly OpenCodeModel[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...models]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(({ id, provider, cost, toolcall, status }) => ({
            id,
            provider,
            cost,
            toolcall,
            status,
          })),
      ),
    )
    .digest("hex");
}

export function isAutomaticModel(model: string | null): boolean {
  return (
    model === null || ["auto", "auto-free", "automatic-free"].includes(model)
  );
}
