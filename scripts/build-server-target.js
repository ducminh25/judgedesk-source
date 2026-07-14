const TARGETS = {
  "win32:x64": "x86_64-pc-windows-msvc",
  "darwin:x64": "x86_64-apple-darwin",
  "darwin:arm64": "aarch64-apple-darwin",
  "linux:x64": "x86_64-unknown-linux-gnu",
  "linux:arm64": "aarch64-unknown-linux-gnu"
};

export function targetTripleForHost(platform, architecture) {
  const target = TARGETS[`${platform}:${architecture}`];
  if (!target) throw new Error(`Unsupported sidecar build host: ${platform}/${architecture}`);
  return target;
}
