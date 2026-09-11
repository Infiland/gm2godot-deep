import type { CommandContext, CommandRunner } from "../main.ts";
import { DeepError } from "../../util/result.ts";
import { openWorkspace } from "../../workspaces/workspace.ts";
import { openDatabase } from "../../storage/db.ts";
import { Repo } from "../../storage/repo.ts";
import { invalidateForContractChange } from "../../scheduling/cache.ts";
import { EXIT } from "../exit.ts";
import { flagBoolean, flagString, renderTable  } from "../output.ts";

/**
 * `cache` inspects the analysis cache, clears it, or invalidates the entries bound to one contract
 * concern. Invalidation is the only way a contract version bump re-keys units whose `.gml` is
 * unchanged, so it is recorded (`invalidations` rows) rather than performed silently.
 */
export const run: CommandRunner = async (context: CommandContext) => {
  const root = flagString(context.flags, "workspace");
  if (root === null) throw new DeepError("GM2DEEP-CLI-USAGE", "cache requires --workspace");
  const clear = flagBoolean(context.flags, "clear");
  const concern = flagString(context.flags, "invalidate-contract");
  if (clear && concern !== null) {
    throw new DeepError("GM2DEEP-CLI-USAGE", "cache accepts either --clear or --invalidate-contract, not both");
  }
  const workspace = openWorkspace(root);
  const db = openDatabase(workspace.paths.database);
  const repo = new Repo(db);
  try {
    if (clear) {
      const removed = repo.clearCache();
      context.stdout(`cache: cleared ${String(removed)} entr${removed === 1 ? "y" : "ies"}`);
      return EXIT.ok;
    }
    if (concern !== null) {
      const versions = repo.latestContractVersions();
      const fromVersion = versions[concern];
      if (fromVersion === undefined) {
        throw new DeepError("GM2DEEP-CONTRACT-MISSING", `no contract version recorded for concern ${JSON.stringify(concern)}`, {
          known: Object.keys(versions).sort(),
        });
      }
      const outcome = invalidateForContractChange(repo, concern, fromVersion, fromVersion + 1);
      context.stdout(
        `cache: ${concern} v${String(fromVersion)} → v${String(outcome.toVersion)}; ${String(outcome.affectedUnitIds.length)} unit(s) re-keyed to READY`,
      );
      for (const unitId of outcome.affectedUnitIds) context.stdout(`  ${unitId}`);
      context.stdout(`cache: artifacts under ${workspace.paths.evidenceContracts} still hold v${String(fromVersion)}; the next run re-analyses these units against the new version.`);
      return EXIT.ok;
    }

    const entries = repo.listCacheEntries();
    const byKind: Record<string, number> = {};
    for (const entry of entries) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    context.stdout(`cache: ${String(entries.length)} entr${entries.length === 1 ? "y" : "ies"}`);
    if (entries.length > 0) {
      context.stdout(
        renderTable(
          ["kind", "count"],
          Object.entries(byKind)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([kind, count]) => [kind, String(count)]),
        ),
      );
    }
    return EXIT.ok;
  } finally {
    db.close();
  }
};
