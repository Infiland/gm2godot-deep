import { z } from "zod";

export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA256 = z.string().regex(SHA256_PATTERN);

export const AGENT_RUNTIME_IDS = ["pi", "mock"] as const;
export const EVIDENCE_BASES = ["observed", "inferred"] as const;
export const UNIT_STRATEGIES = ["retain_generated", "repair_generated", "replace_component", "blocked"] as const;

const Basis = z.string().min(1);
const EvidenceBasis = z.enum(EVIDENCE_BASES);

/** A pointer into a file that a claim can be checked against. */
export const EvidenceRefSchema = z.strictObject({
  path: z.string().min(1),
  sha256: SHA256,
  line: z.number().int().positive(),
  column: z.number().int().positive().optional(),
  snippet: z.string(),
});
export type EvidenceRef = z.output<typeof EvidenceRefSchema>;

const EvidencedStatement = z.strictObject({
  statement: z.string().min(1),
  basis: Basis,
});
const ObservedStatement = z.strictObject({
  statement: z.string().min(1),
  evidence: z.array(EvidenceRefSchema).min(1),
});
/** Assumptions and uncertainties carry `text`, matching the analysis-record contract. */
const BasedText = z.strictObject({ text: z.string().min(1), basis: Basis });

// ---------------------------------------------------------------- usage

export const AgentUsageSchema = z.strictObject({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** False means the provider did not report usage; the numbers are then zero by construction. */
  reported: z.boolean(),
});
export type AgentUsage = z.output<typeof AgentUsageSchema>;

export const ProducedBySchema = z.strictObject({
  runtime: z.enum(AGENT_RUNTIME_IDS),
  simulated: z.boolean(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  promptVersion: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  usage: AgentUsageSchema,
});
export type ProducedBy = z.output<typeof ProducedBySchema>;

// -------------------------------------------------------- analysis

export const InteractionKindSchema = z.enum([
  "calls",
  "instance_creation",
  "inherits",
  "room_creation",
  "resource_reference",
  "shared_state",
]);
export type InteractionKind = z.output<typeof InteractionKindSchema>;

export const ConverterDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string(),
  sourcePath: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  resource: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  issueNumber: z.number().int().optional(),
});
export type ConverterDiagnostic = z.output<typeof ConverterDiagnosticSchema>;

export const AnalysisRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  unitId: z.string().min(1),
  unitKind: z.string().min(1),
  sourceSnapshotId: SHA256,
  baselineId: SHA256.nullable(),
  sourcePaths: z.array(z.strictObject({ path: z.string().min(1), sha256: SHA256 })),
  generatedOutputs: z.array(
    z.strictObject({ path: z.string().min(1), sha256: SHA256, sourceMapPath: z.string().min(1).optional() }),
  ),
  converterDiagnostics: z.array(ConverterDiagnosticSchema),
  purpose: z.strictObject({ text: z.string().min(1), basis: EvidenceBasis }),
  behavior: z.strictObject({
    observed: z.array(ObservedStatement),
    inferred: z.array(EvidencedStatement),
  }),
  lifecycle: z.array(
    z.strictObject({
      event: z.string().min(1),
      responsibilities: z.array(EvidencedStatement),
      evidence: z.array(EvidenceRefSchema),
    }),
  ),
  ownedState: z.array(
    z.strictObject({
      name: z.string().min(1),
      typeHint: z.string().optional(),
      basis: Basis,
      evidence: z.array(EvidenceRefSchema),
    }),
  ),
  sharedState: z.array(
    z.strictObject({
      name: z.string().min(1),
      isGlobal: z.boolean(),
      access: z.enum(["read", "write", "readwrite"]),
      basis: Basis,
      evidence: z.array(EvidenceRefSchema),
    }),
  ),
  inputs: z.array(z.strictObject({ name: z.string().min(1), source: z.string().min(1), basis: Basis })),
  sideEffects: z.array(ObservedStatement),
  dependencies: z.strictObject({
    confirmed: z.array(
      z.strictObject({
        toUnitId: z.string().min(1),
        kind: InteractionKindSchema,
        evidence: z.array(EvidenceRefSchema).min(1),
      }),
    ),
    inferred: z.array(
      z.strictObject({
        toUnitId: z.string().min(1),
        kind: InteractionKindSchema,
        basis: Basis,
        evidence: z.array(EvidenceRefSchema),
      }),
    ),
    unresolved: z.array(
      z.strictObject({
        symbol: z.string().min(1),
        reason: z.string().min(1),
        evidence: z.array(EvidenceRefSchema),
      }),
    ),
  }),
  hazards: z.array(
    z.strictObject({
      id: z.string().min(1),
      kind: z.string().min(1),
      description: z.string().min(1),
      evidence: z.array(EvidenceRefSchema),
      upstreamIssueNumber: z.number().int().optional(),
    }),
  ),
  strategy: z.enum(UNIT_STRATEGIES),
  strategyRationale: z.strictObject({ text: z.string().min(1), basis: Basis }),
  acceptanceScenarios: z.array(
    z.strictObject({
      id: z.string().min(1),
      kind: z.enum(["recorded_trace", "source_derived", "synthetic"]),
      description: z.string().min(1),
      command: z.string().min(1).optional(),
      expected: z.unknown(),
    }),
  ),
  assumptions: z.array(BasedText),
  uncertainties: z.array(BasedText),
  blockers: z.array(z.strictObject({ text: z.string().min(1), evidence: z.array(EvidenceRefSchema) })),
  evidence: z.array(
    z.strictObject({
      claim: z.string().min(1),
      locations: z.array(EvidenceRefSchema).min(1),
    }),
  ),
  producedBy: ProducedBySchema,
});
export type AnalysisRecord = z.output<typeof AnalysisRecordSchema>;

export const ReviewRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  unitId: z.string().min(1),
  challenges: z.array(
    z.strictObject({
      claim: z.string().min(1),
      counterexampleEvidence: z.array(EvidenceRefSchema),
      verdict: z.enum(["upheld", "refuted", "unknown"]),
    }),
  ),
  missedDependencies: z.array(
    z.strictObject({ toUnitId: z.string().min(1), kind: InteractionKindSchema, basis: Basis }),
  ),
  additionalHazards: z.array(
    z.strictObject({
      id: z.string().min(1),
      kind: z.string().min(1),
      description: z.string().min(1),
      evidence: z.array(EvidenceRefSchema),
      upstreamIssueNumber: z.number().int().optional(),
    }),
  ),
  recommendedStrategy: z.enum(UNIT_STRATEGIES).optional(),
  reviewerNotes: z.string(),
  producedBy: ProducedBySchema,
});
export type ReviewRecord = z.output<typeof ReviewRecordSchema>;

// ------------------------------------------------------- contracts

export const ContractRuleSchema = z.strictObject({
  id: z.string().min(1),
  statement: z.string().min(1),
  basis: z.enum(["upstream", "analysis", "unresolved"]),
  /** Relative path inside the baseline, and optionally a line, that justifies the rule. */
  upstreamBasis: z.strictObject({ path: z.string().min(1), line: z.number().int().positive().optional() }).nullable(),
  evidence: z.array(EvidenceRefSchema),
});

export type ContractRule = z.output<typeof ContractRuleSchema>;

export const ContractRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  concern: z.string().min(1),
  version: z.number().int().positive(),
  rules: z.array(ContractRuleSchema).min(1),
  policy: z.strictObject({
    needsReview: z.boolean(),
    rationale: z.string().min(1),
  }),
  producedBy: ProducedBySchema.optional(),
});
export type ContractRecord = z.output<typeof ContractRecordSchema>;

// ------------------------------------------------------------ plan

export const PlanRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  contracts: z.array(
    z.strictObject({
      concern: z.string().min(1),
      version: z.number().int().positive(),
      rules: z.array(ContractRuleSchema).min(1),
    }),
  ),
  unitStrategies: z.array(
    z.strictObject({
      unitId: z.string().min(1),
      strategy: z.enum(UNIT_STRATEGIES),
      rationale: z.string().min(1),
    }),
  ),
  conflictResolutions: z.array(
    z.strictObject({
      concern: z.string().min(1),
      resolution: z.string().min(1),
      evidence: z.array(EvidenceRefSchema),
    }),
  ),
  blockages: z.array(
    z.strictObject({
      unitId: z.string().min(1),
      reason: z.string().min(1),
      requiredApproval: z.string().min(1),
    }),
  ),
  producedBy: ProducedBySchema,
});
export type PlanRecord = z.output<typeof PlanRecordSchema>;

// ----------------------------------------------------------- patch

export const PatchFileSchema = z.strictObject({
  path: z.string().min(1),
  action: z.enum(["create", "update", "delete"]),
  preimageSha256: SHA256.nullable(),
  contentSha256: SHA256,
  content: z.string(),
});

export const PatchRecordPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  attempt: z.number().int().positive(),
  basePortRevision: z.number().int().nonnegative(),
  inputHash: z.string().min(1),
  contractVersions: z.record(z.string(), z.number().int().positive()),
  files: z.array(PatchFileSchema),
  summary: z.string(),
  producedBy: ProducedBySchema,
});
export type PatchRecordPayload = z.output<typeof PatchRecordPayloadSchema>;

// ------------------------------------------------------ validation

export const ValidationResultSchema = z.strictObject({
  level: z.enum(["A", "B", "C", "D", "E"]),
  checkId: z.string().min(1),
  name: z.string().min(1),
  state: z.enum(["passed", "failed", "skipped", "inconclusive"]),
  command: z.string().min(1).optional(),
  engineVersion: z.string().min(1).optional(),
  inputRevision: z.string().min(1),
  exitStatus: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  logsPath: z.string().min(1).optional(),
  artifacts: z.array(z.string()),
  reason: z.string().min(1).optional(),
});
export type ValidationResult = z.output<typeof ValidationResultSchema>;

// ---------------------------------------------------------- trace

export const TraceFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  provenance: z.enum(["observed_original_runtime", "source_derived", "synthetic"]),
  engine: z.string().min(1).optional(),
  randomness: z.strictObject({
    mode: z.enum(["fixed_seed", "normalized", "none"]),
    seed: z.number().int().optional(),
    note: z.string(),
  }),
  timing: z.strictObject({
    mode: z.enum(["step_count", "fixed_frames"]),
    steps: z.number().int().positive(),
  }),
  events: z.array(
    z.strictObject({
      step: z.number().int().nonnegative(),
      kind: z.string().min(1),
      target: z.string().min(1),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
});
export type TraceFile = z.output<typeof TraceFileSchema>;
