import crypto from "node:crypto";
import {
  CPP_LANGUAGE_PROFILE_ID,
  getRegisteredLanguageProfile,
} from "../languages/registry.js";

export const LOCAL_CPP_RECIPE_VERSION = "local-cpp-windows-recipe-v1";
export const LOCAL_CPP_PROBE_SUITE_VERSION = "legacy.cpp.probes.v1";

export function buildCertifiedWindowsCppSubmissionArgs(
  sourcePath: string,
  outputPath: string,
): string[] {
  return [
    "-std=c++14",
    "-pipe",
    "-O2",
    "-fno-finite-loops",
    "-fsanitize=integer-divide-by-zero",
    "-fsanitize-undefined-trap-on-error",
    "-s",
    "-static",
    "-lm",
    "-x",
    "c++",
    "-Wl,--stack,66060288",
    sourcePath,
    "-o",
    outputPath,
  ];
}

export function buildCertifiedWindowsCppCheckerArgs(
  includeDirectory: string,
  sourcePath: string,
  outputPath: string,
): string[] {
  return [
    "-std=c++14",
    "-pipe",
    "-O2",
    "-I",
    includeDirectory,
    "-s",
    "-static",
    "-lm",
    "-x",
    "c++",
    "-Wl,--stack,66060288",
    sourcePath,
    "-o",
    outputPath,
  ];
}

export function getLocalCppCertificationRecipeDigest(): string {
  const profile = getRegisteredLanguageProfile(CPP_LANGUAGE_PROFILE_ID)?.profile;
  if (!profile) throw new Error("C++ language profile is unavailable.");
  return crypto.createHash("sha256").update(JSON.stringify({
    recipe: LOCAL_CPP_RECIPE_VERSION,
    profile: profile.ref,
    policies: profile.policies,
    submissionArgs: buildCertifiedWindowsCppSubmissionArgs("$SOURCE", "$OUTPUT"),
    checkerArgs: buildCertifiedWindowsCppCheckerArgs(
      "$INCLUDE",
      "$SOURCE",
      "$OUTPUT",
    ),
  }), "utf8").digest("hex");
}
