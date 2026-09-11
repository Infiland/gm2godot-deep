/** File-name-safe encodings for ids that appear in artifact paths. */

/** `script:scr_math` → `script%3Ascr_math`; `:` is illegal on some filesystems and confusing everywhere. */
export function encodeId(id: string): string {
  return id.replace(/:/g, "%3A").replace(/\//g, "%2F").replace(/\+/g, "%2B");
}

export function decodeId(encoded: string): string {
  return encoded.replace(/%3A/g, ":").replace(/%2F/g, "/").replace(/%2B/g, "+");
}

/** Ids that are safe as a single path segment; anything else is rejected rather than mangled. */
export function assertPlainId(id: string, label: string): void {
  if (id.length === 0 || /[/\\\0]/.test(id) || id === "." || id === "..") {
    throw new Error(`${label} ${JSON.stringify(id)} is not usable as a path segment`);
  }
}
