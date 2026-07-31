import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const extractorScript = fileURLToPath(
  new URL("./extract-toolchain-release-archive.py", import.meta.url),
);

export interface ReleaseArchiveExtractionSummary {
  fileCount: number;
  installedSizeBytes: number;
  materializedSizeBytes: number;
}

export function extractToolchainReleaseArchive(
  archivePath: string,
  destination: string,
  format: "zip" | "tar.gz",
): ReleaseArchiveExtractionSummary {
  const python = process.env.JUDGEDESK_PACKAGING_PYTHON
    || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(
    python,
    [
      extractorScript,
      path.resolve(archivePath),
      path.resolve(destination),
      format,
    ],
    {
      encoding: "utf8",
      timeout: 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      result.stderr?.trim()
      || result.stdout?.trim()
      || result.error?.message
      || `Release archive extraction failed with status ${result.status}.`,
    );
  }
  let summary: unknown;
  try {
    summary = JSON.parse(result.stdout);
  } catch {
    throw new Error("Release archive extractor returned invalid metadata.");
  }
  if (
    !summary
    || typeof summary !== "object"
    || !Number.isSafeInteger(
      (summary as ReleaseArchiveExtractionSummary).fileCount,
    )
    || !Number.isSafeInteger(
      (summary as ReleaseArchiveExtractionSummary).installedSizeBytes,
    )
    || !Number.isSafeInteger(
      (summary as ReleaseArchiveExtractionSummary).materializedSizeBytes,
    )
    || (summary as ReleaseArchiveExtractionSummary).fileCount <= 0
    || (summary as ReleaseArchiveExtractionSummary).installedSizeBytes <= 0
    || (summary as ReleaseArchiveExtractionSummary).materializedSizeBytes <= 0
  ) {
    throw new Error("Release archive extractor returned invalid metadata.");
  }
  return summary as ReleaseArchiveExtractionSummary;
}
