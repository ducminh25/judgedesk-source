import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedToolchain } from "../toolchains/types.js";
import { assertJudgeToolchainPreflight } from "./toolchain-preflight.js";

function toolchain(
  kind: "cpp" | "python",
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
      pythonSubmission: false,
      cppChecker: true,
      pythonChecker: false,
    },
    {
      cpp: toolchain("cpp"),
      python: toolchain("python", {
        ready: false,
        diagnosticCode: "MANAGED_PACKAGE_NOT_INSTALLED",
      }),
    },
    "win32",
  ));
});

test("preflight rejects uncertified local Windows C++ before contestant compilation", () => {
  assert.throws(
    () => assertJudgeToolchainPreflight(
      {
        cppSubmission: true,
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
        pythonSubmission: true,
        cppChecker: false,
        pythonChecker: true,
      },
      {
        cpp: toolchain("cpp"),
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
