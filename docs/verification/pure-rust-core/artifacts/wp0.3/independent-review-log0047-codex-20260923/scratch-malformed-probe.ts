import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIsolatedScratchScript } from "../../../../../../server/judge/scratch-runtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../../../..");
const owned = path.join(here, "scratch-malformed-owned");
fs.mkdirSync(owned, { recursive: true });
const cases = [
  ["scratch_ac", "project.sb3"],
  ["scratch_legacy_ac", "project.sb2"],
] as const;
const results = [];
for (const [caseId, fileName] of cases) {
  const source = fs.readFileSync(path.join(repo, "server/test-fixtures/corpus/static", caseId, fileName));
  const central = source.indexOf(Buffer.from("PK\x01\x02", "binary"));
  if (central < 0) throw new Error(`Central directory missing from canonical ${caseId}`);
  const truncated = source.subarray(0, central);
  const sourcePath = path.join(owned, `${caseId}-${fileName}`);
  fs.writeFileSync(sourcePath, truncated);
  const workspacePath = path.join(owned, `${caseId}-workspace`);
  fs.mkdirSync(workspacePath, { recursive: true });
  const workspace = {
    path: workspacePath,
    stage(from: string, to: string) { fs.copyFileSync(from, path.join(workspacePath, to)); },
  };
  const toolchain = {
    kind: "scratch", ready: true,
    executablePath: path.join(owned, "scratch-run.exe"),
    packageRoot: owned,
  };
  let accepted = false;
  let error = "";
  try {
    await prepareIsolatedScratchScript(workspace as never, sourcePath, fileName, toolchain as never);
    accepted = true;
  } catch (e) {
    error = String(e);
  }
  results.push({ caseId, sourceBytes: source.length, truncatedBytes: truncated.length, accepted, error });
}
const output = `${JSON.stringify(results, null, 2)}\n`;
fs.writeFileSync(path.join(here, "scratch-malformed-probe.json"), output);
process.stdout.write(output);
