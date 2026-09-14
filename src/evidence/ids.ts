import { createHash } from "node:crypto";

/** File-name-safe encodings for ids that appear in artifact paths. */

const MAX_ENCODED_ID_LENGTH = 120;

/** Encode an id as a readable path segment, bounding long ids with a hash suffix. */
export function encodeId(id: string): string {
  const safe = id
    .replace(/:/g, "%3A")
    .replace(/\//g, "%2F")
    .replace(/\\/g, "%5C")
    .replace(/\+/g, "%2B");
  if (safe.length <= MAX_ENCODED_ID_LENGTH) return safe;
  const digest = createHash("sha256")
    .update(id, "utf8")
    .digest("hex")
    .slice(0, 24);
  const prefixLength = MAX_ENCODED_ID_LENGTH - digest.length - 2;
  return `${safe.slice(0, prefixLength)}~${digest}`;
}

export function decodeId(encoded: string): string {
  return encoded
    .replace(/%3A/g, ":")
    .replace(/%2F/g, "/")
    .replace(/%5C/g, "\\")
    .replace(/%2B/g, "+");
}

/** Ids that are safe as a single path segment; anything else is rejected rather than mangled. */
export function assertPlainId(id: string, label: string): void {
  if (id.length === 0 || /[/\\\0]/.test(id) || id === "." || id === "..") {
    throw new Error(
      `${label} ${JSON.stringify(id)} is not usable as a path segment`,
    );
  }
}
