import type { SubmissionLanguage } from "../types.js";
import type {
  ResolvedToolchain,
  ToolchainKind,
} from "../toolchains/types.js";

export type PreparedSubmissionProgram =
  | {
      kind: "native";
      language: Extract<
        SubmissionLanguage,
        "cpp" | "c" | "pascal" | "go" | "rust"
      >;
      artifactPath: string;
    }
  | {
      kind: "script-runtime";
      language: Extract<SubmissionLanguage, "python" | "javascript">;
      sourcePath: string;
      stagedFileName: string;
      runtimeKind: Extract<ToolchainKind, "python" | "javascript">;
      runtimeToolchain: Readonly<ResolvedToolchain>;
      runtimeComponentId?: string;
    }
  | {
      kind: "directory-runtime";
      language: Extract<SubmissionLanguage, "java" | "csharp">;
      artifactDirectory: string;
      entrypoint: string;
      runtimeKind: Extract<ToolchainKind, "java" | "csharp">;
      runtimeToolchain: Readonly<ResolvedToolchain>;
      runtimeComponentId: string;
    };
