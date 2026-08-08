import type {
  CompileFlags,
  CompileLanguage,
  CompileProfile,
  ProblemCompileConfig,
} from "./contracts.js";

export const COMPILE_CONFIG_SCHEMA_VERSION = 1 as const;
export const DEFAULT_COMPILE_PROFILE = "themis" as const satisfies CompileProfile;

export type PresetCompileProfile = Exclude<CompileProfile, "custom">;

export const COMPILE_PROFILE_IDS = [
  "themis",
  "modern_ioi_icpc_2025",
  "icpc_world_finals",
  "custom",
] as const satisfies readonly CompileProfile[];

const PRESET_FLAGS: Readonly<Record<PresetCompileProfile, Readonly<Record<CompileLanguage, readonly string[]>>>> = {
  themis: {
    cpp: ["-std=c++14", "-O2", "-pipe"],
    c: ["-std=c11", "-O2", "-pipe"],
  },
  modern_ioi_icpc_2025: {
    cpp: ["-std=gnu++20", "-O2", "-pipe"],
    c: ["-std=gnu17", "-O2", "-pipe"],
  },
  icpc_world_finals: {
    cpp: ["-std=gnu++20", "-O2", "-g"],
    c: ["-std=gnu11", "-O2", "-g"],
  },
};

const COMPILE_PROFILES = new Set<CompileProfile>(COMPILE_PROFILE_IDS);

const MAX_FLAG_COUNT = 128;
const MAX_FLAG_LENGTH = 4_096;
const MAX_FLAGS_TOTAL_LENGTH = 16_384;

export type CompileConfigValidationReason =
  | "generic"
  | "textRequired"
  | "controlCharacters"
  | "unterminatedQuote"
  | "argvRequired"
  | "tooManyFlags"
  | "emptyFlag"
  | "flagTooLong"
  | "flagsTooLong"
  | "responseOrTerminator"
  | "positionalArgument"
  | "compileModeOverride"
  | "sourceOverride"
  | "pluginOverride"
  | "toolchainOverride"
  | "externalRootOverride"
  | "platformFlagOverride";

export interface CompileConfigValidationContext {
  reason?: CompileConfigValidationReason;
  flagNumber?: number;
  token?: string;
  limit?: number;
}

export class CompileConfigValidationError extends Error {
  readonly reason: CompileConfigValidationReason;
  readonly flagNumber?: number;
  readonly token?: string;
  readonly limit?: number;

  constructor(
    message: string,
    context: CompileConfigValidationContext = {},
  ) {
    super(`INVALID_COMPILE_CONFIG: ${message}`);
    this.name = "CompileConfigValidationError";
    this.reason = context.reason ?? "generic";
    this.flagNumber = context.flagNumber;
    this.token = context.token;
    this.limit = context.limit;
  }
}

export function createCompileConfig(
  profile: PresetCompileProfile = DEFAULT_COMPILE_PROFILE,
): ProblemCompileConfig {
  if (!Object.hasOwn(PRESET_FLAGS, profile)) {
    throw new CompileConfigValidationError(`preset profile '${String(profile)}' is unsupported`);
  }
  return {
    schemaVersion: COMPILE_CONFIG_SCHEMA_VERSION,
    profile,
    flags: clonePresetFlags(profile),
  };
}

export function createCustomCompileConfig(flags: unknown): ProblemCompileConfig {
  return {
    schemaVersion: COMPILE_CONFIG_SCHEMA_VERSION,
    profile: "custom",
    flags: normalizeCompileFlags(flags),
  };
}

/**
 * Normalizes the persisted snapshot. Missing metadata is the backwards-
 * compatible Themis profile; present snapshots are preserved so an app update
 * cannot silently change an existing problem's compiler command.
 */
export function normalizeCompileConfig(value?: unknown): ProblemCompileConfig {
  if (value === undefined || value === null) return createCompileConfig();
  if (!isRecord(value)) {
    throw new CompileConfigValidationError("compile must be an object");
  }
  if (
    value.schemaVersion !== undefined
    && value.schemaVersion !== COMPILE_CONFIG_SCHEMA_VERSION
  ) {
    throw new CompileConfigValidationError(
      `unsupported schemaVersion '${String(value.schemaVersion)}'`,
    );
  }
  if (typeof value.profile !== "string" || !COMPILE_PROFILES.has(value.profile as CompileProfile)) {
    throw new CompileConfigValidationError("profile is missing or unsupported");
  }

  const profile = value.profile as CompileProfile;
  if (value.flags === undefined) {
    if (profile === "custom") {
      throw new CompileConfigValidationError("custom profile requires cpp and c flag arrays");
    }
    return createCompileConfig(profile);
  }

  return {
    schemaVersion: COMPILE_CONFIG_SCHEMA_VERSION,
    profile,
    flags: normalizeCompileFlags(value.flags),
  };
}

export function getCompileFlags(
  config: ProblemCompileConfig | undefined,
  language: CompileLanguage,
): string[] {
  return normalizeCompileConfig(config).flags[language];
}

/** Tokenizes a familiar command-line fragment without invoking a shell. */
export function parseCustomCompileFlags(input: string): string[] {
  if (typeof input !== "string") {
    throw new CompileConfigValidationError("flags input must be text", {
      reason: "textRequired",
    });
  }
  if (input.includes("\0") || input.includes("\r") || input.includes("\n")) {
    throw new CompileConfigValidationError("flags cannot contain NUL or newlines", {
      reason: "controlCharacters",
    });
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let tokenStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (character === "\\" && quote === "\"") {
        const next = input[index + 1];
        if (next === "\"" || next === "\\") {
          current += next;
          tokenStarted = true;
          index += 1;
          continue;
        }
      }
      current += character;
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    if (character === "\\") {
      const next = input[index + 1];
      if (next !== undefined && (/\s/u.test(next) || next === "'" || next === "\"" || next === "\\")) {
        current += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
    }
    current += character;
    tokenStarted = true;
  }

  if (quote) {
    throw new CompileConfigValidationError("unterminated quoted flag", {
      reason: "unterminatedQuote",
    });
  }
  if (tokenStarted) tokens.push(current);
  return tokens;
}

export function parseAndValidateCustomCompileFlags(input: string): string[] {
  return validateCustomCompileFlags(parseCustomCompileFlags(input));
}

export function validateCustomCompileFlags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new CompileConfigValidationError("flags must be an argv array", {
      reason: "argvRequired",
    });
  }
  if (value.length > MAX_FLAG_COUNT) {
    throw new CompileConfigValidationError(`at most ${MAX_FLAG_COUNT} flags are allowed`, {
      reason: "tooManyFlags",
      limit: MAX_FLAG_COUNT,
    });
  }

  let totalLength = 0;
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new CompileConfigValidationError(`flag ${index + 1} must be a non-empty string`, {
        reason: "emptyFlag",
        flagNumber: index + 1,
      });
    }
    if (entry.length > MAX_FLAG_LENGTH) {
      throw new CompileConfigValidationError(`flag ${index + 1} is too long`, {
        reason: "flagTooLong",
        flagNumber: index + 1,
        limit: MAX_FLAG_LENGTH,
      });
    }
    if (entry.includes("\0") || entry.includes("\r") || entry.includes("\n")) {
      throw new CompileConfigValidationError(`flag ${index + 1} contains a forbidden control character`, {
        reason: "controlCharacters",
        flagNumber: index + 1,
      });
    }
    totalLength += entry.length;
    if (totalLength > MAX_FLAGS_TOTAL_LENGTH) {
      throw new CompileConfigValidationError("combined flags are too long", {
        reason: "flagsTooLong",
        limit: MAX_FLAGS_TOTAL_LENGTH,
      });
    }
    assertSafeCompileFlag(entry, index);
    return entry;
  });
}

function clonePresetFlags(profile: PresetCompileProfile): CompileFlags {
  return {
    cpp: [...PRESET_FLAGS[profile].cpp],
    c: [...PRESET_FLAGS[profile].c],
  };
}

function normalizeCompileFlags(value: unknown): CompileFlags {
  if (!isRecord(value)) {
    throw new CompileConfigValidationError("flags must contain cpp and c argv arrays");
  }
  return {
    cpp: validateCustomCompileFlags(value.cpp),
    c: validateCustomCompileFlags(value.c),
  };
}

function assertSafeCompileFlag(token: string, index: number): void {
  const lower = token.toLowerCase();
  const reject = (
    reason: CompileConfigValidationReason,
    message: string,
  ): never => {
    throw new CompileConfigValidationError(`flag ${index + 1} '${token}' ${message}`, {
      reason,
      flagNumber: index + 1,
      token,
    });
  };

  if (token.startsWith("@") || token === "--") {
    reject("responseOrTerminator", "cannot use response files or terminate JudgeDesk-managed arguments");
  }
  if (!token.startsWith("-") || token === "-") {
    reject("positionalArgument", "cannot add a source file, output file, or positional argument");
  }

  if (
    token === "-o"
    || token.startsWith("-o")
    || lower === "--output"
    || lower.startsWith("--output=")
    || token === "-c"
    || token === "-S"
    || token === "-E"
    || /^-M(?:$|M$|D|MD|F|T|Q|J|P$|G$)/u.test(token)
    || lower === "-fsyntax-only"
    || lower.startsWith("-save-temps")
    || lower.startsWith("--serialize-diagnostics")
  ) {
    reject("compileModeOverride", "would override the protected compilation mode or output");
  }

  if (
    lower === "-x"
    || lower.startsWith("-x=")
    || lower === "-include"
    || lower.startsWith("-include=")
    || lower === "-imacros"
    || lower.startsWith("-imacros=")
  ) {
    reject("sourceOverride", "would override the protected source or language");
  }

  if (
    lower.startsWith("-fplugin")
    || lower.startsWith("-fpass-plugin")
    || lower === "-xclang"
    || lower.startsWith("-xclang=")
    || lower === "-mllvm"
    || lower.startsWith("-mllvm=")
    || lower === "-load"
    || lower.startsWith("-load=")
    || lower === "-plugin"
    || lower.startsWith("-plugin=")
  ) {
    reject("pluginOverride", "cannot load compiler plugins or internal compiler commands");
  }

  if (
    token === "-B"
    || token.startsWith("-B")
    || lower === "--sysroot"
    || lower.startsWith("--sysroot=")
    || lower === "-isysroot"
    || lower.startsWith("-isysroot=")
    || lower === "--gcc-toolchain"
    || lower.startsWith("--gcc-toolchain=")
    || lower === "-gcc-toolchain"
    || lower.startsWith("-gcc-toolchain=")
    || lower === "-resource-dir"
    || lower.startsWith("-resource-dir=")
    || lower.startsWith("-specs=")
    || lower === "-specs"
    || lower.startsWith("--specs=")
    || lower === "--specs"
    || lower.startsWith("-wrapper")
    || lower.startsWith("-fuse-ld")
    || lower.startsWith("-stdlib")
    || lower.startsWith("-nostdinc")
    || lower === "-nostdlib"
    || lower === "-nodefaultlibs"
  ) {
    reject("toolchainOverride", "cannot override the managed compiler or toolchain root");
  }

  if (
    token === "-I"
    || token.startsWith("-I")
    || token === "-L"
    || token.startsWith("-L")
    || lower.startsWith("-isystem")
    || lower.startsWith("-iquote")
    || lower.startsWith("-idirafter")
    || token === "-F"
    || token.startsWith("-F")
    || lower.startsWith("-iframework")
  ) {
    reject("externalRootOverride", "cannot add external include, framework, or library roots");
  }

  if (
    lower === "-static"
    || lower === "-s"
    || lower === "-lm"
    || lower.startsWith("-wl,")
    || lower === "-xlinker"
    || lower.startsWith("-xlinker=")
    || lower.startsWith("-wa,")
    || lower.startsWith("-wp,")
  ) {
    reject("platformFlagOverride", "is controlled by the JudgeDesk platform adapter");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
