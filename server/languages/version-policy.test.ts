import assert from "node:assert/strict";
import test from "node:test";
import type { ToolchainVersionPolicy } from "./contracts.js";
import {
  compareToolchainVersions,
  isToolchainVersionAllowed,
  toolchainVersionPolicyLabels,
  validateToolchainVersionPolicy,
} from "./version-policy.js";

const exact = {
  kind: "exact_allowlist",
  entries: [{
    family: "go",
    distributor: "Go project",
    version: "1.26.5",
    build: "official-binary",
    identityPolicyId: "go.host-target-stdlib-v1",
    hosts: [
      { platform: "win32", arch: "x64" },
      { platform: "darwin", arch: "arm64" },
    ],
  }],
} satisfies ToolchainVersionPolicy;

const bounded = {
  kind: "bounded_range",
  minInclusive: "14.2.0",
  maxExclusive: "17.0.0",
  testedMajors: [14, 16],
} satisfies ToolchainVersionPolicy;

test("exact policies do not accept newer untested patches", () => {
  assert.doesNotThrow(() => validateToolchainVersionPolicy(exact));
  assert.equal(isToolchainVersionAllowed("1.26.5", exact), true);
  assert.equal(isToolchainVersionAllowed("1.26.6", exact), false);
  assert.equal(isToolchainVersionAllowed("v1.26.5", exact), false);
  assert.equal(
    isToolchainVersionAllowed(
      "1.26.5",
      exact,
      { platform: "darwin", arch: "x64" },
    ),
    false,
  );
  assert.deepEqual(toolchainVersionPolicyLabels(exact), ["1.26.5"]);
  assert.deepEqual(
    toolchainVersionPolicyLabels(
      exact,
      { platform: "win32", arch: "x64" },
    ),
    ["1.26.5"],
  );
});

test("bounded policies still require an explicitly tested major", () => {
  assert.doesNotThrow(() => validateToolchainVersionPolicy(bounded));
  assert.equal(isToolchainVersionAllowed("14.2.0", bounded), true);
  assert.equal(isToolchainVersionAllowed("16.1.0", bounded), true);
  assert.equal(isToolchainVersionAllowed("15.1.0", bounded), false);
  assert.equal(isToolchainVersionAllowed("17.0.0", bounded), false);
  assert.equal(compareToolchainVersions("14.2", "14.2.0"), 0);
});

test("minimum policies accept any version greater than or equal to minimum", () => {
  const minimumPolicy = {
    kind: "minimum_only",
    minInclusive: "9.0.0",
  } satisfies ToolchainVersionPolicy;

  assert.doesNotThrow(() => validateToolchainVersionPolicy(minimumPolicy));
  assert.equal(isToolchainVersionAllowed("9.0.0", minimumPolicy), true);
  assert.equal(isToolchainVersionAllowed("21.0.0", minimumPolicy), true);
  assert.equal(isToolchainVersionAllowed("8.9.9", minimumPolicy), false);
  assert.equal(isToolchainVersionAllowed("v9.0.0", minimumPolicy), false);
  assert.deepEqual(toolchainVersionPolicyLabels(minimumPolicy), [">=9.0.0"]);
});

test("host matrix policies resolve per host platform and architecture", () => {
  const matrixPolicy = {
    kind: "host_matrix",
    rules: [
      {
        hosts: [{ platform: "win32", arch: "x64" }],
        policy: {
          kind: "bounded_range",
          minInclusive: "9.0.0",
          maxExclusive: "18.0.0",
          testedMajors: [9, 10, 11, 12, 13, 14, 15, 16, 17],
        },
      },
      {
        hosts: [{ platform: "darwin", arch: "arm64" }],
        policy: {
          kind: "minimum_only",
          minInclusive: "9.0.0",
        },
      },
    ],
  } satisfies ToolchainVersionPolicy;

  assert.doesNotThrow(() => validateToolchainVersionPolicy(matrixPolicy));

  // Without host, fail-closed
  assert.equal(isToolchainVersionAllowed("21.0.0", matrixPolicy), false);

  // macOS arm64: minimum_only (accepts >=9.0.0, including 21.0.0)
  assert.equal(
    isToolchainVersionAllowed("21.0.0", matrixPolicy, { platform: "darwin", arch: "arm64" }),
    true,
  );
  assert.equal(
    isToolchainVersionAllowed("8.5.0", matrixPolicy, { platform: "darwin", arch: "arm64" }),
    false,
  );

  // Windows x64: bounded_range (rejects 21.0.0, accepts 14.2.0)
  assert.equal(
    isToolchainVersionAllowed("14.2.0", matrixPolicy, { platform: "win32", arch: "x64" }),
    true,
  );
  assert.equal(
    isToolchainVersionAllowed("21.0.0", matrixPolicy, { platform: "win32", arch: "x64" }),
    false,
  );

  // Labels
  assert.deepEqual(
    toolchainVersionPolicyLabels(matrixPolicy, { platform: "darwin", arch: "arm64" }),
    [">=9.0.0"],
  );
  assert.deepEqual(
    toolchainVersionPolicyLabels(matrixPolicy, { platform: "win32", arch: "x64" }),
    ["9.0.0–<18.0.0", "majors: 9, 10, 11, 12, 13, 14, 15, 16, 17"],
  );
});

test("invalid policies fail before the registry can be published", () => {
  assert.throws(
    () => validateToolchainVersionPolicy({
      kind: "bounded_range",
      minInclusive: "17.0.0",
      maxExclusive: "14.0.0",
      testedMajors: [17],
    }),
    /invalid/,
  );
  assert.throws(
    () => validateToolchainVersionPolicy({
      kind: "exact_allowlist",
      entries: [{
        family: "go",
        version: "latest",
        build: "official",
        identityPolicyId: "go.identity",
        hosts: [{ platform: "win32", arch: "x64" }],
      }],
    }),
    /invalid/,
  );
  assert.throws(
    () => validateToolchainVersionPolicy({
      kind: "minimum_only",
      minInclusive: "latest",
    }),
    /invalid/,
  );
  assert.throws(
    () => validateToolchainVersionPolicy({
      kind: "host_matrix",
      rules: [
        {
          hosts: [{ platform: "win32", arch: "x64" }],
          policy: { kind: "minimum_only", minInclusive: "9.0.0" },
        },
        {
          hosts: [{ platform: "win32", arch: "x64" }],
          policy: { kind: "minimum_only", minInclusive: "9.0.0" },
        },
      ],
    }),
    /invalid|duplicate/,
  );
});
