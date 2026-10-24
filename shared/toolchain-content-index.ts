/** File inventory after build-time normalization; the index digest is pinned separately. */
export interface ToolchainContentIndex {
  schemaVersion: 1;
  entries: Array<
    | { path: string; kind: "directory" }
    | { path: string; kind: "file"; sizeBytes: number; executable: boolean; sha256: string }
  >;
}

export const TOOLCHAIN_CONTENT_INDEX_NAME = ".judgedesk-content.json";
export const TOOLCHAIN_CONTENT_MAX_FILES = 200_000;
export const TOOLCHAIN_CONTENT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const TOOLCHAIN_CONTENT_MAX_FILE_BYTES = 256 * 1024 * 1024;
