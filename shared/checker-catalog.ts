export const THEMIS_CHECKER_IDS = ["C1", "C2", "C3", "C4", "C5"] as const;

export const POLYGON_CHECKER_IDS = [
  "polygon:fcmp",
  "polygon:hcmp",
  "polygon:lcmp",
  "polygon:ncmp",
  "polygon:nyesno",
  "polygon:rcmp4",
  "polygon:rcmp6",
  "polygon:rcmp9",
  "polygon:wcmp",
  "polygon:yesno",
] as const;

export type ThemisCheckerId = (typeof THEMIS_CHECKER_IDS)[number];
export type PolygonCheckerId = (typeof POLYGON_CHECKER_IDS)[number];
export type BuiltInCheckerId = ThemisCheckerId | PolygonCheckerId;

export const CHECKER_SOURCE_FILES: Record<BuiltInCheckerId, string> = {
  C1: "C1LinesWordsIgnoreCase.cpp",
  C2: "C2LinesWordsCase.cpp",
  C3: "C3WordsIgnoreCase.cpp",
  C4: "C4WordsCase.cpp",
  C5: "C5Binary.cpp",
  "polygon:fcmp": "fcmp.cpp",
  "polygon:hcmp": "hcmp.cpp",
  "polygon:lcmp": "lcmp.cpp",
  "polygon:ncmp": "ncmp.cpp",
  "polygon:nyesno": "nyesno.cpp",
  "polygon:rcmp4": "rcmp4.cpp",
  "polygon:rcmp6": "rcmp6.cpp",
  "polygon:rcmp9": "rcmp9.cpp",
  "polygon:wcmp": "wcmp.cpp",
  "polygon:yesno": "yesno.cpp",
};

export function isBuiltInCheckerId(value: string): value is BuiltInCheckerId {
  return (
    (THEMIS_CHECKER_IDS as readonly string[]).includes(value) ||
    (POLYGON_CHECKER_IDS as readonly string[]).includes(value)
  );
}

export function checkerTranslationKey(value: BuiltInCheckerId): string {
  return value.startsWith("polygon:") ? value.slice("polygon:".length) : value;
}
