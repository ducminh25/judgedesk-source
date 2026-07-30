import fs from "node:fs";
import path from "node:path";
import { RESOURCE_ROOT } from "./runtime.js";

export type JudgeDeskDistribution = "full" | "core" | "development";

interface DistributionDocumentV1 {
  schemaVersion: 1;
  distribution: "full" | "core";
}

const MAX_DISTRIBUTION_DOCUMENT_BYTES = 4 * 1024;

export function getJudgeDeskDistribution(
  options: {
    environment?: NodeJS.ProcessEnv;
    resourceRoot?: string;
  } = {},
): JudgeDeskDistribution {
  const environment = options.environment ?? process.env;
  const override = environment.JUDGEDESK_DISTRIBUTION;
  if (override !== undefined) {
    if (override === "full" || override === "core" || override === "development") {
      return override;
    }
    return "development";
  }

  const filePath = path.join(
    options.resourceRoot ?? RESOURCE_ROOT,
    "judgedesk-distribution.json",
  );
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    return "development";
  }
  if (
    bytes.byteLength === 0
    || bytes.byteLength > MAX_DISTRIBUTION_DOCUMENT_BYTES
  ) {
    return "development";
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return "development";
  }
  if (
    !isRecord(value)
    || Object.keys(value).length !== 2
    || value.schemaVersion !== 1
    || (value.distribution !== "full" && value.distribution !== "core")
  ) {
    return "development";
  }
  return (value as unknown as DistributionDocumentV1).distribution;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
