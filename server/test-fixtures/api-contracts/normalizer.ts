import os from "node:os";
import path from "node:path";
import { TEMP_ROOT } from "../../runtime.js";

export interface NormalizerOptions {
  envRootDir?: string;
  tempRoot?: string;
  customReplacements?: Array<{ pattern: RegExp | string; replacement: string }>;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeVolatile(value: unknown, options: NormalizerOptions = {}): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    // Normalize all backslashes first for cross-platform stability
    let result = value.replace(/\\/g, "/");

    if (options.envRootDir) {
      const envRoot = options.envRootDir.replace(/\\/g, "/");
      result = result.replace(new RegExp(escapeRegExp(envRoot), "gi"), "<TEMP_ROOT>/<ISOLATED_ENV>");
    }

    if (options.tempRoot) {
      const tempRoot = options.tempRoot.replace(/\\/g, "/");
      result = result.replace(new RegExp(escapeRegExp(tempRoot), "gi"), "<TEMP_ROOT>/<TEST_CONTEXT>");
    }

    // Generic pattern for isolated jd_* directories under system temp
    result = result.replace(
      /[A-Za-z]:\/(?:[^/]+\/)*Temp\/jd_[^/]+/gi,
      "<TEMP_ROOT>/<ISOLATED_ENV>",
    );
    result = result.replace(
      /(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T\/jd_[^/]+/gi,
      "<TEMP_ROOT>/<ISOLATED_ENV>",
    );
    result = result.replace(
      /\/tmp\/jd_[^/]+/gi,
      "<TEMP_ROOT>/<ISOLATED_ENV>",
    );

    // Generic system temp paths
    result = result.replace(/[A-Za-z]:\/(?:[^/]+\/)*Temp\b/gi, "<TEMP_ROOT>");
    result = result.replace(/(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T\b/gi, "<TEMP_ROOT>");
    result = result.replace(/\/tmp\b/gi, "<TEMP_ROOT>");

    // Replace test context subpaths under temp root
    result = result.replace(
      /<TEMP_ROOT>(?:\/<ISOLATED_ENV>)?(?:\/temp)?\/contract_ctx_[^/]+/g,
      "<TEMP_ROOT>/<TEST_CONTEXT>",
    );

    // Replace UUIDs
    result = result.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<UUID>",
    );

    // Replace ISO timestamps
    result = result.replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g,
      "<TIMESTAMP>",
    );

    // Replace HTTP GMT dates
    result = result.replace(
      /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g,
      "<DATE_GMT>",
    );

    // Replace ephemeral port numbers
    result = result.replace(/127\.0\.0\.1:\d{4,5}/g, "127.0.0.1:<PORT>");

    // Apply custom replacements
    if (options.customReplacements) {
      for (const { pattern, replacement } of options.customReplacements) {
        result = result.replace(
          typeof pattern === "string" ? new RegExp(escapeRegExp(pattern), "g") : pattern,
          replacement,
        );
      }
    }

    return result;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeVolatile(item, options));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const val = record[key];
      if (key === "pathRank" && typeof val === "number") {
        result[key] = "<PATH_RANK>";
      } else if (
        (key === "revision" || key === "expectedPreferenceRevision") &&
        typeof val === "string"
      ) {
        result[key] = "<REVISION>";
      } else if (key === "appVersion" && (val === "development" || val === "1.5.0")) {
        result[key] = "1.5.0";
      } else {
        result[key] = normalizeVolatile(val, options);
      }
    }
    return result;
  }

  return value;
}

export function parseSseInitialEvent(rawText: string): unknown {
  let eventType = "message";
  let eventData = "";
  const lines = rawText.split("\n");
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      eventData = line.slice("data:".length).trim();
    } else if (line.startsWith(":")) {
      return {
        protocol: "text/event-stream",
        comment: line.slice(1).trim(),
      };
    }
  }
  let parsedData: unknown = eventData;
  try {
    parsedData = JSON.parse(eventData);
  } catch {
    // leave as string
  }
  return {
    protocol: "text/event-stream",
    initialEvent: {
      type: eventType === "osd_status" ? "status" : eventType,
      data: parsedData,
    },
  };
}

export function parseNdjsonStream(rawText: string): unknown[] {
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
  const events: unknown[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ raw: line });
    }
  }
  return events;
}
