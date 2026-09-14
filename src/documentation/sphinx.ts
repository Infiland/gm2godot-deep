export interface SphinxIndex {
  docnames?: string[];
  terms?: Record<string, number | number[]>;
  titleterms?: Record<string, number | number[]>;
  alltitles?: Record<string, [number, string][]>;
}
/** Sphinx stems API names too: get_tree => get_tre, move_and_slide => move_and_slid. */
export function sphinxMatches(
  index: SphinxIndex,
  query: string,
): Map<string, number> {
  const matches = new Map<string, number>();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const add = (id: number, weight: number): void => {
    const name = index.docnames?.[id];
    if (name) matches.set(name, (matches.get(name) ?? 0) + weight);
  };
  for (const term of terms) {
    const variants = new Set([
      term,
      term.replace(/e$/, ""),
      term.replace(/ies$/, "i"),
      term.replace(/s$/, ""),
      term.replace(/y$/, "i"),
    ]);
    for (const [table, weight] of [
      [index.terms, 2],
      [index.titleterms, 4],
    ] as const) {
      for (const variant of variants) {
        const entries = table?.[variant];
        if (entries !== undefined)
          for (const id of Array.isArray(entries) ? entries : [entries])
            add(id, weight);
      }
    }
    for (const [title, entries] of Object.entries(index.alltitles ?? {})) {
      if (title.toLowerCase().includes(term))
        for (const [id] of entries) add(id, 5);
    }
  }
  return matches;
}
