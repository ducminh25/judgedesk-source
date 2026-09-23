import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareIsolatedScratchScript } from "../../../../../../server/judge/scratch-runtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../../../..");
const outputRoot = path.join(here, "scratch-source-probe");
fs.mkdirSync(outputRoot, { recursive: true });

const cases = [
  ["scratch_ac", "project.sb3"],
  ["scratch_legacy_ac", "project.sb2"],
  ["scratch_sb_stdio", "project.sb"],
] as const;

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const results = [];
for (const [caseId, fileName] of cases) {
  const source = path.join(repo, "server", "test-fixtures", "corpus", "static", caseId, fileName);
  const workspacePath = path.join(outputRoot, caseId);
  fs.mkdirSync(workspacePath, { recursive: true });
  const workspace = {
    path: workspacePath,
    stage(from: string, to: string) {
      fs.copyFileSync(from, path.join(workspacePath, to));
    },
  };
  const toolchain = {
    kind: "scratch",
    ready: true,
    executablePath: path.join(outputRoot, "scratch-run.exe"),
    packageRoot: outputRoot,
  };
  const launch = await prepareIsolatedScratchScript(workspace as never, source, fileName, toolchain as never);
  const selected = path.join(workspacePath, launch.args[0]);
  const staged = path.join(workspacePath, fileName);
  results.push({
    caseId,
    sourceSha256: sha256(source),
    stagedSha256: sha256(staged),
    selectedName: launch.args[0],
    selectedSha256: sha256(selected),
    selectedEqualsSource: sha256(selected) === sha256(source),
  });
}

const output = JSON.stringify(results, null, 2) + "\n";
fs.writeFileSync(path.join(here, "scratch-source-probe.json"), output);
process.stdout.write(output);
