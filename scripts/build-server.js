import os from "os";
import path from "path";
import { runBuildWorkflow } from "./build-server-lib.js";

const appRoot = process.cwd();
const platform = os.platform();
const architecture = os.arch();

const postjectCli = path.join(
  appRoot,
  "node_modules",
  "postject",
  "dist",
  "cli.js",
);
const targetDirectory = path.join(appRoot, "src-tauri", "binaries");
const sentinel = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

try {
  runBuildWorkflow({
    appRoot,
    platform,
    architecture,
    envTarget: process.env.TAURI_TARGET,
    postjectCli,
    sentinel,
    targetDirectory,
    srcFile: "server-bootstrap.ts",
    seaConfigJson: "sea-config.json",
    seaBlobFile: "sea-prep.blob",
  });
} catch (error) {
  console.error(
    "Build server script failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}
