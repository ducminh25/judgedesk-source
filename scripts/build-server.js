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
  const arch = os.arch(); // 'x64', 'arm64'
  
  let targetSuffix = "";
  if (platform === 'win32') {
    targetSuffix = 'x86_64-pc-windows-msvc.exe';
  } else if (platform === 'darwin') {
    targetSuffix = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  } else if (platform === 'linux') {
    targetSuffix = 'x86_64-unknown-linux-gnu';
  }
  
  const targetDir = path.join(APP_ROOT, 'src-tauri', 'binaries');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  
  const targetPath = path.join(targetDir, `server-${targetSuffix}`);
  console.log(`Copying Node process to target sidecar binary: ${targetPath}`);
  
  // Under GitHub Actions or local node environments, copy process.execPath (the Node executable)
  fs.copyFileSync(process.execPath, targetPath);

  // 4. Run postject to inject blob
  console.log("Injecting SEA blob into sidecar binary...");
  const sentinel = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
  
  // Note: On Windows/macOS/Linux, postject command parameters are identical
  execSync(`npx postject "${targetPath}" NODE_SEA_BLOB sea-prep.blob --sentinel-fuse ${sentinel}`, { stdio: 'inherit' });
  console.log("Backend server binary build completed successfully for target " + targetSuffix);
} catch (err) {
  console.error("Build server script failed:", err.message);
  process.exit(1);
}
