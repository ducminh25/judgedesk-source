import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSourceIdentity, resolveBuildIdentity } from "./build-metadata.js";
import { targetTripleForHost } from "./build-server-target.js";

export function preparePackagedEnvironment(root, environment = process.env) {
  const source = readSourceIdentity(root);
  const prepared = { ...environment, JUDGEDESK_BUILD_MODE: "packaged" };
  prepared.JUDGEDESK_APP_VERSION ??= JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (source.sourceState !== "dev") {
    prepared.JUDGEDESK_GIT_COMMIT ??= source.gitCommit;
    prepared.JUDGEDESK_BUILD_SOURCE_STATE ??= source.sourceState;
    prepared.JUDGEDESK_BUILD_NUMBER ??= `local-${source.gitCommit.slice(0, 12)}`;
    if (prepared.SOURCE_DATE_EPOCH === undefined && prepared.JUDGEDESK_BUILD_TIMESTAMP === undefined) {
      prepared.SOURCE_DATE_EPOCH = execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    }
  }
  resolveBuildIdentity(root, prepared, "node", targetTripleForHost(process.platform, process.arch), []);
  return prepared;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const prepared = preparePackagedEnvironment(process.cwd());
  // Only provenance is output; never copy the rest of the process environment to evidence.
  const names = ["JUDGEDESK_BUILD_MODE", "JUDGEDESK_APP_VERSION", "JUDGEDESK_GIT_COMMIT", "JUDGEDESK_BUILD_SOURCE_STATE", "JUDGEDESK_BUILD_NUMBER", "JUDGEDESK_BUILD_TIMESTAMP", "SOURCE_DATE_EPOCH"];
  console.log(JSON.stringify(Object.fromEntries(names.filter((name) => prepared[name] !== undefined).map((name) => [name, prepared[name]]))));
}
