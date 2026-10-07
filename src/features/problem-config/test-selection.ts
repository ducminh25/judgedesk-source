/** One-based positions in the natural order of the visible test list. */
export function parseTestSelection(input: string, testCount: number): number[] {
  if (!input.trim()) return [];
  const selected = new Set<number>();
  for (const segment of input.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(segment);
    if (!match) throw new Error(`Invalid test selection: ${segment.trim() || "empty item"}`);
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)
      || first < 1 || last < 1 || first > testCount || last > testCount) {
      throw new RangeError(`Test indices must be between 1 and ${testCount}`);
    }
    const start = Math.min(first, last);
    const end = Math.max(first, last);
    for (let index = start; index <= end; ++index) selected.add(index);
  }
  return [...selected].sort((a, b) => a - b);
}

export function formatTestSelection(indices: readonly number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) ++end;
    parts.push(end === i ? String(sorted[i]) : `${sorted[i]}-${sorted[end]}`);
    i = end + 1;
  }
  return parts.join(", ");
}
