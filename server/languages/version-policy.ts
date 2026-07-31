import type {
  HostArchitecture,
  HostPlatform,
  ToolchainVersionPolicy,
} from "./contracts.js";

export interface ToolchainVersionHost {
  platform: HostPlatform;
  arch: HostArchitecture;
}

const VERSION_PATTERN = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){1,3}$/;

function versionParts(version: string): number[] | null {
  if (!VERSION_PATTERN.test(version)) return null;
  const parts = version.split(".").map((part) => Number(part));
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareToolchainVersions(
  left: string,
  right: string,
): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) {
    throw new Error("Toolchain policy versions must use dotted numeric form.");
  }
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Version membership is only the first quick-verification gate. A matching
 * version does not by itself grant readiness: family/build/target, support
 * markers, health and secure-executor policy are checked separately.
 */
export function isToolchainVersionAllowed(
  version: string,
  policy: ToolchainVersionPolicy,
  host?: ToolchainVersionHost,
): boolean {
  const parts = versionParts(version);
  if (!parts) return false;
  if (policy.kind === "exact_allowlist") {
    return policy.entries.some((entry) =>
      entry.version === version
      && (
        !host
        || entry.hosts.some(
          (candidate) =>
            candidate.platform === host.platform
            && candidate.arch === host.arch,
        )
      )
    );
  }
  return (
    policy.testedMajors.includes(parts[0])
    && compareToolchainVersions(version, policy.minInclusive) >= 0
    && compareToolchainVersions(version, policy.maxExclusive) < 0
  );
}

export function validateToolchainVersionPolicy(
  policy: ToolchainVersionPolicy,
): void {
  if (policy.kind === "exact_allowlist") {
    const identities = new Set<string>();
    for (const entry of policy.entries) {
      const hosts = new Set<string>();
      for (const host of entry.hosts) {
        const key = `${host.platform}:${host.arch}`;
        if (
          hosts.has(key)
          || (host.platform !== "win32" && host.platform !== "darwin")
          || (host.arch !== "x64" && host.arch !== "arm64")
        ) {
          throw new Error("Exact toolchain version policy contains invalid host data.");
        }
        hosts.add(key);
      }
      if (
        hosts.size === 0
        || !versionParts(entry.version)
        || !entry.family.trim()
        || !entry.build.trim()
        || !entry.identityPolicyId.trim()
        || (entry.distributor !== undefined && !entry.distributor.trim())
      ) {
        throw new Error("Exact toolchain version policy contains invalid identity data.");
      }
      const identity = [
        entry.family,
        entry.distributor || "",
        entry.version,
        entry.build,
        entry.identityPolicyId,
        [...hosts].sort().join(","),
      ].join("\0");
      if (identities.has(identity)) {
        throw new Error("Exact toolchain version policy contains a duplicate identity.");
      }
      identities.add(identity);
    }
    return;
  }

  if (
    !versionParts(policy.minInclusive)
    || !versionParts(policy.maxExclusive)
    || compareToolchainVersions(
      policy.minInclusive,
      policy.maxExclusive,
    ) >= 0
    || new Set(policy.testedMajors).size !== policy.testedMajors.length
    || policy.testedMajors.some(
      (major) => !Number.isSafeInteger(major) || major < 0,
    )
  ) {
    throw new Error("Bounded toolchain version policy is invalid.");
  }
}

export function toolchainVersionPolicyLabels(
  policy: ToolchainVersionPolicy,
  host?: ToolchainVersionHost,
): string[] {
  return policy.kind === "exact_allowlist"
    ? [
        ...new Set(
          policy.entries
            .filter((entry) =>
              !host
              || entry.hosts.some(
                (candidate) =>
                  candidate.platform === host.platform
                  && candidate.arch === host.arch,
              )
            )
            .map((entry) => entry.version),
        ),
      ]
    : [
        `${policy.minInclusive}–<${policy.maxExclusive}`,
        `majors: ${policy.testedMajors.join(", ")}`,
      ];
}
