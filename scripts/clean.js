import fs from "fs";
import path from "path";

for (const target of ["dist", "sea-prep.blob", path.join("src-tauri", "target")]) {
  fs.rmSync(target, { recursive: true, force: true });
}

const binariesDirectory = path.join("src-tauri", "binaries");
if (fs.existsSync(binariesDirectory)) {
  for (const name of fs.readdirSync(binariesDirectory)) {
    if (name.startsWith("server-")) fs.rmSync(path.join(binariesDirectory, name), { force: true });
  }
}
