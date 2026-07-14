import { resolveToolchain } from "../toolchains/resolver.js";

export function assertCppCompilerAvailable(tempDirectory: string): void {
  const resolved = resolveToolchain("cpp");
  if (!resolved.ready) {
    throw new Error("TOOLCHAIN_CPP_MISSING");
  }
}

export function resolvePythonCommand(): string {
  const resolved = resolveToolchain("python");
  if (!resolved.ready) {
    throw new Error("TOOLCHAIN_PYTHON_MISSING");
  }
  return resolved.executablePath;
}
