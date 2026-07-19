import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const tauriConfig = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const cargoToml = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoLock = fs.readFileSync("src-tauri/Cargo.lock", "utf8");
const sourceVersion = fs.readFileSync("src/version.ts", "utf8").match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1];
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLockVersion = cargoLock.match(
  /\[\[package\]\]\s+name\s*=\s*"themis-v2"\s+version\s*=\s*"([^"]+)"/,
)?.[1];
const versions = {
  package: packageJson.version,
  packageLock: packageLock.version,
  packageLockRoot: packageLock.packages?.[""]?.version,
  tauri: tauriConfig.version,
  cargo: cargoVersion,
  cargoLock: cargoLockVersion,
  frontend: sourceVersion
};
const distinct = new Set(Object.values(versions));
if (distinct.size !== 1 || distinct.has(undefined)) {
  throw new Error(`Release versions do not match: ${JSON.stringify(versions)}`);
}

const refName = process.env.GITHUB_REF_NAME;
if (refName?.startsWith("v") && refName.slice(1) !== packageJson.version) {
  throw new Error(`Git tag '${refName}' does not match application version '${packageJson.version}'.`);
}
console.log(`Release version verified: ${packageJson.version}`);
