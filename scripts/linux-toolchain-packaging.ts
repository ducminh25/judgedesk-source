import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolchainReleaseSource } from "./toolchain-release-sources.js";
import { LINUX_SYSROOT_INPUTS } from "./linux-toolchain-sources.js";
import { extractToolchainReleaseArchive } from "./release-archive-extractor.js";
import { buildNativeCompilationRecipe } from "../server/judge/language-adapters.js";

type Run = (command: string, args: readonly string[]) => string;

/** Build-time smoke uses the same explicit Linux Full linkage contract as Rust. */
export function buildLinuxPackagedNativeArgs(
  language: "cpp" | "c", root: string, source: string, output: string,
): string[] {
  const recipe = buildNativeCompilationRecipe(language, "linux", source, output);
  return [`--sysroot=${path.join(root, "sysroot")}`, `-B${path.join(root, "bin")}${path.sep}`,
    "-static-libgcc", ...(language === "cpp" ? ["-static-libstdc++"] : []),
    ...recipe.args.filter((argument) => argument !== "-static")];
}

export function buildLinuxPackage(
  release: ToolchainReleaseSource,
  inputs: ReadonlyMap<string, string>,
  workRoot: string,
  packageRoot: string,
  run: Run,
): void {
  const python = process.env.JUDGEDESK_PACKAGING_PYTHON || "python3";
  const helper = path.resolve("scripts/extract-linux-upstream.py");
  const input = (id: string): string => {
    const value = inputs.get(id);
    if (!value) throw new Error(`Missing Linux packaging input '${id}'.`);
    return value;
  };
  const extract = (archive: string, destination: string, option?: string): void => {
    run(python, [helper, "extract", archive, destination, ...(option ? [option] : [])]);
  };
  const materialize = (source: string, destination: string): void => {
    run(python, [helper, "materialize", source, destination]);
  };

  const upstream = path.join(workRoot, "upstream");
  const primary = release.inputs.find((candidate) => candidate.role === "primary");
  if (!primary) throw new Error("Linux recipe requires one primary input.");
  if (release.packageId === "scratch-linux-x64") {
    fs.mkdirSync(upstream);
    extractToolchainReleaseArchive(input(primary.id), upstream, "zip");
    materialize(upstream, packageRoot);
    fs.chmodSync(path.join(packageRoot, "scratch-run"), 0o755);
    return;
  }
  extract(input(primary.id), upstream,
    release.packageId === "python-linux-x64" ? "--python-runtime" : undefined);
  if (release.recipe.kind === "archive-root") {
    materialize(path.join(upstream, release.recipe.rootPath), packageRoot);
    return;
  }
  if (release.recipe.kind === "linux-gcc") {
    materialize(path.join(upstream, "xpack-gcc-14.2.0-2"), packageRoot);
  } else if (release.recipe.kind === "linux-fpc") {
    fs.mkdirSync(packageRoot);
    const binaryRoot = path.join(workRoot, "fpc-binary");
    extract(path.join(upstream, "fpc-3.2.2.x86_64-linux", "binary.x86_64-linux.tar"), binaryRoot);
    for (const name of fs.readdirSync(binaryRoot).sort()) {
      if (name !== "base.x86_64-linux.tar.gz" && !name.startsWith("units-")) continue;
      const part = path.join(workRoot, `part-${name}`);
      extract(path.join(binaryRoot, name), part, "--fpc-runtime");
      // Each part has already passed tarfile.data_filter; internal links are
      // resolved inside that part before merging into the final package tree.
      const normalized = `${part}-normalized`;
      materialize(part, normalized);
      fs.cpSync(normalized, packageRoot, { recursive: true, force: true });
    }
    fs.copyFileSync(path.join(packageRoot, "lib/fpc/3.2.2/ppcx64"), path.join(packageRoot, "bin/ppcx64"));
    fs.chmodSync(path.join(packageRoot, "bin/ppcx64"), 0o755);
    const gccUpstream = path.join(workRoot, "binutils-upstream");
    extract(input("gcc"), gccUpstream);
    const gcc = path.join(gccUpstream, "xpack-gcc-14.2.0-2");
    for (const name of ["as", "ld"]) {
      fs.copyFileSync(path.join(gcc, "bin", name), path.join(packageRoot, "bin", name));
      fs.chmodSync(path.join(packageRoot, "bin", name), 0o755);
    }
    fs.mkdirSync(path.join(packageRoot, "libexec"));
    for (const name of fs.readdirSync(path.join(gcc, "libexec"))) {
      if (!name.includes(".so")) continue;
      fs.copyFileSync(path.join(gcc, "libexec", name), path.join(packageRoot, "libexec", name));
    }
    const sourceRoot = path.join(workRoot, "fpc-source");
    extract(input("fpc-source"), sourceRoot);
    fs.mkdirSync(path.join(packageRoot, "licenses"));
    for (const [source, name] of [["compiler/COPYING.txt", "COPYING"], ["rtl/COPYING.FPC", "COPYING.FPC"]]) {
      fs.copyFileSync(path.join(sourceRoot, "fpc-3.2.2", source), path.join(packageRoot, "licenses", name));
    }
    fs.cpSync(path.join(gcc, "distro-info"), path.join(packageRoot, "binutils-provenance"), { recursive: true });
  } else {
    throw new Error(`Unsupported Linux packaging recipe: ${release.recipe.kind}`);
  }

  // Extract pinned distro packages into a sysroot only. Never run maintainer
  // scripts or install/replace packages on the build host.
  const sysroot = path.join(packageRoot, "sysroot");
  fs.mkdirSync(sysroot);
  for (const item of LINUX_SYSROOT_INPUTS) {
    const tarPath = path.join(workRoot, `${item.id}.tar`);
    const fd = fs.openSync(tarPath, "wx");
    let result;
    try {
      result = spawnSync("dpkg-deb", ["--fsys-tarfile", input(item.id)], {
        stdio: ["ignore", fd, "pipe"], timeout: 120_000, encoding: "utf8",
      });
    } finally {
      fs.closeSync(fd);
    }
    if (result.error || result.status !== 0) {
      throw new Error(`Cannot inspect pinned sysroot package '${item.id}': ${result.stderr}`);
    }
    const extracted = path.join(workRoot, item.id);
    extract(tarPath, extracted, "--sysroot");
    fs.cpSync(extracted, sysroot, { recursive: true, force: true, verbatimSymlinks: true });
  }
  const normalizedSysroot = path.join(workRoot, "normalized-sysroot");
  materialize(sysroot, normalizedSysroot);
  fs.rmSync(sysroot, { recursive: true });
  fs.renameSync(normalizedSysroot, sysroot);
}
