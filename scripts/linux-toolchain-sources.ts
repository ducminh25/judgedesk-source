import type { ToolchainReleaseSource, ToolchainUpstreamInput } from "./toolchain-release-sources.js";

export const LINUX_SYSROOT_INPUTS: readonly ToolchainUpstreamInput[] = [
  {
    id: "sysroot-libc6", fileName: "libc6_2.35-0ubuntu3.15_amd64.deb",
    url: "https://security.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.35-0ubuntu3.15_amd64.deb",
    sha256: "79e35256227e16a607c154cdeb8d76ff12d20e31de286ea7fd9ad3b96fe0452d", role: "source",
  },
  {
    id: "sysroot-libc6-dev", fileName: "libc6-dev_2.35-0ubuntu3.15_amd64.deb",
    url: "https://security.ubuntu.com/ubuntu/pool/main/g/glibc/libc6-dev_2.35-0ubuntu3.15_amd64.deb",
    sha256: "ce51ae233a9f800a040de2d0cd5983ef86f558c623b342c80942301d7f453f48", role: "source",
  },
  {
    id: "sysroot-linux-libc-dev", fileName: "linux-libc-dev_5.15.0-198.208_amd64.deb",
    url: "https://security.ubuntu.com/ubuntu/pool/main/l/linux/linux-libc-dev_5.15.0-198.208_amd64.deb",
    sha256: "d7ba314f1e0e79745f104eaeeb662723fb72b1d4ab45c923d93db32867dd11e7", role: "source",
  },
];

const GCC_INPUT: ToolchainUpstreamInput = {
  id: "gcc", fileName: "xpack-gcc-14.2.0-2-linux-x64.tar.gz",
  url: "https://github.com/xpack-dev-tools/gcc-xpack/releases/download/v14.2.0-2/xpack-gcc-14.2.0-2-linux-x64.tar.gz",
  sha256: "d27b09c677cefde24bdaacdde045d35ea1a391fbb5b4525d057e1974af912c4d", role: "primary",
};

export const LINUX_RELEASE_SOURCES: Readonly<Record<string, ToolchainReleaseSource>> = {
  "gcc-linux-x64": {
    packageId: "gcc-linux-x64", platform: "linux", arch: "x64", recipe: { kind: "linux-gcc" },
    inputs: [GCC_INPUT, ...LINUX_SYSROOT_INPUTS,
      { id: "gcc-license", fileName: "COPYING3", role: "license", destinationRelativePath: "COPYING3",
        url: "https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-14.2.0/COPYING3",
        sha256: "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903" },
      { id: "gcc-runtime-license", fileName: "COPYING.RUNTIME", role: "license", destinationRelativePath: "COPYING.RUNTIME",
        url: "https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-14.2.0/COPYING.RUNTIME",
        sha256: "9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74" },
    ],
    packagingDescription: "Normalizes xPack GCC without patching executables and adds a checksum-pinned Ubuntu 22.04 glibc/kernel-header sysroot. Compiler helpers and runtime libraries remain package-local.",
  },
  "python-linux-x64": {
    packageId: "python-linux-x64", platform: "linux", arch: "x64", recipe: { kind: "archive-root", rootPath: "python" },
    inputs: [{ id: "python", fileName: "cpython-3.12.13+20260623-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260623/cpython-3.12.13%2B20260623-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
      sha256: "10a452caac7041357805f0c19a60576df53f1ab06d1abfc9200f1f0157cb3bd1", role: "primary" }],
    packagingDescription: "Normalizes CPython standalone, materializes internal links and omits the optional non-relocatable terminal database; retains interpreter, standard library, extensions and upstream notices for headless judging.",
  },
  "fpc-linux-x64": {
    packageId: "fpc-linux-x64", platform: "linux", arch: "x64", recipe: { kind: "linux-fpc" },
    inputs: [
      { id: "fpc", fileName: "fpc-3.2.2.x86_64-linux.tar",
        url: "https://downloads.freepascal.org/fpc/dist/3.2.2/x86_64-linux/fpc-3.2.2.x86_64-linux.tar",
        sha256: "5adac308a5534b6a76446d8311fc340747cbb7edeaacfe6b651493ff3fe31e83", role: "primary" },
      { ...GCC_INPUT, role: "source" }, ...LINUX_SYSROOT_INPUTS,
      { id: "fpc-source", fileName: "fpc-3.2.2.source.tar.gz",
        url: "https://downloads.freepascal.org/fpc/dist/3.2.2/source/fpc-3.2.2.source.tar.gz",
        sha256: "d542e349de246843d4f164829953d1f5b864126c5b62fd17c9b45b33e23d2f44", role: "source" },
    ],
    packagingDescription: "Extracts official FPC compiler and units without running install.sh, includes pinned xPack binutils and an Ubuntu 22.04 sysroot, retains FPC source licenses and compiler source provenance.",
  },
  "temurin21-linux-x64": {
    packageId: "temurin21-linux-x64", platform: "linux", arch: "x64", recipe: { kind: "archive-root", rootPath: "jdk-21.0.12+8" },
    inputs: [{ id: "temurin", fileName: "OpenJDK21U-jdk_x64_linux_hotspot_21.0.12_8.tar.gz",
      url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12_8.tar.gz",
      sha256: "e4446ff06a276155697597cc0f1b15da004ff083f4964a35271ecee567177370", role: "primary" }],
    packagingDescription: "Normalizes the complete Temurin JDK 21.0.12+8 used for QA parity; a later security patch requires a new pinned source and full certification before public release.",
  },
  "scratch-linux-x64": {
    packageId: "scratch-linux-x64", platform: "linux", arch: "x64", recipe: { kind: "archive-root", rootPath: "." },
    inputs: [
      { id: "scratch", fileName: "scratch-run_0.1.7_linux_amd64.zip",
        url: "https://github.com/VNOI-Admin/scratch-run/releases/download/0.1.7/scratch-run_0.1.7_linux_amd64.zip",
        sha256: "e4eac2d97021c2ca8cdfb8b3001306c830614a6b6966c30cc901442441896185", role: "primary" },
      { id: "scratch-license", fileName: "LICENSE",
        url: "https://raw.githubusercontent.com/VNOI-Admin/scratch-run/0.1.7/LICENSE",
        sha256: "8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef", role: "license", destinationRelativePath: "LICENSE" },
    ],
    packagingDescription: "Packages the pristine official Scratch runtime without patchelf or strip; retains AGPL license and upstream source reference.",
  },
};
