const LOCALIZED_COMPILE_ERRORS = new Set([
  "COMPILER_TIMEOUT",
  "GENERATED_FILE_TOO_LARGE",
  "TOOLCHAIN_CPP_MISSING",
  "TOOLCHAIN_PYTHON_MISSING",
]);

export function formatCompileError(
  error: string | undefined,
  translate: (key: string) => string,
): string {
  if (!error) return translate("judgingDetails.compilationError");
  return LOCALIZED_COMPILE_ERRORS.has(error)
    ? translate(`compileDiagnostics.${error}`)
    : error;
}
