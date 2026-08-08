import assert from "node:assert/strict";
import test from "node:test";
import type {
  ResolvedToolchain,
  ToolchainKind,
} from "../toolchains/types.js";
import {
  assertJudgeToolchainPreflight,
  type JudgeToolchainRequirements,
  type PinnedJudgeToolchains,
} from "./toolchain-preflight.js";

const KINDS: readonly ToolchainKind[] = [
  "cpp",
  "c",
  "python",
  "pascal",
  "go",
  "java",
  "rust",
  "javascript",
  "csharp",
];

function toolchain(
  kind: ToolchainKind,
  overrides: Partial<ResolvedToolchain> = {},
): ResolvedToolchain {
  return {
    kind,
    source: "managed",
    executablePath: `C:\\managed\\${kind}.exe`,
    version: "test",
    ready: true,
    provenance: "managed-package",
    ...overrides,
  };
}

function pins(
  overrides: Partial<Record<ToolchainKind, ResolvedToolchain>> = {},
): PinnedJudgeToolchains {
  return Object.fromEntries(
    KINDS.map((kind) => [kind, overrides[kind] ?? toolchain(kind)]),
  ) as PinnedJudgeToolchains;
}

function requirements(
  submissions: readonly ToolchainKind[],
  checkers: readonly ToolchainKind[] = [],
): JudgeToolchainRequirements {
  return {
    submissions: new Set(submissions),
    checkers: new Set(checkers),
  };
}

function localIdentity(
  executableRelativePath: string,
  isolation: "strict" | "resource-only" = "strict",
) {
  return {
    rootPath: String.raw`C:\local-toolchain`,
    executableRelativePath,
    isolation,
  } as const;
}

test("preflight accepts only the pinned roles required by the selected batch", () => {
  assert.doesNotThrow(() => assertJudgeToolchainPreflight(
    requirements(["cpp"], ["cpp"]),
    pins({
      python: toolchain("python", {
        ready: false,
        diagnosticCode: "MANAGED_PACKAGE_NOT_INSTALLED",
      }),
    }),
    "win32",
  ));
});

test("preflight accepts managed C but rejects an uncertified local C compiler", () => {
  assert.doesNotThrow(() =>
    assertJudgeToolchainPreflight(requirements(["c"]), pins(), "win32")
  );
  assert.throws(
    () => assertJudgeToolchainPreflight(
      requirements(["c"]),
      pins({
        c: toolchain("c", {
          source: "custom",
          provenance: "unverified-local",
          diagnosticCode: "CERTIFICATION_REQUIRED",
        }),
      }),
      "win32",
    ),
    /C submissions: CERTIFICATION_REQUIRED/,
  );
});

test("preflight rejects uncertified local Windows C++ before contestant compilation", () => {
  assert.throws(
    () => assertJudgeToolchainPreflight(
      requirements(["cpp"]),
      pins({
        cpp: toolchain("cpp", {
          source: "custom",
          provenance: "unverified-local",
          diagnosticCode: "CERTIFICATION_REQUIRED",
        }),
      }),
      "win32",
    ),
    /TOOLCHAIN_PREFLIGHT_FAILED: C\+\+ submissions: CERTIFICATION_REQUIRED/,
  );
});

test("preflight rejects local Python independently for submissions and checkers", () => {
  assert.throws(
    () => assertJudgeToolchainPreflight(
      requirements(["python"], ["python"]),
      pins({
        python: toolchain("python", {
          source: "custom",
          provenance: "unverified-local",
          diagnosticCode: "CERTIFICATION_REQUIRED",
        }),
      }),
      "win32",
    ),
    /Python submissions: CERTIFICATION_REQUIRED; Python checkers: CERTIFICATION_REQUIRED/,
  );
});

test("preflight accepts admitted local C and Python grants in strict or resource-only mode", () => {
  assert.doesNotThrow(() => assertJudgeToolchainPreflight(
    requirements(["c", "python"], ["python"]),
    pins({
      c: toolchain("c", {
        source: "custom",
        provenance: "unverified-local",
        localToolchain: localIdentity("bin/gcc.exe"),
      }),
      python: toolchain("python", {
        source: "system",
        provenance: "unverified-local",
        localToolchain: localIdentity("python.exe", "resource-only"),
      }),
    }),
    "win32",
  ));
});

test("new compiled/runtime profiles are admitted only from a managed package", () => {
  for (const kind of [
    "pascal",
    "go",
    "java",
    "rust",
    "javascript",
    "csharp",
  ] as const) {
    assert.doesNotThrow(() =>
      assertJudgeToolchainPreflight(requirements([kind]), pins(), "win32")
    );
    assert.throws(
      () => assertJudgeToolchainPreflight(
        requirements([kind]),
        pins({
          [kind]: toolchain(kind, {
            source: "system",
            provenance: "unverified-local",
            diagnosticCode: "CERTIFICATION_REQUIRED",
          }),
        }),
        "win32",
      ),
      new RegExp(`${kind === "csharp" ? "C#" : kind}`, "i"),
    );
  }
});
