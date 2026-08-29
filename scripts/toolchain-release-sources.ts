import path from "node:path";
import {
  TOOLCHAIN_RELEASE_BLUEPRINTS,
} from "../server/toolchains/manifest.js";
import type {
  HostArchitecture,
  HostPlatform,
} from "../server/languages/contracts.js";
import {
  TOOLCHAIN_SOURCE_PROVENANCE_FILENAME,
} from "../server/toolchains/release-metadata.js";

export { TOOLCHAIN_SOURCE_PROVENANCE_FILENAME };

export type ToolchainPackagingRecipe =
  | {
      kind: "archive-root";
      rootPath: string;
    }
  | {
      kind: "rust-installer";
      rootPath: string;
      components: readonly string[];
    }
  | {
      kind: "fpc-windows-installer";
    }
  | {
      kind: "fpc-macos-dmg";
    };

export interface ToolchainUpstreamInput {
  id: string;
  fileName: string;
  url: string;
  sha256: string;
  /**
   * Some upstreams publish SHA-512 as their canonical release checksum.
   * JudgeDesk verifies both hashes when it is available.
   */
  sha512?: string;
  role: "primary" | "license" | "source";
  destinationRelativePath?: string;
}

export interface ToolchainReleaseSource {
  packageId: string;
  platform: HostPlatform;
  arch: HostArchitecture;
  recipe: ToolchainPackagingRecipe;
  inputs: readonly [
    ToolchainUpstreamInput,
    ...ToolchainUpstreamInput[],
  ];
  packagingDescription: string;
}

export interface ToolchainSourceProvenanceV1 {
  schemaVersion: 1;
  packageId: string;
  packageVersion: string;
  createdAt: string;
  packagingDescription: string;
  inputs: readonly {
    id: string;
    fileName: string;
    url: string;
    sha256: string;
    sha512?: string;
    role: ToolchainUpstreamInput["role"];
  }[];
}

const PYTHON_RELEASE =
  "https://github.com/astral-sh/python-build-standalone/releases/download/20260623";
const NODE_RELEASE = "https://nodejs.org/dist/v24.18.1";
const RUST_RELEASE = "https://static.rust-lang.org/dist";
const DOTNET_RELEASE =
  "https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.302";
const FPC_SOURCEFORGE =
  "https://downloads.sourceforge.net/project/freepascal";

/**
 * This is the auditable source-of-truth for release inputs. URLs never point
 * at "latest", package-manager indexes, mutable installers, or unverified
 * mirrors. Updating any input requires a code review and a new signed
 * toolchain manifest.
 */
export const TOOLCHAIN_RELEASE_SOURCES: Readonly<
  Record<string, ToolchainReleaseSource>
> = Object.freeze({
  "gcc-windows-x64": {
    packageId: "gcc-windows-x64",
    platform: "win32",
    arch: "x64",
    recipe: {
      kind: "archive-root",
      rootPath: "mingw64",
    },
    inputs: [
      {
        id: "winlibs",
        fileName:
          "winlibs-x86_64-posix-seh-gcc-14.2.0-mingw-w64ucrt-12.0.0-r2.zip",
        url:
          "https://github.com/brechtsanders/winlibs_mingw/releases/download/14.2.0posix-19.1.1-12.0.0-ucrt-r2/winlibs-x86_64-posix-seh-gcc-14.2.0-mingw-w64ucrt-12.0.0-r2.zip",
        sha256:
          "d41933cef13113018418d7b596319c2ed59a567395bbb87afe27a171e111d553",
        role: "primary",
      },
      {
        id: "gcc-copying",
        fileName: "COPYING3",
        url:
          "https://gcc.gnu.org/git/?p=gcc.git;a=blob_plain;f=COPYING3;hb=releases/gcc-14.2.0",
        sha256:
          "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
        role: "license",
        destinationRelativePath: "COPYING3",
      },
      {
        id: "gcc-runtime-copying",
        fileName: "COPYING.RUNTIME",
        url:
          "https://gcc.gnu.org/git/?p=gcc.git;a=blob_plain;f=COPYING.RUNTIME;hb=releases/gcc-14.2.0",
        sha256:
          "9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74",
        role: "license",
        destinationRelativePath: "COPYING.RUNTIME",
      },
    ],
    packagingDescription:
      "Normalizes the verified WinLibs UCRT archive root and adds the pinned GCC license texts.",
  },
  "python-windows-x64": {
    packageId: "python-windows-x64",
    platform: "win32",
    arch: "x64",
    recipe: {
      kind: "archive-root",
      rootPath: "python",
    },
    inputs: [{
      id: "cpython",
      fileName:
        "cpython-3.12.13+20260623-x86_64-pc-windows-msvc-install_only.tar.gz",
      url:
        `${PYTHON_RELEASE}/cpython-3.12.13%2B20260623-x86_64-pc-windows-msvc-install_only.tar.gz`,
      sha256:
        "c6af85bb83d5158c9ff71f50dfad467853d1cd236f932b144e87e26e2ea2a83e",
      role: "primary",
    }],
    packagingDescription:
      "Normalizes the install-only CPython distribution without changing runtime binaries.",
  },
  "python-macos-arm64": {
    packageId: "python-macos-arm64",
    platform: "darwin",
    arch: "arm64",
    recipe: {
      kind: "archive-root",
      rootPath: "python",
    },
    inputs: [{
      id: "cpython",
      fileName:
        "cpython-3.12.13+20260623-aarch64-apple-darwin-install_only.tar.gz",
      url:
        `${PYTHON_RELEASE}/cpython-3.12.13%2B20260623-aarch64-apple-darwin-install_only.tar.gz`,
      sha256:
        "3724aa4dafb5f7b6c2cf98e89914e4248dc6bd2fe40407df4a2d73de99615f16",
      role: "primary",
    }],
    packagingDescription:
      "Normalizes the install-only CPython distribution without changing runtime binaries.",
  },
  "go-windows-x64": {
    packageId: "go-windows-x64",
    platform: "win32",
    arch: "x64",
    recipe: {
      kind: "archive-root",
      rootPath: "go",
    },
    inputs: [{
      id: "go",
      fileName: "go1.26.5.windows-amd64.zip",
      url: "https://go.dev/dl/go1.26.5.windows-amd64.zip",
      sha256:
        "97e6b2a833b6d89f9ff17d25419ac0a7e3b482a044e9ab18cdef834bd834fd38",
      role: "primary",
    }],
    packagingDescription:
      "Normalizes the official Go archive; JudgeDesk creates a fresh isolated build cache for each compilation.",
  },
  "go-macos-arm64": {
    packageId: "go-macos-arm64",
    platform: "darwin",
    arch: "arm64",
    recipe: {
      kind: "archive-root",
      rootPath: "go",
    },
    inputs: [{
      id: "go",
      fileName: "go1.26.5.darwin-arm64.tar.gz",
      url: "https://go.dev/dl/go1.26.5.darwin-arm64.tar.gz",
      sha256:
        "efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a",
      role: "primary",
    }],
    packagingDescription:
      "Normalizes the official Go archive; JudgeDesk creates a fresh isolated build cache for each compilation.",
  },
  "node-windows-x64": {
    packageId: "node-windows-x64",
    platform: "win32",
    arch: "x64",
    recipe: {
      kind: "archive-root",
      rootPath: "node-v24.18.1-win-x64",
    },
    inputs: [{
      id: "node",
      fileName: "node-v24.18.1-win-x64.zip",
      url: `${NODE_RELEASE}/node-v24.18.1-win-x64.zip`,
      sha256:
        "ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765",
      role: "primary",
    }],
    packagingDescription:
      "Normalizes the official Node.js binary archive without changing runtime binaries.",
  },
  "node-macos-arm64": {
    packageId: "node-macos-arm64",
    platform: "darwin",
    arch: "arm64",
    recipe: {
      kind: "archive-root",
      rootPath: "node-v24.18.1-darwin-arm64",
    },
    inputs: [{
      id: "node",
      fileName: "node-v24.18.1-darwin-arm64.tar.gz",
      url: `${NODE_RELEASE}/node-v24.18.1-darwin-arm64.tar.gz`,
      sha256:
        "eb02f7fab96d3d67de40c5ec8566096fcb4c2026728787683ae5a97eb612b941",
      role: "primary",
    }],
    packagingDescription:
      "Normalizes the official Node.js binary archive without changing runtime binaries.",
  },
  "fpc-windows-x64": {
    packageId: "fpc-windows-x64",
    platform: "win32",
    arch: "x64",
    recipe: {
      kind: "fpc-windows-installer",
    },
    inputs: [
      {
        id: "fpc",
        fileName: "fpc-3.2.2.win32.and.win64.exe",
        url:
          `${FPC_SOURCEFORGE}/Win32/3.2.2/fpc-3.2.2.win32.and.win64.exe`,
        sha256:
          "8c255390544b051388b577eb61c6191a04883264afe0e3369b3600a56daf7bde",
        role: "primary",
      },
      {
        id: "fpc-source",
        fileName: "fpc-3.2.2.source.tar.gz",
        url:
          `${FPC_SOURCEFORGE}/Source/3.2.2/fpc-3.2.2.source.tar.gz`,
        sha256:
          "d542e349de246843d4f164829953d1f5b864126c5b62fd17c9b45b33e23d2f44",
        role: "source",
      },
    ],
    packagingDescription:
      "Runs the official combined Win32/Win64 installer in an isolated build root, rebuilds the pinned 3.2.2 source as a relocatable native x86_64 compiler, then keeps that compiler, binutils, units, and upstream license texts.",
  },
  "fpc-macos-arm64": {
    packageId: "fpc-macos-arm64",
    platform: "darwin",
    arch: "arm64",
    recipe: {
      kind: "fpc-macos-dmg",
    },
    inputs: [
      {
        id: "fpc",
        fileName: "fpc-3.2.2.intelarm64-macosx.dmg",
        url:
          `${FPC_SOURCEFORGE}/Mac%20OS%20X/3.2.2/fpc-3.2.2.intelarm64-macosx.dmg`,
        sha256:
          "05d4510c8c887e3c68de20272abf62171aa5b2ef1eba6bce25e4c0bc41ba8b7d",
        role: "primary",
      },
      {
        id: "fpc-source",
        fileName: "fpc-3.2.2.source.tar.gz",
        url:
          `${FPC_SOURCEFORGE}/Source/3.2.2/fpc-3.2.2.source.tar.gz`,
        sha256:
          "d542e349de246843d4f164829953d1f5b864126c5b62fd17c9b45b33e23d2f44",
        role: "source",
      },
    ],
    packagingDescription:
      "Expands the official package read-only and keeps the ARM64 driver, compiler, units, and upstream license texts.",
  },
  "temurin21-macos-arm64": {
    packageId: "temurin21-macos-arm64",
    platform: "darwin",
    arch: "arm64",
    recipe: {
      kind: "archive-root",
      rootPath: "jdk-21.0.12+8/Contents/Home",
    },
    inputs: [{
      id: "temurin",
      fileName:
        "OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12_8.tar.gz",
      url:
        "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12_8.tar.gz",
      sha256:
        "021d629349ebc12a409faa517b837ec80ceee8f58a5ac85c788ecad07ca6881c",
      role: "primary",
    }],
    packagingDescription:
      "Normalizes the official Temurin JDK Contents/Home tree without changing JDK binaries.",
  },
  "temurin21-windows-x64": {
    packageId: "temurin21-windows-x64",
    platform: "win32",
    arch: "x64",
    recipe: {
      kind: "archive-root",
      rootPath: "jdk-21.0.12+8",
    },
    inputs: [{
      id: "temurin",
      fileName:
        "OpenJDK21U-jdk_x64_windows_hotspot_21.0.12_8.zip",
      url:
        "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12_8.zip",
      sha256:
        "9ba963ee2371874a74185d18bc7bb2ab9407df7683300855ed7606e0662321d0",
      role: "primary",
    }],
    packagingDescription:
      "Normalizes the official Temurin Windows x64 JDK tree without changing JDK binaries.",
  },
  "rust-windows-x64-gnu": {
    packageId: "rust-windows-x64-gnu",
    platform: "win32",
    arch: "x64",
    recipe: {
      kind: "rust-installer",
      rootPath: "rust-1.97.1-x86_64-pc-windows-gnu",
      components: [
        "rustc",
        "rust-std-x86_64-pc-windows-gnu",
        "rust-mingw",
      ],
    },
    inputs: [{
      id: "rust",
      fileName: "rust-1.97.1-x86_64-pc-windows-gnu.tar.gz",
      url:
        `${RUST_RELEASE}/rust-1.97.1-x86_64-pc-windows-gnu.tar.gz`,
      sha256:
        "54709e21a51ae8d2702c123d42d8fcbb5495029f7a0627cec6cea560e7bbb2e5",
      role: "primary",
    }],
    packagingDescription:
      "Uses the official Rust installer to materialize only rustc, the pinned GNU standard library, and its MinGW linker closure.",
  },
  "rust-macos-arm64": {
    packageId: "rust-macos-arm64",
    platform: "darwin",
    arch: "arm64",
    recipe: {
      kind: "rust-installer",
      rootPath: "rust-1.97.1-aarch64-apple-darwin",
      components: [
        "rustc",
        "rust-std-aarch64-apple-darwin",
      ],
    },
    inputs: [{
      id: "rust",
      fileName: "rust-1.97.1-aarch64-apple-darwin.tar.gz",
      url:
        `${RUST_RELEASE}/rust-1.97.1-aarch64-apple-darwin.tar.gz`,
      sha256:
        "cbd14c36f039f6f11f38148a6295d8234d18ddf20bea53031c86f119423a8b26",
      role: "primary",
    }],
    packagingDescription:
      "Uses the official Rust installer to materialize only rustc and the pinned Apple ARM64 standard library.",
  },
  "dotnet10-windows-x64": {
    packageId: "dotnet10-windows-x64",
    platform: "win32",
    arch: "x64",
    recipe: {
      kind: "archive-root",
      rootPath: ".",
    },
    inputs: [{
      id: "dotnet",
      fileName: "dotnet-sdk-10.0.302-win-x64.zip",
      url: `${DOTNET_RELEASE}/dotnet-sdk-10.0.302-win-x64.zip`,
      sha256:
        "2cb9d5d98aeda0582ec02a1e429a613df6d97a1ce0f06b361f7def9b7e7c1a6b",
      sha512:
        "7d170ed75fa9af34c00646621d92011dbd71943952e2787cd15df9be78e6452b55dadef34d7eff77b802e6af4959e071a55855ac649afeac70901c3a2a258716",
      role: "primary",
    }],
    packagingDescription:
      "Normalizes the official .NET SDK archive and preserves its offline reference packs.",
  },
  "dotnet10-macos-arm64": {
    packageId: "dotnet10-macos-arm64",
    platform: "darwin",
    arch: "arm64",
    recipe: {
      kind: "archive-root",
      rootPath: ".",
    },
    inputs: [{
      id: "dotnet",
      fileName: "dotnet-sdk-10.0.302-osx-arm64.tar.gz",
      url: `${DOTNET_RELEASE}/dotnet-sdk-10.0.302-osx-arm64.tar.gz`,
      sha256:
        "8d9f9f6155896e3b1ebedcf1dc0c60248077c7ac0a88855e2102a377bc1e1e3b",
      sha512:
        "b2286dec9177e8b5543ff2fe95c84db358b87ec2a36a0d34a29033d70279940fd1134af56c4299648f8950db2d6ce35237698cf2818d9abc670c2c1664c92ac0",
      role: "primary",
    }],
    packagingDescription:
      "Normalizes the official .NET SDK archive and preserves its offline reference packs.",
  },
  "scratch-windows-x64": {
    packageId: "scratch-windows-x64",
    platform: "win32",
    arch: "x64",
    recipe: {
      kind: "archive-root",
      rootPath: ".",
    },
    inputs: [
      {
        id: "scratch-run",
        fileName: "scratch-run_0.1.7_win_amd64.zip",
        url: "https://github.com/VNOI-Admin/scratch-run/releases/download/0.1.7/scratch-run_0.1.7_win_amd64.zip",
        sha256: "062d63716f46042d72ef6077f6e3ba7b03a2b5935c6567e253bb7cfd624f9b25",
        role: "primary",
      },
      {
        id: "scratch-license",
        fileName: "LICENSE",
        url: "https://raw.githubusercontent.com/VNOI-Admin/scratch-run/master/LICENSE",
        sha256: "8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef",
        role: "license",
        destinationRelativePath: "LICENSE",
      },
    ],
    packagingDescription:
      "Packages the official VNOI scratch-run headless Scratch runner without modification.",
  },
  "scratch-macos-arm64": {
    packageId: "scratch-macos-arm64",
    platform: "darwin",
    arch: "arm64",
    recipe: {
      kind: "archive-root",
      rootPath: ".",
    },
    inputs: [
      {
        id: "scratch-run",
        fileName: "scratch-run_0.1.7_macos_arm64.zip",
        url: "https://github.com/VNOI-Admin/scratch-run/releases/download/0.1.7/scratch-run_0.1.7_macos_arm64.zip",
        sha256: "f683c101635122abf98291be20d28ccd8ab845e9a36dc94b64bf2ed173946287",
        role: "primary",
      },
      {
        id: "scratch-license",
        fileName: "LICENSE",
        url: "https://raw.githubusercontent.com/VNOI-Admin/scratch-run/master/LICENSE",
        sha256: "8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef",
        role: "license",
        destinationRelativePath: "LICENSE",
      },
    ],
    packagingDescription:
      "Packages the official VNOI scratch-run headless Scratch runner without modification.",
  },
  "scratch-macos-x64": {
    packageId: "scratch-macos-x64",
    platform: "darwin",
    arch: "x64",
    recipe: {
      kind: "archive-root",
      rootPath: ".",
    },
    inputs: [
      {
        id: "scratch-run",
        fileName: "scratch-run_0.1.7_macos_amd64.zip",
        url: "https://github.com/VNOI-Admin/scratch-run/releases/download/0.1.7/scratch-run_0.1.7_macos_amd64.zip",
        sha256: "d03336a1665374565258b363f4df983d5cdc92ee4f6acc62d7843f648b860e6d",
        role: "primary",
      },
      {
        id: "scratch-license",
        fileName: "LICENSE",
        url: "https://raw.githubusercontent.com/VNOI-Admin/scratch-run/master/LICENSE",
        sha256: "8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef",
        role: "license",
        destinationRelativePath: "LICENSE",
      },
    ],
    packagingDescription:
      "Packages the official VNOI scratch-run headless Scratch runner without modification.",
  },
});

function isNormalizedRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || /^[a-z]:/i.test(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return normalized === "."
    || (
      !normalized.startsWith("/")
      && !normalized.split("/").includes("..")
      && path.posix.normalize(normalized) === normalized
    );
}

export function validateToolchainReleaseSources(): void {
  const blueprintIds = Object.keys(TOOLCHAIN_RELEASE_BLUEPRINTS).sort();
  const sourceIds = Object.keys(TOOLCHAIN_RELEASE_SOURCES).sort();
  if (JSON.stringify(sourceIds) !== JSON.stringify(blueprintIds)) {
    throw new Error(
      "Release source catalog must cover every toolchain release blueprint exactly once.",
    );
  }

  for (const [packageId, release] of Object.entries(
    TOOLCHAIN_RELEASE_SOURCES,
  )) {
    const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[packageId];
    if (
      release.packageId !== packageId
      || release.platform !== blueprint.platform
      || release.arch !== blueprint.arch
    ) {
      throw new Error(`Release source host mismatch for '${packageId}'.`);
    }
    if (!release.packagingDescription.trim()) {
      throw new Error(`Release source '${packageId}' has no packaging description.`);
    }
    if (release.inputs.filter((input) => input.role === "primary").length !== 1) {
      throw new Error(`Release source '${packageId}' must have one primary input.`);
    }
    const inputIds = new Set<string>();
    for (const input of release.inputs) {
      if (
        !/^[a-z0-9][a-z0-9._-]*$/.test(input.id)
        || inputIds.has(input.id)
      ) {
        throw new Error(`Release source '${packageId}' has an invalid input ID.`);
      }
      inputIds.add(input.id);
      if (
        !input.fileName
        || input.fileName === "."
        || input.fileName === ".."
        || input.fileName.includes("/")
        || input.fileName.includes("\\")
      ) {
        throw new Error(`Release source '${packageId}' has an unsafe filename.`);
      }
      const parsedUrl = new URL(input.url);
      if (parsedUrl.protocol !== "https:") {
        throw new Error(`Release source '${packageId}' must use HTTPS.`);
      }
      if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
        throw new Error(`Release source '${packageId}' has an invalid SHA-256.`);
      }
      if (input.sha512 && !/^[a-f0-9]{128}$/.test(input.sha512)) {
        throw new Error(`Release source '${packageId}' has an invalid SHA-512.`);
      }
      if (
        input.role === "license"
        && (
          !input.destinationRelativePath
          || !isNormalizedRelativePath(input.destinationRelativePath)
        )
      ) {
        throw new Error(
          `Release source '${packageId}' has an invalid license destination.`,
        );
      }
    }
    if (
      "rootPath" in release.recipe
      && !isNormalizedRelativePath(release.recipe.rootPath)
    ) {
      throw new Error(`Release source '${packageId}' has an invalid archive root.`);
    }
  }
}

export function buildToolchainSourceProvenance(
  packageId: string,
  createdAt: string,
): ToolchainSourceProvenanceV1 {
  const release = TOOLCHAIN_RELEASE_SOURCES[packageId];
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[packageId];
  if (!release || !blueprint) {
    throw new Error(`Unknown toolchain release package '${packageId}'.`);
  }
  if (
    !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt
  ) {
    throw new Error("Toolchain provenance timestamp must be canonical ISO.");
  }
  return {
    schemaVersion: 1,
    packageId,
    packageVersion: blueprint.version,
    createdAt,
    packagingDescription: release.packagingDescription,
    inputs: release.inputs.map((input) => ({
      id: input.id,
      fileName: input.fileName,
      url: input.url,
      sha256: input.sha256,
      ...(input.sha512 ? { sha512: input.sha512 } : {}),
      role: input.role,
    })),
  };
}

export function validateToolchainSourceProvenance(
  value: unknown,
  packageId: string,
): ToolchainSourceProvenanceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Package '${packageId}' has invalid source provenance.`);
  }
  const candidate = value as Partial<ToolchainSourceProvenanceV1>;
  if (typeof candidate.createdAt !== "string") {
    throw new Error(`Package '${packageId}' has no provenance timestamp.`);
  }
  const expected = buildToolchainSourceProvenance(
    packageId,
    candidate.createdAt,
  );
  const normalized: ToolchainSourceProvenanceV1 = {
    schemaVersion: candidate.schemaVersion as 1,
    packageId: String(candidate.packageId || ""),
    packageVersion: String(candidate.packageVersion || ""),
    createdAt: candidate.createdAt,
    packagingDescription: String(candidate.packagingDescription || ""),
    inputs: Array.isArray(candidate.inputs)
      ? candidate.inputs.map((input) => ({
          id: String(input?.id || ""),
          fileName: String(input?.fileName || ""),
          url: String(input?.url || ""),
          sha256: String(input?.sha256 || ""),
          ...(input?.sha512 ? { sha512: String(input.sha512) } : {}),
          role: input?.role as ToolchainUpstreamInput["role"],
        }))
      : [],
  };
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new Error(
      `Package '${packageId}' source provenance does not match the pinned release catalog.`,
    );
  }
  return expected;
}

validateToolchainReleaseSources();
