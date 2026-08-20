import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const staging = path.resolve("release-staging");
const publicDir = path.resolve("public-release-assets");

if (fs.existsSync(publicDir)) {
  fs.rmSync(publicDir, { recursive: true, force: true });
}
fs.mkdirSync(publicDir, { recursive: true });

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = pkg.version;

const publicFiles = [
  `JudgeDesk_${version}_core_aarch64.app.tar.gz`,
  `JudgeDesk_${version}_core_aarch64.dmg`,
  `JudgeDesk_${version}_core_x64_en-US.msi`,
  `JudgeDesk_${version}_full_aarch64.app.tar.gz`,
  `JudgeDesk_${version}_full_aarch64.dmg`,
  `JudgeDesk_${version}_full_x64_en-US.msi`,
  "latest.json",
];

for (const file of publicFiles) {
  fs.copyFileSync(path.join(staging, file), path.join(publicDir, file));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const checksumLines = publicFiles.map((file) => {
  const hash = sha256(path.join(publicDir, file));
  return `${hash}  ${file}`;
});

fs.writeFileSync(path.join(publicDir, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");

console.log("Public release assets assembled successfully:");
console.log(fs.readdirSync(publicDir));
