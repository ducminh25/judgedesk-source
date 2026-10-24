import type { ToolchainCatalogEntry, ToolchainReleaseBlueprint } from "./types.js";

/** Linux payload layouts are explicit; never inherit Windows executable paths. */
export const LINUX_RELEASE_BLUEPRINTS: Readonly<Record<string, ToolchainReleaseBlueprint>> = {
  "gcc-linux-x64": {
    id: "gcc-linux-x64", kind: "cpp", provides: ["cpp", "c"], version: "14.2.0",
    platform: "linux", arch: "x64", minimumOs: "22.04", archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-gcc-linux-x64-14.2.0.tar.gz",
    entrypoints: [
      { kind: "cpp", componentId: "gcc.cxx", executableRelativePath: "bin/g++" },
      { kind: "c", componentId: "gcc.c", executableRelativePath: "bin/gcc" },
    ],
    entrypointComponentId: "gcc.cxx",
    components: [
      { id: "gcc.cxx", kind: "executable", relativePath: "bin/g++", roles: ["compiler"] },
      { id: "gcc.c", kind: "executable", relativePath: "bin/gcc", roles: ["compiler"] },
      { id: "gcc.root", kind: "support-root", relativePath: ".", roles: ["compiler"] },
    ],
    healthProbeId: "gcc.gnu.native-v1", upstreamUrl: "https://github.com/xpack-dev-tools/gcc-xpack",
    license: {
      spdxExpression: "GPL-3.0-or-later WITH GCC-exception-3.1 AND LGPL-2.1-or-later",
      licenseFiles: ["COPYING3", "COPYING.RUNTIME", "SOURCE.txt"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"], sbomPath: "SBOM.spdx.json",
    },
  },
  "python-linux-x64": {
    id: "python-linux-x64", kind: "python", provides: ["python"], version: "3.12.13",
    platform: "linux", arch: "x64", minimumOs: "22.04", archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-python-linux-x64-3.12.13.tar.gz",
    entrypoints: [{ kind: "python", componentId: "python.runtime", executableRelativePath: "bin/python3" }],
    entrypointComponentId: "python.runtime",
    components: [
      { id: "python.runtime", kind: "executable", relativePath: "bin/python3", roles: ["submission-runtime", "checker-runtime"] },
      { id: "python.root", kind: "support-root", relativePath: ".", roles: ["submission-runtime", "checker-runtime"] },
    ],
    healthProbeId: "cpython.isolated-v1", upstreamUrl: "https://github.com/astral-sh/python-build-standalone",
    license: {
      spdxExpression: "Python-2.0", licenseFiles: ["lib/python3.12/LICENSE.txt"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"], sbomPath: "SBOM.spdx.json",
    },
  },
  "fpc-linux-x64": {
    id: "fpc-linux-x64", kind: "pascal", provides: ["pascal"], version: "3.2.2",
    platform: "linux", arch: "x64", minimumOs: "22.04", archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-fpc-linux-x64-3.2.2.tar.gz",
    entrypoints: [{ kind: "pascal", componentId: "fpc.compiler", executableRelativePath: "bin/ppcx64" }],
    entrypointComponentId: "fpc.compiler",
    components: [
      { id: "fpc.compiler", kind: "executable", relativePath: "bin/ppcx64", roles: ["compiler"] },
      { id: "fpc.root", kind: "support-root", relativePath: ".", roles: ["compiler"] },
    ],
    healthProbeId: "fpc.single-file-v1", upstreamUrl: "https://www.freepascal.org/",
    license: {
      spdxExpression: "GPL-2.0-or-later AND LGPL-2.0-or-later WITH FPC-exception-2.0",
      licenseFiles: ["licenses/COPYING", "licenses/COPYING.FPC", "SOURCE.txt"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"], sbomPath: "SBOM.spdx.json",
    },
  },
  "temurin21-linux-x64": {
    id: "temurin21-linux-x64", kind: "java", provides: ["java"], version: "21.0.12+8",
    platform: "linux", arch: "x64", minimumOs: "22.04", archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-temurin21-linux-x64-21.0.12+8.tar.gz",
    entrypoints: [{ kind: "java", componentId: "java.compiler", executableRelativePath: "bin/javac" }],
    entrypointComponentId: "java.compiler",
    components: [
      { id: "java.compiler", kind: "executable", relativePath: "bin/javac", roles: ["compiler"] },
      { id: "java.runtime", kind: "executable", relativePath: "bin/java", roles: ["submission-runtime"] },
      { id: "java.root", kind: "support-root", relativePath: ".", roles: ["compiler", "submission-runtime"] },
    ],
    healthProbeId: "temurin21.main-class-v1", upstreamUrl: "https://adoptium.net/",
    license: {
      spdxExpression: "GPL-2.0-only WITH Classpath-exception-2.0", licenseFiles: ["legal/java.base/LICENSE"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"], sbomPath: "SBOM.spdx.json",
    },
  },
  "scratch-linux-x64": {
    id: "scratch-linux-x64", kind: "scratch", provides: ["scratch"], version: "0.1.7",
    platform: "linux", arch: "x64", minimumOs: "22.04", archiveFormat: "zip",
    archiveFilename: "judgedesk-scratch-linux-x64-0.1.7.zip",
    entrypoints: [{ kind: "scratch", componentId: "scratch.runtime", executableRelativePath: "scratch-run" }],
    entrypointComponentId: "scratch.runtime",
    components: [
      { id: "scratch.runtime", kind: "executable", relativePath: "scratch-run", roles: ["submission-runtime"] },
      { id: "scratch.root", kind: "support-root", relativePath: ".", roles: ["submission-runtime"] },
    ],
    healthProbeId: "scratch.isolated-script-v1", upstreamUrl: "https://github.com/VNOI-Admin/scratch-run",
    license: {
      spdxExpression: "AGPL-3.0", licenseFiles: ["LICENSE"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"], sbomPath: "SBOM.spdx.json",
    },
  },
};

export const LINUX_TOOLCHAIN_CATALOG: ToolchainCatalogEntry[] = Object.values(LINUX_RELEASE_BLUEPRINTS).map((entry) => ({
  id: entry.id, kind: entry.kind, provides: entry.provides, entrypoints: entry.entrypoints,
  version: entry.version, platform: entry.platform, arch: entry.arch, archiveFormat: entry.archiveFormat,
  executableRelativePath: entry.entrypoints[0].executableRelativePath,
  licenseFiles: [...entry.license.licenseFiles],
}));
