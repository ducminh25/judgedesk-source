import fs from "fs";

export function isTextFile(filePath: string): boolean {
  try {
    const descriptor = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(1024);
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return false;
      }
      return true;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

export function readTextPreview(filePath: string, maxCharacters = 500): string {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxCharacters * 4 + 4);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const output = buffer.subarray(0, bytesRead).toString("utf8");
    return output.substring(0, maxCharacters) + (output.length > maxCharacters ? "..." : "");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
