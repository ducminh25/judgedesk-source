import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { targetTripleForHost } from "./build-server-target.js";

const appRoot = process.cwd();
const target = targetTripleForHost(os.platform(), os.arch());
if (process.env.TAURI_TARGET && process.env.TAURI_TARGET !== target) {
  throw new Error(`Cannot build executor target ${process.env.TAURI_TARGET} on ${os.platform()}/${os.arch()}.`);
}

const extension = os.platform() === "win32" ? ".exe" : "";
const cargoEnvironment = os.platform() === "win32" ? windowsBuildEnvironment() : process.env;
execFileSync("cargo", [
  "build",
  "--locked",
  "--release",
  "--manifest-path",
  path.join("native-executor", "Cargo.toml"),
  "--target",
  target,
], { cwd: appRoot, stdio: "inherit", env: cargoEnvironment });

const source = path.join(appRoot, "native-executor", "target", target, "release", `judgedesk-native-executor${extension}`);
const destination = path.join(appRoot, "src-tauri", "binaries", `judgedesk-executor-${target}${extension}`);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
if (os.platform() !== "win32") fs.chmodSync(destination, 0o755);
console.log(`Native secure executor staged at ${destination}`);

function windowsBuildEnvironment() {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!fs.existsSync(vswhere)) throw new Error("Visual Studio Build Tools were not found (vswhere.exe missing).");
  const installationPath = execFileSync(vswhere, [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ], { encoding: "utf8" }).trim();
  if (!installationPath) throw new Error("Visual Studio Desktop development with C++ is required.");
  const devCommand = path.join(installationPath, "Common7", "Tools", "VsDevCmd.bat");
  const commandFile = path.join(os.tmpdir(), `judgedesk-vsenv-${crypto.randomUUID()}.cmd`);
  let output;
  try {
    fs.writeFileSync(commandFile, `@call "${devCommand}" -arch=amd64 -host_arch=amd64 >nul\r\n@set\r\n`, "utf8");
    output = execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/q", "/c", commandFile], {
      encoding: "utf8",
      env: process.env,
    });
  } finally {
    fs.rmSync(commandFile, { force: true });
  }
  const environment = { ...process.env };
  for (const line of output.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals > 0) environment[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return environment;
}
