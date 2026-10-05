import path from "node:path";
import { execFileSync } from "node:child_process";
import { preparePackagedEnvironment } from "./prepare-build-environment.js";

const root = process.cwd();
const env = preparePackagedEnvironment(root);
const run = (args) => execFileSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
run(["scripts/check-release-version.js"]);
run(["scripts/check-node.js"]);
run(["scripts/build-native-executor.js"]);
run(["scripts/build-server.js"]);
// Tauri forwards arguments after -- to Cargo. --locked belongs there, not to Tauri.
run([path.join("node_modules", "@tauri-apps", "cli", "tauri.js"), "build", ...process.argv.slice(2), "--", "--locked"]);
