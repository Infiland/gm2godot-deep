/**
 * Process exit codes. This lives in a leaf module on purpose: `main.ts` ends with a top-level `await`, so
 * any module that imported this table from `main.ts` would form an evaluation cycle and Node would exit 13
 * with "Detected unsettled top-level await" before the command ran.
 *
 * `4` means "the run finished but reported blocked or failed tasks".
 */
export const EXIT = { ok: 0, failure: 1, usage: 2, incomplete: 4 } as const;
