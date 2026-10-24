import path from "node:path";
import os from "node:os";
import {
  prepareDistributionResources,
  type DistributionVariant,
} from "../server/toolchains/distribution-builder.js";

const variant = (process.argv[2] || "").toLowerCase();
if (variant !== "full" && variant !== "core") {
  throw new Error(
    "Usage: npx tsx scripts/prepare-distribution.ts <full|core> [input-directory] [output-directory]",
  );
}
const platform = os.platform();
const arch = os.arch();
if (
  (platform !== "win32" && platform !== "darwin" && platform !== "linux")
  || (arch !== "x64" && arch !== "arm64")
) {
  throw new Error(`Unsupported distribution host: ${platform}/${arch}`);
}
const inputRoot = path.resolve(
  process.argv[3]
    || process.env.JUDGEDESK_TOOLCHAIN_INPUT_DIR
    || "build/toolchain-release-input",
);
const outputRoot = path.resolve(
  process.argv[4] || "build/distribution-resources",
);
const lock = await prepareDistributionResources({
  variant: variant as DistributionVariant,
  inputRoot,
  outputRoot,
  platform,
  arch,
});
console.log(
  `Prepared JudgeDesk ${variant} resources for ${platform}/${arch} with ${lock.packages.length} built-in packages.`,
);
