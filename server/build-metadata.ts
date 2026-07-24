import type { BuildMetadata } from "./types.js";

declare const __JUDGEDESK_BUILD_METADATA__: BuildMetadata;

const developmentMetadata: BuildMetadata = {
  appVersion: process.env.npm_package_version || "development",
  gitCommit: process.env.JUDGEDESK_GIT_COMMIT || "unknown",
  buildNumber: process.env.JUDGEDESK_BUILD_NUMBER || "local",
  builtAt: process.env.JUDGEDESK_BUILD_TIMESTAMP || "development",
};

export const BUILD_METADATA: BuildMetadata =
  typeof __JUDGEDESK_BUILD_METADATA__ === "undefined"
    ? developmentMetadata
    : __JUDGEDESK_BUILD_METADATA__;
