export function reconcileSelection(
  names: string[],
  previous: Record<string, boolean>,
): Record<string, boolean> {
  return Object.fromEntries(names.map((name) => [name, previous[name] ?? true]));
}
