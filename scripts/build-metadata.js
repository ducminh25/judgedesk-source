import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { targetTripleForHost } from './build-server-target.js';

function resolveLegacyMetadata(appRoot, environment = process.env) {
  let appVersion = environment.npm_package_version || "development";
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
    );
    if (typeof packageJson.version === "string" && packageJson.version) {
      appVersion = packageJson.version;
    }
  } catch {
    // Source archives used by tests may not carry package.json.
  }

  let gitCommit = environment.JUDGEDESK_GIT_COMMIT || environment.GITHUB_SHA || "unknown";
  if (gitCommit === "unknown") {
    try {
      gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: appRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "unknown";
    } catch {
      // Release source archives may not contain .git.
    }
  }

  const sourceDateEpoch = Number.parseInt(environment.SOURCE_DATE_EPOCH || "", 10);
  const builtAt = Number.isFinite(sourceDateEpoch)
    ? new Date(sourceDateEpoch * 1000).toISOString()
    : environment.JUDGEDESK_BUILD_TIMESTAMP || new Date().toISOString();

  return {
    appVersion,
    gitCommit,
    buildNumber:
      environment.JUDGEDESK_BUILD_NUMBER
      || environment.CM_BUILD_ID
      || environment.GITHUB_RUN_NUMBER
      || "local",
    builtAt,
  };
}

function invalid(message) {
  throw new Error(`BUILD_IDENTITY: ${message}`);
}

function required(environment, name, pattern) {
  const value = environment[name];
  if (!value || !pattern.test(value)) invalid(`missing/invalid ${name}`);
  return value;
}

export function readSourceIdentity(appRoot) {
  // Do not inherit a parent repository's identity when building an extracted archive.
  if (!fs.existsSync(path.join(appRoot, ".git"))) return { gitCommit: "development", sourceState: "dev" };
  const git = (...args) => execFileSync("git", args, { cwd: appRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    if (fs.realpathSync(git("rev-parse", "--show-toplevel")) !== fs.realpathSync(appRoot)) invalid("Git root differs from source root");
    const gitCommit = git("rev-parse", "HEAD");
    if (!/^[a-f0-9]{40}$/.test(gitCommit)) invalid("invalid source HEAD");
    return { gitCommit, sourceState: git("status", "--porcelain", "--untracked-files=normal") ? "dirty" : "clean" };
  } catch (error) {
    invalid(`cannot read source Git identity: ${error.message}`);
  }
}

export function resolveBuildIdentity(appRoot, environment, backend, target, features) {
  const appVersion = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(appVersion)) invalid("invalid application version");
  const buildMode = environment.JUDGEDESK_BUILD_MODE || "development";
  if (!["development", "packaged"].includes(buildMode)) invalid("invalid JUDGEDESK_BUILD_MODE");
  if (!["node", "rust"].includes(backend) || !/^[a-z0-9_-]+$/.test(target)) invalid("invalid backend/target");
  if (features.some((feature) => !/^[a-z0-9_-]+$/.test(feature))) invalid("invalid feature set");
  if (buildMode === "development") {
    return { appVersion, ...readSourceIdentity(appRoot), buildNumber: "local", builtAt: "development", backend, target, features: [...features].sort(), buildMode };
  }
  if (required(environment, "JUDGEDESK_APP_VERSION", /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/) !== appVersion) invalid("injected application version mismatch");
  const gitCommit = required(environment, "JUDGEDESK_GIT_COMMIT", /^[a-f0-9]{40}$/);
  const sourceState = required(environment, "JUDGEDESK_BUILD_SOURCE_STATE", /^(clean|dirty)$/);
  const buildNumber = required(environment, "JUDGEDESK_BUILD_NUMBER", /^[A-Za-z0-9._-]{1,128}$/);
  if (fs.existsSync(path.join(appRoot, ".git"))) {
    const actual = readSourceIdentity(appRoot);
    if (actual.gitCommit !== gitCommit || actual.sourceState !== sourceState) invalid("injected Git identity differs from source checkout");
  }
  let builtAt;
  if (environment.SOURCE_DATE_EPOCH !== undefined) {
    const epoch = required(environment, "SOURCE_DATE_EPOCH", /^\d{1,12}$/);
    const millis = Number(epoch) * 1000;
    if (!Number.isSafeInteger(millis) || millis > 253402300799000) invalid("invalid SOURCE_DATE_EPOCH range");
    builtAt = new Date(millis).toISOString();
  }
  if (environment.JUDGEDESK_BUILD_TIMESTAMP !== undefined) {
    const stamp = required(environment, "JUDGEDESK_BUILD_TIMESTAMP", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    if (!Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp) invalid("invalid JUDGEDESK_BUILD_TIMESTAMP date");
    if (builtAt && builtAt !== stamp) invalid("conflicting deterministic timestamps");
    builtAt = stamp;
  }
  if (!builtAt) invalid("missing SOURCE_DATE_EPOCH or JUDGEDESK_BUILD_TIMESTAMP");
  return { appVersion, gitCommit, buildNumber, builtAt, backend, target, features: [...features].sort(), sourceState, buildMode };
}

export function resolveBuildMetadata(appRoot, environment = process.env) {
  if (environment.JUDGEDESK_BUILD_MODE === undefined || environment.JUDGEDESK_BUILD_MODE === "development") return resolveLegacyMetadata(appRoot, environment);
  return resolveBuildIdentity(appRoot, environment, "node", targetTripleForHost(process.platform, process.arch), []);
}

// Cargo's target/features are authoritative; callers cannot override them at runtime.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, target, featureList = ""] = process.argv.slice(2);
    const expectedNode = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
    if (process.versions.node !== expectedNode) invalid(`Node runtime mismatch: required ${expectedNode}, actual ${process.versions.node}`);
    const identity = resolveBuildIdentity(root, process.env, "rust", target, featureList ? featureList.split(",") : []);
    const fields = Object.entries(identity).map(([key, value]) => {
      const field = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      return `${field}: ${Array.isArray(value) ? `&${JSON.stringify(value)}` : JSON.stringify(value)}`;
    });
    process.stdout.write(`pub const BUILD_METADATA: BuildMetadata = BuildMetadata { ${fields.join(", ")} };\n`);
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
