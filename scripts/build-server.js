import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const APP_ROOT = process.cwd();

try {
  // 1. Run esbuild
  console.log("Compiling server with esbuild...");
  execSync('npx esbuild server.ts --bundle --platform=node --format=cjs --external:vite --outfile=dist/server.cjs', { stdio: 'inherit' });

  // 2. Build SEA config
  console.log("Generating SEA config blob...");
  execSync('node --experimental-sea-config sea-config.json', { stdio: 'inherit' });

  // 3. Copy Node process executable to correct target name
  const platform = os.platform(); // 'win32', 'darwin', 'linux'
  
  const targetDir = path.join(APP_ROOT, 'src-tauri', 'binaries');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  let targets = [];
  if (platform === 'win32') {
    targets.push('x86_64-pc-windows-msvc.exe');
  } else if (platform === 'darwin') {
    // Generate all mac sidecars to support universal and targeted builds
    targets.push('x86_64-apple-darwin');
    targets.push('aarch64-apple-darwin');
    targets.push('universal-apple-darwin');
  } else if (platform === 'linux') {
    targets.push('x86_64-unknown-linux-gnu');
  }

  const sentinel = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

  for (const suffix of targets) {
    const targetPath = path.join(targetDir, `server-${suffix}`);
    console.log(`Copying Node process to target sidecar binary: ${targetPath}`);
    fs.copyFileSync(process.execPath, targetPath);

    console.log(`Injecting SEA blob into sidecar binary: ${targetPath}`);
    execSync(`npx postject "${targetPath}" NODE_SEA_BLOB sea-prep.blob --sentinel-fuse ${sentinel}`, { stdio: 'inherit' });
    console.log(`Backend server binary build completed successfully for target: ${suffix}`);
  }
} catch (err) {
  console.error("Build server script failed:", err.message);
  process.exit(1);
}
