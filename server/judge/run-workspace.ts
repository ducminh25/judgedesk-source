import fs from "fs";
import path from "path";
import { TEMP_ROOT } from "../runtime.js";

export interface RunWorkspace {
  id: string;
  path: string;
  dispose(): void;
}

export function createRunWorkspace(): RunWorkspace {
  const id = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const workspacePath = path.join(TEMP_ROOT, id);
  fs.mkdirSync(workspacePath, { recursive: true });
  return {
    id,
    path: workspacePath,
    dispose() {
      try {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      } catch {
        // A locked contestant process can briefly retain its executable on Windows.
      }
    }
  };
}
