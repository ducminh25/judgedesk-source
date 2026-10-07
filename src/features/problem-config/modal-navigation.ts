export const CONFIG_TABS = ["basic", "tests", "compile"] as const;
export type ConfigTab = typeof CONFIG_TABS[number];

export function nextConfigTab(current: ConfigTab, key: string): ConfigTab | null {
  const index = CONFIG_TABS.indexOf(current);
  if (key === "Home") return CONFIG_TABS[0];
  if (key === "End") return CONFIG_TABS[CONFIG_TABS.length - 1];
  if (key === "ArrowRight") return CONFIG_TABS[(index + 1) % CONFIG_TABS.length];
  if (key === "ArrowLeft") return CONFIG_TABS[(index + CONFIG_TABS.length - 1) % CONFIG_TABS.length];
  return null;
}

export function problemScoreSummary(total: number | string | null | undefined, sum: string): string {
  // Match the existing save presence rule, including an explicit numeric zero.
  return total !== null && total !== undefined && String(total).trim() !== ""
    ? String(total)
    : sum;
}

export function problemIoMode(interactive: boolean, stdin: boolean, stdout: boolean) {
  if (interactive) return "interactive";
  if (stdin && stdout) return "standard";
  if (stdin) return "stdinFile";
  if (stdout) return "fileStdout";
  return "file";
}
