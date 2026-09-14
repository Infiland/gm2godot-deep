/** Source locations use one-based lines and UTF-16 columns, matching JavaScript string offsets. */
export interface ReadRange {
  startLine: number;
  startColumn: number;
  maxLines: number;
  maxChars: number;
}
export interface SourceSlice {
  text: string;
  startOffset: number;
  endOffset: number;
  totalChars: number;
  totalLines: number;
  nextLine: number | null;
  nextColumn: number | null;
}
export function readTextRange(content: string, range: ReadRange): SourceSlice {
  const lines = content.split("\n");
  if (
    range.startLine > lines.length ||
    range.startColumn > (lines[range.startLine - 1]?.length ?? 0) + 1
  )
    throw new Error("Source range is outside the file");
  const startOffset =
    lines
      .slice(0, range.startLine - 1)
      .reduce((n, line) => n + line.length + 1, 0) +
    range.startColumn -
    1;
  const lineLimit = Math.min(
    content.length,
    lines
      .slice(0, Math.min(lines.length, range.startLine - 1 + range.maxLines))
      .reduce((n, line) => n + line.length + 1, 0),
  );
  const endOffset = Math.min(
    startOffset + range.maxChars,
    lineLimit,
    content.length,
  );
  const chunk = content.slice(startOffset, endOffset);
  const text = chunk
    .split("\n")
    .map(
      (line, index) =>
        `${range.startLine + index}:${index === 0 ? range.startColumn : 1}: ${line}`,
    )
    .join("\n");
  const prefix = content.slice(0, endOffset);
  const lastNewline = prefix.lastIndexOf("\n");
  return {
    text,
    startOffset,
    endOffset,
    totalChars: content.length,
    totalLines: lines.length,
    nextLine: endOffset === content.length ? null : prefix.split("\n").length,
    nextColumn: endOffset === content.length ? null : endOffset - lastNewline,
  };
}
export class SourceReadCoverage {
  private ranges = new Map<
    string,
    { total: number; intervals: [number, number][] }
  >();
  record(path: string, start: number, end: number, total: number): void {
    const record = this.ranges.get(path) ?? { total, intervals: [] };
    record.intervals.push([start, end]);
    record.intervals.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const interval of record.intervals) {
      const previous = merged.at(-1);
      if (previous && interval[0] <= previous[1])
        previous[1] = Math.max(previous[1], interval[1]);
      else merged.push([...interval]);
    }
    record.intervals = merged;
    this.ranges.set(path, record);
  }
  complete(path: string): boolean {
    const record = this.ranges.get(path);
    return (
      !!record &&
      (record.total === 0 ||
        (record.intervals[0]?.[0] === 0 &&
          record.intervals[0][1] >= record.total))
    );
  }
}
