// Local QA test executable, not an installer or release. Reuse the same source/version
// provenance and prerequisites as build-packaged.js; never invent clean/tag metadata.
import { execFileSync } from "node:child_process";
import { preparePackagedEnvironment } from "../prepare-build-environment.js";
const root = process.cwd();
const env = preparePackagedEnvironment(root);
const node = (script) => execFileSync(process.execPath, [script], { cwd: root, env, stdio: "inherit" });
try {
  node("scripts/check-release-version.js");
  node("scripts/check-node.js");
  node("scripts/build-native-executor.js");
  node("scripts/build-server.js");
  console.log("Running release-profile media reference test with packager-derived local source provenance. No installer or public release is produced.");
  execFileSync("cargo", ["test", "--release", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "announcements::media_tests::maximal_size_reference_corpus_decodes_png_baseline_progressive_and_cmyk_jpeg", "--", "--exact", "--nocapture"], { cwd: root, env, stdio: "inherit" });
} catch (error) {
  console.error("Release media probe failed; build identity and normal prerequisite gates remain enforced.");
  process.exitCode = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status || 1 : 1;
}
