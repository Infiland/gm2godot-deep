import { join, resolve } from "node:path";

export interface WorkspacePaths {
  readonly root: string;
  readonly source: string;
  readonly baseline: string;
  readonly port: string;
  readonly tasks: string;
  readonly validation: string;
  readonly evidence: string;
  readonly evidenceInventory: string;
  readonly evidenceAnalyses: string;
  readonly evidenceContracts: string;
  readonly evidencePlans: string;
  readonly evidencePatches: string;
  readonly evidenceValidation: string;
  readonly evidenceReports: string;
  readonly transcripts: string;
  readonly staging: string;
  readonly database: string;
  readonly config: string;
}

/** Every workspace-relative directory the layout owns, created bottom-up by `createWorkspace`. */
export const WORKSPACE_DIRECTORIES: readonly string[] = [
  "source",
  "baseline",
  "port",
  "tasks",
  "validation",
  ".staging",
  "evidence",
  "evidence/inventory",
  "evidence/analyses",
  "evidence/contracts",
  "evidence/plans",
  "evidence/patches",
  "evidence/validation",
  "evidence/reports",
  "evidence/reports/transcripts",
];

export function workspacePaths(root: string): WorkspacePaths {
  const absolute = resolve(root);
  const evidence = join(absolute, "evidence");
  return {
    root: absolute,
    source: join(absolute, "source"),
    baseline: join(absolute, "baseline"),
    port: join(absolute, "port"),
    tasks: join(absolute, "tasks"),
    validation: join(absolute, "validation"),
    evidence,
    evidenceInventory: join(evidence, "inventory"),
    evidenceAnalyses: join(evidence, "analyses"),
    evidenceContracts: join(evidence, "contracts"),
    evidencePlans: join(evidence, "plans"),
    evidencePatches: join(evidence, "patches"),
    evidenceValidation: join(evidence, "validation"),
    evidenceReports: join(evidence, "reports"),
    transcripts: join(evidence, "reports", "transcripts"),
    staging: join(absolute, ".staging"),
    database: join(absolute, "state.sqlite"),
    config: join(absolute, "deep-convert.config.json"),
  };
}
