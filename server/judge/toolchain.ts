import { resolveNativeProtectedToolchain } from "../toolchains/resolver.js";

export function assertCppCompilerAvailable(tempDirectory: string): void {
  const resolved = resolveNativeProtectedToolchain("cpp");
  if (!resolved.ready) {
    throw new Error("TOOLCHAIN_CPP_MISSING");
  }
}

export function resolvePythonCommand(): string {
  const resolved = resolveNativeProtectedToolchain("python");
  if (!resolved.ready) {
    throw new Error("TOOLCHAIN_PYTHON_MISSING");
  }
  return resolved.executablePath;
}
