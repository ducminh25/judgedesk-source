import fs from "node:fs";

const expectedNodeVersion = fs
  .readFileSync(new URL("../.nvmrc", import.meta.url), "utf8")
  .trim();
const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const expectedNpmVersion = packageJson.packageManager?.match(/^npm@(.+)$/)?.[1];
const currentNodeVersion = process.versions.node;
const npmUserAgent = process.env.npm_config_user_agent || "";
const currentNpmVersion = npmUserAgent.match(/(?:^|\s)npm\/([^\s]+)/)?.[1];

if (currentNodeVersion !== expectedNodeVersion) {
  console.error(`\x1b[31m[Error] Node.js version mismatch!\x1b[0m`);
  console.error(
    `JudgeDesk requires Node.js \x1b[33m${expectedNodeVersion}\x1b[0m to build and package the SEA backend reproducibly.`,
  );
  console.error(`Current version: \x1b[31m${currentNodeVersion}\x1b[0m.`);
  console.error(
    `Install the version from .nvmrc (for example: 'nvm install ${expectedNodeVersion} && nvm use ${expectedNodeVersion}').`,
  );
  process.exit(1);
}

if (
  expectedNpmVersion
  && currentNpmVersion
  && currentNpmVersion !== expectedNpmVersion
) {
  console.error(`\x1b[31m[Error] npm version mismatch!\x1b[0m`);
  console.error(
    `JudgeDesk requires npm \x1b[33m${expectedNpmVersion}\x1b[0m; current version: \x1b[31m${currentNpmVersion}\x1b[0m.`,
  );
  console.error(`Run 'npm install --global npm@${expectedNpmVersion}' for this Node installation.`);
  process.exit(1);
}

console.log(
  `[Check Build Toolchain] Node.js ${currentNodeVersion}`
  + (currentNpmVersion ? ` with npm ${currentNpmVersion}` : ""),
);
