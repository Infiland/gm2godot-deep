import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

/** Streaming hash so large binary assets never land in memory. */
export function sha256File(path: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  return promise;
}

/** Hash of a list of `"<path> <sha256>"` lines: identity of a whole tree's contents. */
export function sha256OfEntries(entries: readonly { path: string; sha256: string }[]): string {
  const lines = [...entries]
    .map((entry) => `${entry.path} ${entry.sha256}`)
    .sort()
    .join("\n");
  return sha256Text(lines);
}
