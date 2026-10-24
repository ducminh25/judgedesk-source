/** Deterministic Linux differences from the canonical Windows contract fixtures. */
export function adaptLinuxFixture(caseId: string, fixture: unknown): unknown {
  if (caseId === "delete-toolchain") return fixture;
  const portablePaths = JSON.stringify(fixture)
    .replaceAll("-windows-x64", "-linux-x64")
    .replaceAll("bin/g++.exe", "bin/g++")
    .replaceAll("bin/gcc.exe", "bin/gcc")
    .replaceAll("/python.exe", "/bin/python3")
    .replaceAll("/bin/ppcx64.exe", "/bin/ppcx64")
    .replaceAll("/bin/javac.exe", "/bin/javac")
    .replaceAll("/scratch-run.exe", "/scratch-run");
  const cloned: unknown = JSON.parse(portablePaths);
  if (!cloned || typeof cloned !== "object") return cloned;
  if (Array.isArray(cloned)) {
    if (caseId === "post-batch-judge") {
      for (const item of cloned as Array<{ type?: string; data?: Record<string, unknown> }>) {
        if (item.type === "metadata" && item.data) item.data.platform = "linux";
      }
    }
    return cloned;
  }
  const value = cloned as Record<string, unknown>;
  if (["get-status", "get-distribution", "get-toolchains"].includes(caseId)) value.platform = "linux";
  if (caseId === "post-open-excel") value.openMode = "system-open";
  if (["post-toolchain-certification-plan", "post-toolchain-certify"].includes(caseId)) {
    value.message = "Local certification is currently available for Windows GNU C++ only.";
  }
  if (caseId === "get-toolchains") {
    const profiles = value.profiles as Array<Record<string, unknown>>;
    for (const profile of profiles) {
      if (["cpp-legacy-v1", "c-gcc14", "python-cpython312"].includes(String(profile.id))) {
        (profile.localPolicy as Record<string, unknown>).executionMode = "quick_verified_direct";
        const sources = profile.sources as Record<string, unknown>;
        sources.local_auto = { available: true };
        sources.local_path = { available: true };
      }
      if (profile.id === "cpp-legacy-v1") {
        profile.certification = { canCertify: false, required: false, supported: false };
      }
    }
  }
  return value;
}
