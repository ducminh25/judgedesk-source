import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RESOURCE_ROOT } from "../runtime.js";
import {
  ToolchainCatalogEntry,
  ToolchainDescriptor,
  ToolchainManifestDocument,
  ToolchainManifestV2Payload,
  ToolchainPackageComponent,
  ToolchainPackageLicense,
  ToolchainReleaseBlueprint,
} from "./types.js";

export const DEFAULT_TOOLCHAIN_MANIFEST_URL =
  "https://github.com/ducminh25/judgedesk/releases/download/toolchains-v2/toolchains-manifest.json";
const MANIFEST_CACHE_MS = 5 * 60 * 1000;
const MANIFEST_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const COMPONENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Toolchain manifest keys are deliberately separate from Tauri updater keys.
 * A production v2 catalog remains fail-closed until a release key is
 * provisioned here. Tests inject an ephemeral key through validation options.
 */
export const OFFICIAL_TOOLCHAIN_MANIFEST_PUBLIC_KEYS: Readonly<
  Record<string, string>
> = Object.freeze({
  "judgedesk-toolchains-2026-07": [
    "-----BEGIN PUBLIC KEY-----",
    "MCowBQYDK2VwAyEAG8mGFjypSBqO2ssigjLN9noSJ+AMbhn6YAsoCfl6TW8=",
    "-----END PUBLIC KEY-----",
    "",
  ].join("\n"),
});
export const REVOKED_TOOLCHAIN_MANIFEST_KEY_IDS: ReadonlySet<string> =
  Object.freeze(new Set<string>());
export const REVOKED_TOOLCHAIN_PACKAGE_DIGESTS: ReadonlySet<string> =
  Object.freeze(new Set<string>());

export interface ManifestValidationOptions {
  trustedPublicKeys?: Readonly<Record<string, string>>;
  requireSignedV2?: boolean;
}

export const TOOLCHAIN_CATALOG: ToolchainCatalogEntry[] = [
  {
    id: "gcc-windows-x64",
    provides: ["cpp", "c"],
    entrypoints: [
      {
        kind: "cpp",
        componentId: "gcc.cxx",
        executableRelativePath: "bin/g++.exe",
      },
      {
        kind: "c",
        componentId: "gcc.c",
        executableRelativePath: "bin/gcc.exe",
      },
    ],
    kind: "cpp",
    version: "14.2.0",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "bin/g++.exe",
    licenseFiles: ["COPYING3", "COPYING.RUNTIME", "SOURCE.txt"],
  },
  {
    id: "python-windows-x64",
    provides: ["python"],
    entrypoints: [
      {
        kind: "python",
        componentId: "python.runtime",
        executableRelativePath: "python.exe",
      },
    ],
    kind: "python",
    version: "3.12.13",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "python.exe",
    licenseFiles: ["LICENSE.txt"],
  },
  {
    id: "python-macos-arm64",
    provides: ["python"],
    entrypoints: [
      {
        kind: "python",
        componentId: "python.runtime",
        executableRelativePath: "bin/python3",
      },
    ],
    kind: "python",
    version: "3.12.13",
    platform: "darwin",
    arch: "arm64",
    archiveFormat: "tar.gz",
    executableRelativePath: "bin/python3",
    licenseFiles: ["lib/python3.12/LICENSE.txt"],
  },
  {
    id: "go-windows-x64",
    provides: ["go"],
    entrypoints: [{
      kind: "go",
      componentId: "go.compiler",
      executableRelativePath: "bin/go.exe",
    }],
    kind: "go",
    version: "1.26.5",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "bin/go.exe",
    licenseFiles: ["LICENSE"],
  },
  {
    id: "go-macos-arm64",
    provides: ["go"],
    entrypoints: [{
      kind: "go",
      componentId: "go.compiler",
      executableRelativePath: "bin/go",
    }],
    kind: "go",
    version: "1.26.5",
    platform: "darwin",
    arch: "arm64",
    archiveFormat: "tar.gz",
    executableRelativePath: "bin/go",
    licenseFiles: ["LICENSE"],
  },
  {
    id: "node-windows-x64",
    provides: ["javascript"],
    entrypoints: [{
      kind: "javascript",
      componentId: "node.runtime",
      executableRelativePath: "node.exe",
    }],
    kind: "javascript",
    version: "24.18.1",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "node.exe",
    licenseFiles: ["LICENSE"],
  },
  {
    id: "node-macos-arm64",
    provides: ["javascript"],
    entrypoints: [{
      kind: "javascript",
      componentId: "node.runtime",
      executableRelativePath: "bin/node",
    }],
    kind: "javascript",
    version: "24.18.1",
    platform: "darwin",
    arch: "arm64",
    archiveFormat: "tar.gz",
    executableRelativePath: "bin/node",
    licenseFiles: ["LICENSE"],
  },
  {
    id: "fpc-windows-x64",
    provides: ["pascal"],
    entrypoints: [{
      kind: "pascal",
      componentId: "fpc.compiler",
      executableRelativePath: "bin/ppcx64.exe",
    }],
    kind: "pascal",
    version: "3.2.2",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "bin/ppcx64.exe",
    licenseFiles: [
      "licenses/COPYING",
      "licenses/COPYING.v2",
      "licenses/copying.fpc",
      "SOURCE.txt",
    ],
  },
  {
    id: "fpc-macos-arm64",
    provides: ["pascal"],
    entrypoints: [{
      kind: "pascal",
      componentId: "fpc.compiler",
      executableRelativePath: "bin/fpc",
    }],
    kind: "pascal",
    version: "3.2.2",
    platform: "darwin",
    arch: "arm64",
    archiveFormat: "tar.gz",
    executableRelativePath: "bin/fpc",
    licenseFiles: [
      "licenses/COPYING",
      "licenses/COPYING.v2",
      "licenses/copying.fpc",
      "SOURCE.txt",
    ],
  },
  {
    id: "temurin21-windows-x64",
    provides: ["java"],
    entrypoints: [{
      kind: "java",
      componentId: "java.compiler",
      executableRelativePath: "bin/javac.exe",
    }],
    kind: "java",
    version: "21.0.12+8",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "bin/javac.exe",
    licenseFiles: ["legal/java.base/LICENSE"],
  },
  {
    id: "temurin21-macos-arm64",
    provides: ["java"],
    entrypoints: [{
      kind: "java",
      componentId: "java.compiler",
      executableRelativePath: "bin/javac",
    }],
    kind: "java",
    version: "21.0.12+8",
    platform: "darwin",
    arch: "arm64",
    archiveFormat: "tar.gz",
    executableRelativePath: "bin/javac",
    licenseFiles: ["legal/java.base/LICENSE"],
  },
  {
    id: "rust-windows-x64-gnu",
    provides: ["rust"],
    entrypoints: [{
      kind: "rust",
      componentId: "rust.compiler",
      executableRelativePath: "bin/rustc.exe",
    }],
    kind: "rust",
    version: "1.97.1",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "bin/rustc.exe",
    licenseFiles: ["LICENSE-APACHE", "LICENSE-MIT"],
  },
  {
    id: "rust-macos-arm64",
    provides: ["rust"],
    entrypoints: [{
      kind: "rust",
      componentId: "rust.compiler",
      executableRelativePath: "bin/rustc",
    }],
    kind: "rust",
    version: "1.97.1",
    platform: "darwin",
    arch: "arm64",
    archiveFormat: "tar.gz",
    executableRelativePath: "bin/rustc",
    licenseFiles: ["LICENSE-APACHE", "LICENSE-MIT"],
  },
  {
    id: "dotnet10-windows-x64",
    provides: ["csharp"],
    entrypoints: [{
      kind: "csharp",
      componentId: "dotnet.host",
      executableRelativePath: "dotnet.exe",
    }],
    kind: "csharp",
    version: "10.0.302",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "dotnet.exe",
    licenseFiles: ["LICENSE.txt", "ThirdPartyNotices.txt"],
  },
  {
    id: "dotnet10-macos-arm64",
    provides: ["csharp"],
    entrypoints: [{
      kind: "csharp",
      componentId: "dotnet.host",
      executableRelativePath: "dotnet",
    }],
    kind: "csharp",
    version: "10.0.302",
    platform: "darwin",
    arch: "arm64",
    archiveFormat: "tar.gz",
    executableRelativePath: "dotnet",
    licenseFiles: ["LICENSE.txt", "ThirdPartyNotices.txt"],
  },
  {
    id: "scratch-windows-x64",
    provides: ["scratch"],
    entrypoints: [{
      kind: "scratch",
      componentId: "scratch.runtime",
      executableRelativePath: "scratch-run.exe",
    }],
    kind: "scratch",
    version: "0.1.7",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "scratch-run.exe",
    licenseFiles: ["LICENSE"],
  },
  {
    id: "scratch-macos-arm64",
    provides: ["scratch"],
    entrypoints: [{
      kind: "scratch",
      componentId: "scratch.runtime",
      executableRelativePath: "scratch-run",
    }],
    kind: "scratch",
    version: "0.1.7",
    platform: "darwin",
    arch: "arm64",
    archiveFormat: "zip",
    executableRelativePath: "scratch-run",
    licenseFiles: ["LICENSE"],
  },
  {
    id: "scratch-macos-x64",
    provides: ["scratch"],
    entrypoints: [{
      kind: "scratch",
      componentId: "scratch.runtime",
      executableRelativePath: "scratch-run",
    }],
    kind: "scratch",
    version: "0.1.7",
    platform: "darwin",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "scratch-run",
    licenseFiles: ["LICENSE"],
  },
];

export const TOOLCHAIN_RELEASE_BLUEPRINTS: Readonly<
  Record<string, ToolchainReleaseBlueprint>
> = Object.freeze({
  "gcc-windows-x64": {
    id: "gcc-windows-x64",
    provides: ["cpp", "c"],
    entrypoints: [
      {
        kind: "cpp",
        componentId: "gcc.cxx",
        executableRelativePath: "bin/g++.exe",
      },
      {
        kind: "c",
        componentId: "gcc.c",
        executableRelativePath: "bin/gcc.exe",
      },
    ],
    kind: "cpp",
    version: "14.2.0",
    platform: "win32",
    arch: "x64",
    minimumOs: "10.0",
    archiveFormat: "zip",
    archiveFilename: "judgedesk-gcc-windows-x64-14.2.0.zip",
    entrypointComponentId: "gcc.cxx",
    components: [
      {
        id: "gcc.cxx",
        kind: "executable",
        relativePath: "bin/g++.exe",
        roles: ["compiler"],
      },
      {
        id: "gcc.c",
        kind: "executable",
        relativePath: "bin/gcc.exe",
        roles: ["compiler"],
      },
      {
        id: "gcc.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler"],
      },
    ],
    healthProbeId: "gcc.ucrt.native-v1",
    upstreamUrl: "https://github.com/brechtsanders/winlibs_mingw",
    license: {
      spdxExpression: "GPL-3.0-or-later WITH GCC-exception-3.1",
      licenseFiles: ["COPYING3", "COPYING.RUNTIME", "SOURCE.txt"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "python-windows-x64": {
    id: "python-windows-x64",
    provides: ["python"],
    entrypoints: [
      {
        kind: "python",
        componentId: "python.runtime",
        executableRelativePath: "python.exe",
      },
    ],
    kind: "python",
    version: "3.12.13",
    platform: "win32",
    arch: "x64",
    minimumOs: "10.0",
    archiveFormat: "zip",
    archiveFilename: "judgedesk-python-windows-x64-3.12.13.zip",
    entrypointComponentId: "python.runtime",
    components: [
      {
        id: "python.runtime",
        kind: "executable",
        relativePath: "python.exe",
        roles: ["submission-runtime", "checker-runtime"],
      },
      {
        id: "python.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["submission-runtime", "checker-runtime"],
      },
    ],
    healthProbeId: "cpython.isolated-v1",
    upstreamUrl: "https://github.com/astral-sh/python-build-standalone",
    license: {
      spdxExpression: "Python-2.0",
      licenseFiles: ["LICENSE.txt"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "python-macos-arm64": {
    id: "python-macos-arm64",
    provides: ["python"],
    entrypoints: [
      {
        kind: "python",
        componentId: "python.runtime",
        executableRelativePath: "bin/python3",
      },
    ],
    kind: "python",
    version: "3.12.13",
    platform: "darwin",
    arch: "arm64",
    minimumOs: "11.0",
    archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-python-macos-arm64-3.12.13.tar.gz",
    entrypointComponentId: "python.runtime",
    components: [
      {
        id: "python.runtime",
        kind: "executable",
        relativePath: "bin/python3",
        roles: ["submission-runtime", "checker-runtime"],
      },
      {
        id: "python.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["submission-runtime", "checker-runtime"],
      },
    ],
    healthProbeId: "cpython.isolated-v1",
    upstreamUrl: "https://github.com/astral-sh/python-build-standalone",
    license: {
      spdxExpression: "Python-2.0",
      licenseFiles: ["lib/python3.12/LICENSE.txt"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "go-windows-x64": {
    id: "go-windows-x64",
    provides: ["go"],
    entrypoints: [{
      kind: "go",
      componentId: "go.compiler",
      executableRelativePath: "bin/go.exe",
    }],
    kind: "go",
    version: "1.26.5",
    platform: "win32",
    arch: "x64",
    minimumOs: "10.0",
    archiveFormat: "zip",
    archiveFilename: "judgedesk-go-windows-x64-1.26.5.zip",
    entrypointComponentId: "go.compiler",
    components: [
      {
        id: "go.compiler",
        kind: "executable",
        relativePath: "bin/go.exe",
        roles: ["compiler"],
      },
      {
        id: "go.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler"],
      },
    ],
    healthProbeId: "go.cgo-disabled-v1",
    upstreamUrl: "https://go.dev/dl/",
    license: {
      spdxExpression: "BSD-3-Clause",
      licenseFiles: ["LICENSE"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "go-macos-arm64": {
    id: "go-macos-arm64",
    provides: ["go"],
    entrypoints: [{
      kind: "go",
      componentId: "go.compiler",
      executableRelativePath: "bin/go",
    }],
    kind: "go",
    version: "1.26.5",
    platform: "darwin",
    arch: "arm64",
    minimumOs: "12.0",
    archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-go-macos-arm64-1.26.5.tar.gz",
    entrypointComponentId: "go.compiler",
    components: [
      {
        id: "go.compiler",
        kind: "executable",
        relativePath: "bin/go",
        roles: ["compiler"],
      },
      {
        id: "go.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler"],
      },
    ],
    healthProbeId: "go.cgo-disabled-v1",
    upstreamUrl: "https://go.dev/dl/",
    license: {
      spdxExpression: "BSD-3-Clause",
      licenseFiles: ["LICENSE"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "node-windows-x64": {
    id: "node-windows-x64",
    provides: ["javascript"],
    entrypoints: [{
      kind: "javascript",
      componentId: "node.runtime",
      executableRelativePath: "node.exe",
    }],
    kind: "javascript",
    version: "24.18.1",
    platform: "win32",
    arch: "x64",
    minimumOs: "10.0",
    archiveFormat: "zip",
    archiveFilename: "judgedesk-node-windows-x64-24.18.1.zip",
    entrypointComponentId: "node.runtime",
    components: [
      {
        id: "node.runtime",
        kind: "executable",
        relativePath: "node.exe",
        roles: ["submission-runtime"],
      },
      {
        id: "node.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["submission-runtime"],
      },
    ],
    healthProbeId: "node.isolated-script-v1",
    upstreamUrl: "https://nodejs.org/dist/",
    license: {
      spdxExpression: "MIT",
      licenseFiles: ["LICENSE"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "node-macos-arm64": {
    id: "node-macos-arm64",
    provides: ["javascript"],
    entrypoints: [{
      kind: "javascript",
      componentId: "node.runtime",
      executableRelativePath: "bin/node",
    }],
    kind: "javascript",
    version: "24.18.1",
    platform: "darwin",
    arch: "arm64",
    minimumOs: "13.5",
    archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-node-macos-arm64-24.18.1.tar.gz",
    entrypointComponentId: "node.runtime",
    components: [
      {
        id: "node.runtime",
        kind: "executable",
        relativePath: "bin/node",
        roles: ["submission-runtime"],
      },
      {
        id: "node.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["submission-runtime"],
      },
    ],
    healthProbeId: "node.isolated-script-v1",
    upstreamUrl: "https://nodejs.org/dist/",
    license: {
      spdxExpression: "MIT",
      licenseFiles: ["LICENSE"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "fpc-windows-x64": {
    id: "fpc-windows-x64",
    provides: ["pascal"],
    entrypoints: [{
      kind: "pascal",
      componentId: "fpc.compiler",
      executableRelativePath: "bin/ppcx64.exe",
    }],
    kind: "pascal",
    version: "3.2.2",
    platform: "win32",
    arch: "x64",
    minimumOs: "10.0",
    archiveFormat: "zip",
    archiveFilename: "judgedesk-fpc-windows-x64-3.2.2.zip",
    entrypointComponentId: "fpc.compiler",
    components: [
      {
        id: "fpc.compiler",
        kind: "executable",
        relativePath: "bin/ppcx64.exe",
        roles: ["compiler"],
      },
      {
        id: "fpc.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler"],
      },
    ],
    healthProbeId: "fpc.single-file-v1",
    upstreamUrl: "https://www.freepascal.org/download.html",
    license: {
      spdxExpression:
        "GPL-2.0-or-later AND LGPL-2.1-or-later WITH FPC-exception-2.0",
      licenseFiles: [
        "licenses/COPYING",
        "licenses/COPYING.v2",
        "licenses/copying.fpc",
        "SOURCE.txt",
      ],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "fpc-macos-arm64": {
    id: "fpc-macos-arm64",
    provides: ["pascal"],
    entrypoints: [{
      kind: "pascal",
      componentId: "fpc.compiler",
      executableRelativePath: "bin/fpc",
    }],
    kind: "pascal",
    version: "3.2.2",
    platform: "darwin",
    arch: "arm64",
    minimumOs: "11.0",
    archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-fpc-macos-arm64-3.2.2.tar.gz",
    entrypointComponentId: "fpc.compiler",
    components: [
      {
        id: "fpc.compiler",
        kind: "executable",
        relativePath: "bin/fpc",
        roles: ["compiler"],
      },
      {
        id: "fpc.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler"],
      },
    ],
    healthProbeId: "fpc.single-file-v1",
    upstreamUrl: "https://www.freepascal.org/download.html",
    license: {
      spdxExpression:
        "GPL-2.0-or-later AND LGPL-2.1-or-later WITH FPC-exception-2.0",
      licenseFiles: [
        "licenses/COPYING",
        "licenses/COPYING.v2",
        "licenses/copying.fpc",
        "SOURCE.txt",
      ],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "temurin21-macos-arm64": {
    id: "temurin21-macos-arm64",
    provides: ["java"],
    entrypoints: [{
      kind: "java",
      componentId: "java.compiler",
      executableRelativePath: "bin/javac",
    }],
    kind: "java",
    version: "21.0.12+8",
    platform: "darwin",
    arch: "arm64",
    minimumOs: "11.0",
    archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-temurin21-macos-arm64-21.0.12_8.tar.gz",
    entrypointComponentId: "java.compiler",
    components: [
      {
        id: "java.compiler",
        kind: "executable",
        relativePath: "bin/javac",
        roles: ["compiler"],
      },
      {
        id: "java.runtime",
        kind: "executable",
        relativePath: "bin/java",
        roles: ["submission-runtime"],
      },
      {
        id: "java.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler", "submission-runtime"],
      },
    ],
    healthProbeId: "temurin21.main-class-v1",
    upstreamUrl: "https://adoptium.net/temurin/releases/",
    license: {
      spdxExpression: "GPL-2.0-only WITH Classpath-exception-2.0",
      licenseFiles: ["legal/java.base/LICENSE"],
      noticeFiles: ["NOTICE", "THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "temurin21-windows-x64": {
    id: "temurin21-windows-x64",
    provides: ["java"],
    entrypoints: [{
      kind: "java",
      componentId: "java.compiler",
      executableRelativePath: "bin/javac.exe",
    }],
    kind: "java",
    version: "21.0.12+8",
    platform: "win32",
    arch: "x64",
    minimumOs: "10.0",
    archiveFormat: "zip",
    archiveFilename: "judgedesk-temurin21-windows-x64-21.0.12_8.zip",
    entrypointComponentId: "java.compiler",
    components: [
      {
        id: "java.compiler",
        kind: "executable",
        relativePath: "bin/javac.exe",
        roles: ["compiler"],
      },
      {
        id: "java.runtime",
        kind: "executable",
        relativePath: "bin/java.exe",
        roles: ["submission-runtime"],
      },
      {
        id: "java.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler", "submission-runtime"],
      },
    ],
    healthProbeId: "temurin21.main-class-v1",
    upstreamUrl: "https://adoptium.net/temurin/releases/",
    license: {
      spdxExpression: "GPL-2.0-only WITH Classpath-exception-2.0",
      licenseFiles: ["legal/java.base/LICENSE"],
      noticeFiles: ["NOTICE", "THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "rust-windows-x64-gnu": {
    id: "rust-windows-x64-gnu",
    provides: ["rust"],
    entrypoints: [{
      kind: "rust",
      componentId: "rust.compiler",
      executableRelativePath: "bin/rustc.exe",
    }],
    kind: "rust",
    version: "1.97.1",
    platform: "win32",
    arch: "x64",
    minimumOs: "10.0",
    archiveFormat: "zip",
    archiveFilename: "judgedesk-rust-windows-x64-gnu-1.97.1.zip",
    entrypointComponentId: "rust.compiler",
    components: [
      {
        id: "rust.compiler",
        kind: "executable",
        relativePath: "bin/rustc.exe",
        roles: ["compiler"],
      },
      {
        id: "rust.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler"],
      },
    ],
    healthProbeId: "rustc.single-file-gnu-v1",
    upstreamUrl: "https://static.rust-lang.org/dist/",
    license: {
      spdxExpression: "Apache-2.0 OR MIT",
      licenseFiles: ["LICENSE-APACHE", "LICENSE-MIT"],
      noticeFiles: ["COPYRIGHT", "THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "rust-macos-arm64": {
    id: "rust-macos-arm64",
    provides: ["rust"],
    entrypoints: [{
      kind: "rust",
      componentId: "rust.compiler",
      executableRelativePath: "bin/rustc",
    }],
    kind: "rust",
    version: "1.97.1",
    platform: "darwin",
    arch: "arm64",
    minimumOs: "11.0",
    archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-rust-macos-arm64-1.97.1.tar.gz",
    entrypointComponentId: "rust.compiler",
    components: [
      {
        id: "rust.compiler",
        kind: "executable",
        relativePath: "bin/rustc",
        roles: ["compiler"],
      },
      {
        id: "rust.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler"],
      },
    ],
    healthProbeId: "rustc.single-file-apple-linker-v1",
    upstreamUrl: "https://static.rust-lang.org/dist/",
    license: {
      spdxExpression: "Apache-2.0 OR MIT",
      licenseFiles: ["LICENSE-APACHE", "LICENSE-MIT"],
      noticeFiles: ["COPYRIGHT", "THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "dotnet10-windows-x64": {
    id: "dotnet10-windows-x64",
    provides: ["csharp"],
    entrypoints: [{
      kind: "csharp",
      componentId: "dotnet.host",
      executableRelativePath: "dotnet.exe",
    }],
    kind: "csharp",
    version: "10.0.302",
    platform: "win32",
    arch: "x64",
    minimumOs: "10.0",
    archiveFormat: "zip",
    archiveFilename: "judgedesk-dotnet10-windows-x64-10.0.302.zip",
    entrypointComponentId: "dotnet.host",
    components: [
      {
        id: "dotnet.host",
        kind: "executable",
        relativePath: "dotnet.exe",
        roles: ["compiler", "submission-runtime"],
      },
      {
        id: "dotnet.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler", "submission-runtime"],
      },
    ],
    healthProbeId: "dotnet10.offline-console-v1",
    upstreamUrl: "https://dotnet.microsoft.com/download/dotnet/10.0",
    license: {
      spdxExpression: "MIT",
      licenseFiles: ["LICENSE.txt", "ThirdPartyNotices.txt"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "dotnet10-macos-arm64": {
    id: "dotnet10-macos-arm64",
    provides: ["csharp"],
    entrypoints: [{
      kind: "csharp",
      componentId: "dotnet.host",
      executableRelativePath: "dotnet",
    }],
    kind: "csharp",
    version: "10.0.302",
    platform: "darwin",
    arch: "arm64",
    minimumOs: "14.0",
    archiveFormat: "tar.gz",
    archiveFilename: "judgedesk-dotnet10-macos-arm64-10.0.302.tar.gz",
    entrypointComponentId: "dotnet.host",
    components: [
      {
        id: "dotnet.host",
        kind: "executable",
        relativePath: "dotnet",
        roles: ["compiler", "submission-runtime"],
      },
      {
        id: "dotnet.root",
        kind: "support-root",
        relativePath: ".",
        roles: ["compiler", "submission-runtime"],
      },
    ],
    healthProbeId: "dotnet10.offline-console-v1",
    upstreamUrl: "https://dotnet.microsoft.com/download/dotnet/10.0",
    license: {
      spdxExpression: "MIT",
      licenseFiles: ["LICENSE.txt", "ThirdPartyNotices.txt"],
      noticeFiles: ["THIRD-PARTY-NOTICES.txt"],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "scratch-windows-x64": {
    id: "scratch-windows-x64",
    provides: ["scratch"],
    entrypoints: [{
      kind: "scratch",
      componentId: "scratch.runtime",
      executableRelativePath: "scratch-run.exe",
    }],
    kind: "scratch",
    version: "0.1.7",
    platform: "win32",
    arch: "x64",
    minimumOs: "10.0",
    archiveFormat: "zip",
    archiveFilename: "scratch-run_0.1.7_win_amd64.zip",
    entrypointComponentId: "scratch.runtime",
    components: [
      {
        id: "scratch.runtime",
        kind: "executable",
        relativePath: "scratch-run.exe",
        roles: ["submission-runtime"],
      },
    ],
    healthProbeId: "scratch.isolated-script-v1",
    upstreamUrl: "https://github.com/VNOI-Admin/scratch-run/releases/download/0.1.7/scratch-run_0.1.7_win_amd64.zip",
    license: {
      spdxExpression: "AGPL-3.0",
      licenseFiles: ["LICENSE"],
      noticeFiles: [],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "scratch-macos-arm64": {
    id: "scratch-macos-arm64",
    provides: ["scratch"],
    entrypoints: [{
      kind: "scratch",
      componentId: "scratch.runtime",
      executableRelativePath: "scratch-run",
    }],
    kind: "scratch",
    version: "0.1.7",
    platform: "darwin",
    arch: "arm64",
    minimumOs: "13.5",
    archiveFormat: "zip",
    archiveFilename: "scratch-run_0.1.7_macos_arm64.zip",
    entrypointComponentId: "scratch.runtime",
    components: [
      {
        id: "scratch.runtime",
        kind: "executable",
        relativePath: "scratch-run",
        roles: ["submission-runtime"],
      },
    ],
    healthProbeId: "scratch.isolated-script-v1",
    upstreamUrl: "https://github.com/VNOI-Admin/scratch-run/releases/download/0.1.7/scratch-run_0.1.7_macos_arm64.zip",
    license: {
      spdxExpression: "AGPL-3.0",
      licenseFiles: ["LICENSE"],
      noticeFiles: [],
      sbomPath: "SBOM.spdx.json",
    },
  },
  "scratch-macos-x64": {
    id: "scratch-macos-x64",
    provides: ["scratch"],
    entrypoints: [{
      kind: "scratch",
      componentId: "scratch.runtime",
      executableRelativePath: "scratch-run",
    }],
    kind: "scratch",
    version: "0.1.7",
    platform: "darwin",
    arch: "x64",
    minimumOs: "13.5",
    archiveFormat: "zip",
    archiveFilename: "scratch-run_0.1.7_macos_amd64.zip",
    entrypointComponentId: "scratch.runtime",
    components: [
      {
        id: "scratch.runtime",
        kind: "executable",
        relativePath: "scratch-run",
        roles: ["submission-runtime"],
      },
    ],
    healthProbeId: "scratch.isolated-script-v1",
    upstreamUrl: "https://github.com/VNOI-Admin/scratch-run/releases/download/0.1.7/scratch-run_0.1.7_macos_amd64.zip",
    license: {
      spdxExpression: "AGPL-3.0",
      licenseFiles: ["LICENSE"],
      noticeFiles: [],
      sbomPath: "SBOM.spdx.json",
    },
  },
});

let cachedManifest: {
  expiresAt: number;
  sourceKey: string;
  toolchains: ToolchainDescriptor[];
} | null = null;
let cachedBundledManifest: {
  filePath: string;
  size: number;
  modifiedMs: number;
  toolchains: ToolchainDescriptor[];
} | null = null;

export function normalizeHostArchitecture(arch: string): string {
  return arch === "x86_64" || arch === "amd64"
    ? "x64"
    : arch === "aarch64"
      ? "arm64"
      : arch;
}

function catalogEntry(id: string): ToolchainCatalogEntry {
  const entry = TOOLCHAIN_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown toolchain package '${id}'.`);
  return entry;
}

function releaseBlueprint(id: string): ToolchainReleaseBlueprint {
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[id];
  if (!blueprint) {
    throw new Error(`Toolchain package '${id}' has no trusted release blueprint.`);
  }
  return blueprint;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  const unexpected = Object.keys(value).find((key) => !expectedSet.has(key));
  if (unexpected) throw new Error(`${label} contains unknown field '${unexpected}'.`);
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new Error(`${label} is missing '${missing}'.`);
}

function validateIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function validateSafeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  if (
    value.includes("\\")
    || value.startsWith("/")
    || /^[a-z]:/i.test(value)
    || value.split("/").some((component) => !component || component === "..")
  ) {
    throw new Error(`${label} is not a normalized relative path.`);
  }
  return value;
}

function validateStringArray(
  value: unknown,
  label: string,
  validate: (entry: unknown, entryLabel: string) => string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${options.allowEmpty ? "an" : "a non-empty"} array.`);
  }
  const result = value.map((entry, index) => validate(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} contains duplicate values.`);
  }
  return result;
}

function validateIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !COMPONENT_ID_PATTERN.test(value)) {
    throw new Error(`${label} has an invalid identifier.`);
  }
  return value;
}

function validatePlainString(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || /[\0\r\n]/.test(value)
  ) {
    throw new Error(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function validateHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an HTTPS URL.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} must be an HTTPS URL without credentials.`);
  }
  return url.toString();
}

function validatePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function validateComponent(value: unknown, index: number): ToolchainPackageComponent {
  if (!isPlainRecord(value)) throw new Error(`Toolchain component ${index} must be an object.`);
  assertExactKeys(value, ["id", "kind", "relativePath", "roles"], `Toolchain component ${index}`);
  const id = validateIdentifier(value.id, `Toolchain component ${index} id`);
  if (value.kind !== "executable" && value.kind !== "support-root") {
    throw new Error(`Toolchain component '${id}' has an invalid kind.`);
  }
  const relativePath = value.relativePath === "."
    ? "."
    : validateSafeRelativePath(value.relativePath, `Toolchain component '${id}' path`);
  const roles = validateStringArray(
    value.roles,
    `Toolchain component '${id}' roles`,
    (entry, label) => {
      if (
        entry !== "compiler"
        && entry !== "submission-runtime"
        && entry !== "checker-runtime"
      ) {
        throw new Error(`${label} contains an invalid role.`);
      }
      return entry;
    },
  ) as ToolchainPackageComponent["roles"];
  return { id, kind: value.kind, relativePath, roles };
}

function validateLicense(value: unknown, packageId: string): ToolchainPackageLicense {
  if (!isPlainRecord(value)) {
    throw new Error(`Toolchain '${packageId}' license metadata must be an object.`);
  }
  assertExactKeys(
    value,
    ["spdxExpression", "licenseFiles", "noticeFiles", "sbomPath"],
    `Toolchain '${packageId}' license metadata`,
  );
  return {
    spdxExpression: validatePlainString(
      value.spdxExpression,
      `Toolchain '${packageId}' SPDX expression`,
    ),
    licenseFiles: validateStringArray(
      value.licenseFiles,
      `Toolchain '${packageId}' license files`,
      validateSafeRelativePath,
    ),
    noticeFiles: validateStringArray(
      value.noticeFiles,
      `Toolchain '${packageId}' notice files`,
      validateSafeRelativePath,
      { allowEmpty: true },
    ),
    sbomPath: validateSafeRelativePath(
      value.sbomPath,
      `Toolchain '${packageId}' SBOM path`,
    ),
  };
}

function validateV2Package(value: unknown): ToolchainDescriptor {
  if (!isPlainRecord(value)) throw new Error("Toolchain package must be an object.");
  assertExactKeys(
    value,
    [
      "id",
      "provides",
      "entrypoints",
      "kind",
      "version",
      "platform",
      "arch",
      "minimumOs",
      "archiveFormat",
      "downloadUrl",
      "sha256",
      "sizeBytes",
      "installedSizeBytes",
      "entrypointComponentId",
      "components",
      "healthProbeId",
      "upstreamUrl",
      "license",
    ],
    "Toolchain package",
  );
  const expected = catalogEntry(validateIdentifier(value.id, "Toolchain package ID"));
  const blueprint = releaseBlueprint(expected.id);
  for (const field of ["kind", "version", "platform", "arch", "archiveFormat"] as const) {
    if (value[field] !== expected[field]) {
      throw new Error(`Toolchain '${expected.id}' has an invalid ${field}.`);
    }
  }
  if (
    !Array.isArray(value.provides)
    || value.provides.length === 0
    || value.provides.some((kind) =>
      typeof kind !== "string" || !expected.provides.includes(kind as never)
    )
    || value.provides.length !== expected.provides.length
    || value.provides.some((kind, index) => kind !== expected.provides[index])
  ) {
    throw new Error(`Toolchain '${expected.id}' has invalid provided toolchain kinds.`);
  }
  if (
    !Array.isArray(value.entrypoints)
    || value.entrypoints.length !== expected.entrypoints.length
  ) {
    throw new Error(`Toolchain '${expected.id}' has invalid language entrypoints.`);
  }
  const minimumOs = validatePlainString(value.minimumOs, `Toolchain '${expected.id}' minimum OS`);
  const componentsRaw = value.components;
  if (!Array.isArray(componentsRaw) || componentsRaw.length === 0 || componentsRaw.length > 64) {
    throw new Error(`Toolchain '${expected.id}' must declare 1 to 64 components.`);
  }
  const components = componentsRaw.map(validateComponent);
  if (new Set(components.map((component) => component.id)).size !== components.length) {
    throw new Error(`Toolchain '${expected.id}' contains duplicate component IDs.`);
  }
  const entrypointComponentId = validateIdentifier(
    value.entrypointComponentId,
    `Toolchain '${expected.id}' entrypoint component`,
  );
  const entrypoint = components.find((component) => component.id === entrypointComponentId);
  if (
    !entrypoint
    || entrypoint.kind !== "executable"
    || entrypoint.relativePath !== expected.executableRelativePath.replaceAll("\\", "/")
  ) {
    throw new Error(`Toolchain '${expected.id}' has an invalid entrypoint component.`);
  }
  const entrypoints = value.entrypoints.map((candidate, index) => {
    if (!isPlainRecord(candidate)) {
      throw new Error(`Toolchain '${expected.id}' entrypoint ${index} is invalid.`);
    }
    assertExactKeys(
      candidate,
      ["kind", "componentId", "executableRelativePath"],
      `Toolchain '${expected.id}' entrypoint ${index}`,
    );
    if (
      typeof candidate.kind !== "string"
      || !(value.provides as unknown[]).includes(candidate.kind)
    ) {
      throw new Error(`Toolchain '${expected.id}' entrypoint ${index} has an invalid kind.`);
    }
    const componentId = validateIdentifier(
      candidate.componentId,
      `Toolchain '${expected.id}' entrypoint ${index} component`,
    );
    const executableRelativePath = validateSafeRelativePath(
      candidate.executableRelativePath,
      `Toolchain '${expected.id}' entrypoint ${index} path`,
    );
    const component = components.find((entry) => entry.id === componentId);
    if (
      !component
      || component.kind !== "executable"
      || component.relativePath !== executableRelativePath
    ) {
      throw new Error(
        `Toolchain '${expected.id}' entrypoint ${index} does not identify an executable component.`,
      );
    }
    return {
      kind: candidate.kind,
      componentId,
      executableRelativePath,
    };
  });
  if (
    new Set(entrypoints.map((entry) => entry.kind)).size !== entrypoints.length
  ) {
    throw new Error(`Toolchain '${expected.id}' contains duplicate language entrypoints.`);
  }
  const license = validateLicense(value.license, expected.id);
  for (const requiredLicense of expected.licenseFiles) {
    if (!license.licenseFiles.includes(requiredLicense.replaceAll("\\", "/"))) {
      throw new Error(`Toolchain '${expected.id}' omits required license '${requiredLicense}'.`);
    }
  }
  const sha256 = String(value.sha256 || "").toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Toolchain '${expected.id}' has an invalid SHA-256 digest.`);
  }
  if (REVOKED_TOOLCHAIN_PACKAGE_DIGESTS.has(sha256)) {
    throw new Error(`Toolchain '${expected.id}' package digest has been revoked.`);
  }
  const healthProbeId = validateIdentifier(
    value.healthProbeId,
    `Toolchain '${expected.id}' health probe`,
  );
  const upstreamUrl = validateHttpsUrl(
    value.upstreamUrl,
    `Toolchain '${expected.id}' upstream URL`,
  );
  const signedPolicy = {
    minimumOs,
    provides: value.provides,
    entrypoints,
    entrypointComponentId,
    components,
    healthProbeId,
    upstreamUrl,
    license,
  };
  const trustedPolicy = {
    minimumOs: blueprint.minimumOs,
    provides: blueprint.provides,
    entrypoints: blueprint.entrypoints,
    entrypointComponentId: blueprint.entrypointComponentId,
    components: blueprint.components,
    healthProbeId: blueprint.healthProbeId,
    upstreamUrl: new URL(blueprint.upstreamUrl).toString(),
    license: blueprint.license,
  };
  if (canonicalizeValue(signedPolicy) !== canonicalizeValue(trustedPolicy)) {
    throw new Error(
      `Toolchain '${expected.id}' does not match the trusted release blueprint.`,
    );
  }
  return {
    ...expected,
    downloadUrl: validateHttpsUrl(value.downloadUrl, `Toolchain '${expected.id}' download URL`),
    sha256,
    sizeBytes: validatePositiveSafeInteger(value.sizeBytes, `Toolchain '${expected.id}' package size`),
    manifestSchemaVersion: 2,
    minimumOs,
    installedSizeBytes: validatePositiveSafeInteger(
      value.installedSizeBytes,
      `Toolchain '${expected.id}' installed size`,
    ),
    entrypointComponentId,
    components,
    healthProbeId,
    upstreamUrl,
    license,
  };
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Signed manifest payload contains a non-integer number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeValue).join(",")}]`;
  if (!isPlainRecord(value)) throw new Error("Signed manifest payload contains an unsupported value.");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalizeValue(value[key])}`
  ).join(",")}}`;
}

export function canonicalizeManifestPayload(payload: ToolchainManifestV2Payload): string {
  return canonicalizeValue(payload);
}

function validateV2Manifest(
  value: Record<string, unknown>,
  options: ManifestValidationOptions,
): ToolchainDescriptor[] {
  assertExactKeys(value, ["schemaVersion", "signed", "signature"], "Toolchain manifest v2");
  if (!isPlainRecord(value.signed)) throw new Error("Toolchain manifest v2 signed payload is invalid.");
  assertExactKeys(value.signed, ["generatedAt", "packages"], "Toolchain manifest v2 payload");
  validateIsoTimestamp(value.signed.generatedAt, "Toolchain manifest generatedAt");
  if (!Array.isArray(value.signed.packages)) {
    throw new Error("Toolchain manifest contains no package list.");
  }
  if (value.signed.packages.length === 0) {
    throw new Error("Toolchain manifest contains an empty package list.");
  }
  if (!isPlainRecord(value.signature)) throw new Error("Toolchain manifest v2 signature is invalid.");
  assertExactKeys(value.signature, ["algorithm", "keyId", "value"], "Toolchain manifest v2 signature");
  if (value.signature.algorithm !== "ed25519") {
    throw new Error("Toolchain manifest v2 uses an unsupported signature algorithm.");
  }
  const keyId = String(value.signature.keyId || "");
  if (!MANIFEST_KEY_ID_PATTERN.test(keyId)) {
    throw new Error("Toolchain manifest v2 has an invalid signing key ID.");
  }
  if (REVOKED_TOOLCHAIN_MANIFEST_KEY_IDS.has(keyId)) {
    throw new Error(`Toolchain manifest v2 signing key '${keyId}' has been revoked.`);
  }
  const publicKey = (options.trustedPublicKeys ?? OFFICIAL_TOOLCHAIN_MANIFEST_PUBLIC_KEYS)[keyId];
  if (!publicKey) throw new Error(`Toolchain manifest v2 signing key '${keyId}' is not trusted.`);
  const signatureText = String(value.signature.value || "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText)) {
    throw new Error("Toolchain manifest v2 signature is not valid base64.");
  }
  const signature = Buffer.from(signatureText, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== signatureText) {
    throw new Error("Toolchain manifest v2 signature has an invalid encoding.");
  }
  const payload = value.signed as unknown as ToolchainManifestV2Payload;
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(canonicalizeManifestPayload(payload), "utf8"),
      publicKey,
      signature,
    );
  } catch {
    verified = false;
  }
  if (!verified) throw new Error("Toolchain manifest v2 signature verification failed.");

  const validated = value.signed.packages.map(validateV2Package).map((descriptor) => ({
    ...descriptor,
    signingKeyId: keyId,
  }));
  if (new Set(validated.map((entry) => entry.id)).size !== validated.length) {
    throw new Error("Toolchain manifest contains duplicate package IDs.");
  }
  return validated;
}

function validateDescriptor(value: unknown): ToolchainDescriptor {
  if (!value || typeof value !== "object")
    throw new Error("Toolchain entry must be an object.");
  const candidate = value as Record<string, unknown>;
  const expected = catalogEntry(String(candidate.id || ""));

  for (const field of [
    "kind",
    "version",
    "platform",
    "arch",
    "archiveFormat",
    "executableRelativePath",
  ] as const) {
    if (candidate[field] !== expected[field]) {
      throw new Error(`Toolchain '${expected.id}' has an invalid ${field}.`);
    }
  }

  if (typeof candidate.downloadUrl !== "string")
    throw new Error(`Toolchain '${expected.id}' has no download URL.`);
  const downloadUrl = new URL(candidate.downloadUrl);
  if (downloadUrl.protocol !== "https:")
    throw new Error(`Toolchain '${expected.id}' must use HTTPS.`);
  if (!SHA256_PATTERN.test(String(candidate.sha256 || ""))) {
    throw new Error(
      `Toolchain '${expected.id}' has an invalid SHA-256 digest.`,
    );
  }
  const sizeBytes = Number(candidate.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Toolchain '${expected.id}' has an invalid package size.`);
  }

  return {
    ...expected,
    downloadUrl: downloadUrl.toString(),
    sha256: String(candidate.sha256).toLowerCase(),
    sizeBytes,
    manifestSchemaVersion: 1,
  };
}

export function validateManifestDocument(
  value: unknown,
  options: ManifestValidationOptions = {},
): ToolchainDescriptor[] {
  if (!isPlainRecord(value))
    throw new Error("Toolchain manifest must be an object.");
  const document = value as unknown as ToolchainManifestDocument;
  if (document.schemaVersion === 2) return validateV2Manifest(value, options);
  if (options.requireSignedV2) {
    throw new Error("A signed toolchain manifest v2 is required.");
  }
  if (document.schemaVersion !== 1) throw new Error("Unsupported toolchain manifest schema.");
  if (!Array.isArray(document.toolchains))
    throw new Error("Toolchain manifest contains no package list.");

  const validated = document.toolchains.map(validateDescriptor);
  if (new Set(validated.map((entry) => entry.id)).size !== validated.length) {
    throw new Error("Toolchain manifest contains duplicate package IDs.");
  }
  return validated;
}

export async function loadOfficialManifest(
  options: {
    forceRefresh?: boolean;
    fetchImpl?: typeof fetch;
    manifestUrl?: string;
    trustedPublicKeys?: Readonly<Record<string, string>>;
    bundledManifestPath?: string;
    requireSignedV2?: boolean;
  } = {},
): Promise<ToolchainDescriptor[]> {
  const now = Date.now();
  const manifestUrl =
    options.manifestUrl ||
    process.env.THEMIS_TOOLCHAIN_MANIFEST_URL ||
    DEFAULT_TOOLCHAIN_MANIFEST_URL;
  const bundledManifestPath = options.bundledManifestPath
    ?? path.join(RESOURCE_ROOT, "toolchains-manifest.json");
  const useBundledManifest = !options.forceRefresh
    && fs.statSync(bundledManifestPath, { throwIfNoEntry: false })?.isFile();
  const sourceKey = useBundledManifest
    ? `file:${path.resolve(bundledManifestPath)}`
    : `url:${manifestUrl}`;
  if (
    !options.forceRefresh &&
    cachedManifest &&
    cachedManifest.sourceKey === sourceKey &&
    cachedManifest.expiresAt > now
  ) {
    return cachedManifest.toolchains;
  }

  let document: unknown;
  if (useBundledManifest) {
    const bytes = fs.readFileSync(bundledManifestPath);
    if (bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 * 1024) {
      throw new Error("Bundled toolchain manifest has an invalid size.");
    }
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Bundled toolchain manifest is not valid JSON.");
    }
  } else {
    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl(manifestUrl, {
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Toolchain manifest request failed (${response.status}).`);
    }
    document = await response.json();
  }
  const toolchains = validateManifestDocument(document, {
    trustedPublicKeys: options.trustedPublicKeys,
    requireSignedV2: options.requireSignedV2 ?? true,
  });
  cachedManifest = {
    expiresAt: now + MANIFEST_CACHE_MS,
    sourceKey,
    toolchains,
  };
  return toolchains;
}

export function loadBundledOfficialManifestSync(
  options: {
    bundledManifestPath?: string;
    trustedPublicKeys?: Readonly<Record<string, string>>;
  } = {},
): ToolchainDescriptor[] {
  const filePath = path.resolve(
    options.bundledManifestPath
      ?? path.join(RESOURCE_ROOT, "toolchains-manifest.json"),
  );
  const metadata = fs.statSync(filePath, { throwIfNoEntry: false });
  if (
    !metadata?.isFile()
    || metadata.size <= 0
    || metadata.size > 4 * 1024 * 1024
  ) {
    throw new Error("Bundled toolchain manifest has an invalid size.");
  }
  if (
    !options.trustedPublicKeys
    && cachedBundledManifest
    && cachedBundledManifest.filePath === filePath
    && cachedBundledManifest.size === metadata.size
    && cachedBundledManifest.modifiedMs === metadata.mtimeMs
  ) {
    return cachedBundledManifest.toolchains;
  }
  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("Bundled toolchain manifest is not valid JSON.");
  }
  const toolchains = validateManifestDocument(document, {
    trustedPublicKeys:
      options.trustedPublicKeys ?? OFFICIAL_TOOLCHAIN_MANIFEST_PUBLIC_KEYS,
    requireSignedV2: true,
  });
  if (!options.trustedPublicKeys) {
    cachedBundledManifest = {
      filePath,
      size: metadata.size,
      modifiedMs: metadata.mtimeMs,
      toolchains,
    };
  }
  return toolchains;
}

export function getDescriptorForHost(
  platform: string,
  arch: string,
  kind: string,
): ToolchainCatalogEntry | undefined {
  const mappedArch = normalizeHostArchitecture(arch);
  return TOOLCHAIN_CATALOG.find(
    (entry) =>
      entry.platform === platform &&
      entry.arch === mappedArch &&
      entry.provides.includes(kind as never),
  );
}
