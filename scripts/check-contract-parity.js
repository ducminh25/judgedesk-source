#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsFile = path.join(repoRoot, "scripts", "check-contract-parity.ts");
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

const result = spawnSync(npxCmd, ["tsx", tsFile, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: repoRoot,
});

process.exit(result.status ?? 0);
