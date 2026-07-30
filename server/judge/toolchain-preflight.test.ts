import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedToolchain } from "../toolchains/types.js";
import { assertJudgeToolchainPreflight } from "./toolchain-preflight.js";

function toolchain(
  kind: "cpp" | "c" | "python",
  overrides: Partial<ResolvedToolchain> = {},
): ResolvedToolchain {
  return {
    kind,
    source: "managed",
    executablePath: `C:\\managed\\${kind}.exe`,
    version: "test",
    ready: true,
    ...overrides,
  };
}

test("preflight accepts only the pinned roles required by the selected batch", () => {
  assert.doesNotThrow(() => assertJudgeToolchainPreflight(
    {
      cppSubmission: true,
      cSubmission: false,
      pythonSubmission: false,
      cppChecker: true,
      pythonChecker: false,
    },
    {
      cpp: toolchain("cpp"),
      c: toolchain("c"),
      python: toolchain("python", {
        ready: false,
        diagnosticCode: "MANAGED_PACKAGE_NOT_INSTALLED",
      }),
    },
    "win32",
  ));
});

test("preflight accepts managed C but rejects an uncertified local C compiler", () => {
  const requirements = {
    cppSubmission: false,
    cSubmission: true,
    pythonSubmission: false,
    cppChecker: false,
    pythonChecker: false,
  };
  const base = {
    cpp: toolchain("cpp"),
    c: toolchain("c", { provenance: "managed-package" }),
    python: toolchain("python"),
  } as const;
  assert.doesNotThrow(() =>
    assertJudgeToolchainPreflight(requirements, base, "win32")
  );
  assert.throws(
    () => assertJudgeToolchainPreflight(
      requirements,
      {
        ...base,
        c: toolchain("c", {
          source: "custom",
          provenance: "unverified-local",
          diagnosticCode: "CERTIFICATION_REQUIRED",
        }),
      },
      "win32",
    ),
    /C submissions: CERTIFICATION_REQUIRED/,
  );
});

test("preflight rejects uncertified local Windows C++ before contestant compilation", () => {
  assert.throws(
    () => assertJudgeToolchainPreflight(
      {
        cppSubmission: true,
        cSubmission: false,
        pythonSubmission: false,
        cppChecker: false,
        pythonChecker: false,
      },
      {
        cpp: toolchain("cpp", {
          source: "custom",
          provenance: "unverified-local",
          diagnosticCode: "CERTIFICATION_REQUIRED",
        }),
        c: toolchain("c"),
        python: toolchain("python"),
      },
      "win32",
    ),
    /TOOLCHAIN_PREFLIGHT_FAILED: C\+\+ submissions: CERTIFICATION_REQUIRED/,
  );
});

test("preflight rejects local Python independently for submissions and checkers", () => {
  assert.throws(
    () => assertJudgeToolchainPreflight(
      {
        cppSubmission: false,
        cSubmission: false,
        pythonSubmission: true,
        cppChecker: false,
        pythonChecker: true,
      },
      {
        cpp: toolchain("cpp"),
        c: toolchain("c"),
        python: toolchain("python", {
          source: "custom",
          diagnosticCode: "CERTIFICATION_REQUIRED",
        }),
      },
      "win32",
    ),
    /Python submissions: CERTIFICATION_REQUIRED; Python checkers: CERTIFICATION_REQUIRED/,
  );
});
