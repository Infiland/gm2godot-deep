import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodeId } from "../evidence/ids.ts";
import type { PatchRecordPayload } from "../evidence/schemas.ts";
import { sha256Bytes } from "../util/sha256.ts";
import { writeTextAtomic } from "../util/json.ts";
import { assertContained } from "../workspaces/guards.ts";
import { normalizeRepoPath } from "./allowlist.ts";
import { DeepError } from "../util/result.ts";

export type PatchFile = PatchRecordPayload["files"][number];

const BASE_MISMATCH = "GM2DEEP-PATCH-BASE-MISMATCH";

export function patchJsonPath(
  evidencePatchesDir: string,
  taskId: string,
  attempt: number,
): string {
  return join(evidencePatchesDir, encodeId(taskId), `${attempt}.patch.json`);
}

export function patchDiffPath(
  evidencePatchesDir: string,
  taskId: string,
  attempt: number,
): string {
  return join(evidencePatchesDir, encodeId(taskId), `${attempt}.patch.diff`);
}

export interface ApplyFileOptions {
  /**
   * Accept a file whose current bytes already equal `contentSha256` instead of failing the pre-image
   * check. Publication uses this so a re-run over an already-applied tree converges; candidate
   * application never does, because a candidate must start from the recorded base.
   */
  readonly tolerateIdentical?: boolean;
}

function mismatch(detail: Record<string, unknown>, message: string): DeepError {
  return new DeepError(BASE_MISMATCH, message, detail);
}

/**
 * Apply one recorded file entry inside `root`. The recorded body is authoritative; a `delete` needs no
 * body, so its `contentSha256` is not re-derived (there is nothing left to hash).
 */
export function applyFileEntry(
  root: string,
  file: PatchFile,
  options: ApplyFileOptions = {},
): void {
  const relative = normalizeRepoPath(file.path);
  const target = assertContained(root, relative);
  const present = existsSync(target) && statSync(target).isFile();

  if (file.action === "create") {
    if (file.preimageSha256 !== null) {
      throw mismatch(
        { path: relative, preimageSha256: file.preimageSha256 },
        `create of ${relative} must declare a null preimageSha256`,
      );
    }
    if (present) {
      const current = sha256Bytes(readFileSync(target));
      if (!options.tolerateIdentical || current !== file.contentSha256) {
        throw mismatch(
          { path: relative, expected: null, actual: current },
          `create of ${relative} but the file exists`,
        );
      }
      return;
    }
  } else {
    if (file.preimageSha256 === null) {
      throw mismatch(
        { path: relative, action: file.action },
        `${file.action} of ${relative} must declare a preimageSha256`,
      );
    }
    if (!present) {
      throw mismatch(
        { path: relative, expected: file.preimageSha256, actual: null },
        `${file.action} of ${relative} but no such file exists`,
      );
    }
    const current = sha256Bytes(readFileSync(target));
    if (current !== file.preimageSha256) {
      throw mismatch(
        { path: relative, expected: file.preimageSha256, actual: current },
        `${relative} does not match the patch pre-image`,
      );
    }
    if (file.action === "delete") {
      rmSync(target);
      return;
    }
  }

  writeTextAtomic(target, file.content);
  const written = sha256Bytes(readFileSync(target));
  if (written !== file.contentSha256) {
    throw mismatch(
      { path: relative, expected: file.contentSha256, actual: written },
      `written bytes of ${relative} do not match contentSha256`,
    );
  }
}

/** Apply every recorded file entry to a candidate tree, verifying each pre-image and written hash. */
export function applyPatchToTree(
  candidateRoot: string,
  payload: PatchRecordPayload,
): void {
  for (const file of payload.files) applyFileEntry(candidateRoot, file);
}

// ----------------------------------------------------------------- unified diff
// The diff is derived output for review and the report; the recorded file bodies are the input that
// is applied. It is never parsed back.

interface DiffOp {
  readonly kind: "context" | "remove" | "add";
  readonly line: string;
}

function toLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers-lite: common prefix/suffix trimmed, the changed middle diffed by LCS (whole replacement when huge). */
function diffLines(
  before: readonly string[],
  after: readonly string[],
): DiffOp[] {
  let head = 0;
  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  )
    head++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > head &&
    endAfter > head &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < head; i++)
    ops.push({ kind: "context", line: before[i]! });
  const midBefore = before.slice(head, endBefore);
  const midAfter = after.slice(head, endAfter);

  if (
    midBefore.length === 0 ||
    midAfter.length === 0 ||
    midBefore.length * midAfter.length > 1_000_000
  ) {
    for (const line of midBefore) ops.push({ kind: "remove", line });
    for (const line of midAfter) ops.push({ kind: "add", line });
  } else {
    const rows = midBefore.length;
    const columns = midAfter.length;
    const lcs = new Uint32Array((rows + 1) * (columns + 1));
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        lcs[i * (columns + 1) + j] =
          midBefore[i] === midAfter[j]
            ? lcs[(i + 1) * (columns + 1) + (j + 1)]! + 1
            : Math.max(
                lcs[(i + 1) * (columns + 1) + j]!,
                lcs[i * (columns + 1) + (j + 1)]!,
              );
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (midBefore[i] === midAfter[j]) {
        ops.push({ kind: "context", line: midBefore[i]! });
        i++;
        j++;
      } else if (
        lcs[(i + 1) * (columns + 1) + j]! >= lcs[i * (columns + 1) + (j + 1)]!
      ) {
        ops.push({ kind: "remove", line: midBefore[i]! });
        i++;
      } else {
        ops.push({ kind: "add", line: midAfter[j]! });
        j++;
      }
    }
    while (i < rows) ops.push({ kind: "remove", line: midBefore[i++]! });
    while (j < columns) ops.push({ kind: "add", line: midAfter[j++]! });
  }

  for (let i = endBefore; i < before.length; i++)
    ops.push({ kind: "context", line: before[i]! });
  return ops;
}

function hunkRange(start: number, count: number): string {
  if (count === 0) return `0,0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

function renderHunks(ops: readonly DiffOp[], context = 3): string[] {
  const oldLineAt: number[] = [];
  const newLineAt: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    oldLineAt.push(oldLine);
    newLineAt.push(newLine);
    if (op.kind !== "add") oldLine++;
    if (op.kind !== "remove") newLine++;
  }

  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== "context") changed.push(index);
  });
  if (changed.length === 0) return [];

  const ranges: { first: number; last: number }[] = [];
  let first = changed[0]!;
  let last = changed[0]!;
  for (const index of changed.slice(1)) {
    if (index - last <= context * 2) last = index;
    else {
      ranges.push({ first, last });
      first = index;
      last = index;
    }
  }
  ranges.push({ first, last });

  const hunks: string[] = [];
  for (const range of ranges) {
    const from = Math.max(0, range.first - context);
    const to = Math.min(ops.length - 1, range.last + context);
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.kind !== "add").length;
    const newCount = slice.filter((op) => op.kind !== "remove").length;
    hunks.push(
      `@@ -${hunkRange(oldLineAt[from]!, oldCount)} +${hunkRange(newLineAt[from]!, newCount)} @@`,
    );
    for (const op of slice) {
      const prefix =
        op.kind === "context" ? " " : op.kind === "remove" ? "-" : "+";
      hunks.push(`${prefix}${op.line}`);
    }
  }
  return hunks;
}

export interface DiffOptions {
  /**
   * Pre-image text per normalised patch path, read from the tree the patch was based on. Required for
   * `update` and `delete`; a `create` needs none because its pre-image is empty by definition.
   */
  readonly preimages?: Readonly<Record<string, string>>;
}

/** Read the pre-image bodies a patch declares, from the tree it is based on. */
export function preimagesForRoot(
  root: string,
  payload: PatchRecordPayload,
): Record<string, string> {
  const preimages: Record<string, string> = {};
  for (const file of payload.files) {
    if (file.action === "create") continue;
    const target = assertContained(root, normalizeRepoPath(file.path));
    preimages[normalizeRepoPath(file.path)] = existsSync(target)
      ? readFileSync(target, "utf8")
      : "";
  }
  return preimages;
}

/**
 * Standard unified diff derived from the recorded pre-image and content. The diff is derived output for
 * review and the report only: the recorded file bodies are what gets applied, and this text is never
 * parsed back into a patch. A missing pre-image for an `update`/`delete` is a hard error rather than a
 * fabricated "empty old file" diff.
 */
export function renderUnifiedDiff(
  payload: PatchRecordPayload,
  options: DiffOptions = {},
): string {
  const sections: string[] = [];
  for (const file of payload.files) {
    const relative = normalizeRepoPath(file.path);
    const preimageText =
      file.action === "create" ? "" : options.preimages?.[relative];
    if (file.action !== "create" && preimageText === undefined) {
      throw new DeepError(
        "GM2DEEP-PATCH-PREIMAGE-MISSING",
        `cannot render a diff for ${file.action} of ${relative} without its pre-image text`,
        { path: relative, action: file.action },
      );
    }
    const before = toLines(preimageText ?? "");
    const after = file.action === "delete" ? [] : toLines(file.content);
    const header = [
      `--- ${file.action === "create" ? "/dev/null" : `a/${relative}`}`,
      `+++ ${file.action === "delete" ? "/dev/null" : `b/${relative}`}`,
    ];
    sections.push(
      `${[...header, ...renderHunks(diffLines(before, after))].join("\n")}\n`,
    );
  }
  return sections.join("");
}
