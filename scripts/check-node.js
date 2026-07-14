const currentVersion = process.version;

if (!currentVersion.startsWith("v22.")) {
  console.error(`\x1b[31m[Error] Node.js version mismatch!\x1b[0m`);
  console.error(`ThemisV2 requires Node.js \x1b[33m22.x\x1b[0m to build and package SEA properly.`);
  console.error(`Current version: \x1b[31m${currentVersion}\x1b[0m.`);
  console.error(`Please install Node.js 22.x (e.g. using nvm: 'nvm install 22 && nvm use 22').`);
  process.exit(1);
} else {
  console.log(`[Check Node] Node.js version verified: ${currentVersion}`);
}
