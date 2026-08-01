import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import type { ResolvedToolchain } from "../toolchains/types.js";

const gateRoot = process.env.JUDGEDESK_REAL_TOOLCHAIN_GATE_ROOT;
const enabled =
  (process.platform === "win32" || process.platform === "darwin")
  && process.env.JUDGEDESK_REAL_TOOLCHAIN_GATES === "1"
  && !!gateRoot;
if (enabled) {
  process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR = path.resolve(gateRoot!);
}

function provisionMacosTreeGuard(): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.JUDGEDESK_TREE_GUARD_REQUIRED === "1") return null;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-checker-gate-tree-guard-"),
  );
  const generation = crypto.randomBytes(32).toString("hex");
  const guardPath = path.join(directory, "process-tree.generation");
  fs.writeFileSync(
    guardPath,
    `JUDGEDESK_PROCESS_TREE/1\ngeneration=${generation}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.env.JUDGEDESK_TREE_GUARD_REQUIRED = "1";
  process.env.JUDGEDESK_TREE_GUARD_PATH = guardPath;
  process.env.JUDGEDESK_TREE_GUARD_GENERATION = generation;
  return directory;
}

function macosCppToolchain(): ResolvedToolchain {
  const executablePath = execFileSync(
    "/usr/bin/xcrun",
    ["--find", "clang++"],
    { encoding: "utf8" },
  ).trim();
  return {
    kind: "cpp",
    source: "system",
    executablePath,
    version: "17.0.0",
    ready: true,
    provenance: "platform-certified",
  };
}

function listenLoopback(
  server: net.Server,
): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolve({ host: "127.0.0.1", port: address.port });
    });
  });
}

test(
  "managed C++ and Python custom checkers compile, execute, and retain host boundaries",
  {
    skip: enabled
      ? false
      : "set JUDGEDESK_REAL_TOOLCHAIN_GATES=1 and JUDGEDESK_REAL_TOOLCHAIN_GATE_ROOT",
  },
  async (t) => {
    const macosTreeGuard = provisionMacosTreeGuard();
    const [
      { executorClient },
      { resolveChecker },
      { runCustomChecker },
      { resolveManagedToolchain },
    ] = await Promise.all([
      import("../executor/client.js"),
      import("./compiler.js"),
      import("./custom-checker-runner.js"),
      import("../toolchains/resolver.js"),
    ]);
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "judgedesk-custom-checker-gate-"),
    );
    const privateDirectory = fs.mkdtempSync(
      path.join(os.homedir(), ".judgedesk-checker-boundary-"),
    );
    const sentinel = path.join(privateDirectory, "private.txt");
    fs.writeFileSync(sentinel, "PRIVATE", "utf8");
    const loopback = net.createServer((socket) => socket.destroy());
    let acceptedLoopbackConnections = 0;
    loopback.on("connection", () => {
      acceptedLoopbackConnections += 1;
    });
    const endpoint = await listenLoopback(loopback);
    t.after(async () => {
      await executorClient.shutdown();
      await new Promise<void>((resolve) => loopback.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(privateDirectory, { recursive: true, force: true });
      if (macosTreeGuard) {
        fs.rmSync(macosTreeGuard, { recursive: true, force: true });
      }
    });

    const inputPath = path.join(root, "input.txt");
    const actualOutputPath = path.join(root, "actual.txt");
    const expectedOutputPath = path.join(root, "expected.txt");
    fs.writeFileSync(inputPath, "ignored\n", "utf8");
    fs.writeFileSync(actualOutputPath, "42\n", "utf8");
    fs.writeFileSync(expectedOutputPath, "42\n", "utf8");

    const cppToolchain = process.platform === "win32"
      ? resolveManagedToolchain("cpp")
      : macosCppToolchain();
    assert.equal(
      cppToolchain.ready,
      true,
      cppToolchain.diagnostic || "C++ checker compiler is not ready",
    );
    const pythonToolchain = resolveManagedToolchain("python");
    assert.equal(
      pythonToolchain.ready,
      true,
      pythonToolchain.diagnostic || "Python checker runtime is not ready",
    );

    fs.copyFileSync(
      path.join(
        process.cwd(),
        "server",
        "security-fixtures",
        "cpp",
        "checker_smoke.cpp",
      ),
      path.join(root, "checker.cpp"),
    );
    const cppChecker = await resolveChecker({
      checkerType: "checker.cpp",
      problemName: "SUM",
      problemDirectory: root,
      tempDirectory: root,
      cppToolchain,
    });
    assert.equal(cppChecker.error, undefined, cppChecker.error);
    assert.equal(cppChecker.runtime, "native");
    assert.ok(cppChecker.path);
    const cppResult = await runCustomChecker({
      checkerPath: cppChecker.path,
      checkerRuntime: "native",
      inputPath,
      actualOutputPath,
      expectedOutputPath,
      maxScore: 10,
    });
    assert.equal(cppResult.status, "AC", JSON.stringify(cppResult));
    assert.equal(cppResult.score, 10);

    fs.writeFileSync(
      path.join(root, "boundary.cpp"),
      [
        "#include <fstream>",
        "#ifdef _WIN32",
        "#define WIN32_LEAN_AND_MEAN",
        "#include <winsock2.h>",
        "#include <windows.h>",
        "#else",
        "#include <arpa/inet.h>",
        "#include <sys/socket.h>",
        "#include <unistd.h>",
        "#endif",
        "static bool network_blocked() {",
        "#ifdef _WIN32",
        '  HMODULE library = LoadLibraryA("ws2_32.dll");',
        "  if (!library) return true;",
        "  using Startup = int (WSAAPI *)(WORD, LPWSADATA);",
        "  using OpenSocket = SOCKET (WSAAPI *)(int, int, int);",
        "  using Connect = int (WSAAPI *)(SOCKET, const sockaddr *, int);",
        "  using CloseSocket = int (WSAAPI *)(SOCKET);",
        "  using Cleanup = int (WSAAPI *)();",
        '  auto startup = reinterpret_cast<Startup>(GetProcAddress(library, "WSAStartup"));',
        '  auto open_socket = reinterpret_cast<OpenSocket>(GetProcAddress(library, "socket"));',
        '  auto connect_socket = reinterpret_cast<Connect>(GetProcAddress(library, "connect"));',
        '  auto close_socket = reinterpret_cast<CloseSocket>(GetProcAddress(library, "closesocket"));',
        '  auto cleanup = reinterpret_cast<Cleanup>(GetProcAddress(library, "WSACleanup"));',
        "  bool blocked = true;",
        "  WSADATA data{};",
        "  if (startup && open_socket && connect_socket && close_socket && cleanup",
        "      && startup(MAKEWORD(2, 2), &data) == 0) {",
        "    SOCKET probe = open_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);",
        "    if (probe != INVALID_SOCKET) {",
        "      sockaddr_in address{};",
        "      address.sin_family = AF_INET;",
        `      address.sin_port = ${((endpoint.port & 0xff) << 8) | ((endpoint.port >> 8) & 0xff)};`,
        "      address.sin_addr.S_un.S_addr = 0x0100007f;",
        "      blocked = connect_socket(probe, reinterpret_cast<const sockaddr *>(&address), sizeof(address)) != 0;",
        "      close_socket(probe);",
        "    }",
        "    cleanup();",
        "  }",
        "  FreeLibrary(library);",
        "  return blocked;",
        "#else",
        "  int probe = socket(AF_INET, SOCK_STREAM, 0);",
        "  if (probe < 0) return true;",
        "  sockaddr_in address{};",
        "  address.sin_family = AF_INET;",
        `  address.sin_port = htons(${endpoint.port});`,
        '  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);',
        "  bool blocked = connect(probe, reinterpret_cast<const sockaddr *>(&address), sizeof(address)) != 0;",
        "  close(probe);",
        "  return blocked;",
        "#endif",
        "}",
        "int main() {",
        `  std::ifstream private_file(${JSON.stringify(sentinel)});`,
        "  const bool file_blocked = !private_file.good();",
        "  return file_blocked && network_blocked() ? 0 : 1;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const cppBoundary = await resolveChecker({
      checkerType: "boundary.cpp",
      problemName: "BOUNDARY",
      problemDirectory: root,
      tempDirectory: root,
      cppToolchain,
    });
    assert.equal(cppBoundary.error, undefined, cppBoundary.error);
    assert.ok(cppBoundary.path);
    const connectionsBeforeCppBoundary = acceptedLoopbackConnections;
    const cppBoundaryResult = await runCustomChecker({
      checkerPath: cppBoundary.path,
      checkerRuntime: "native",
      inputPath,
      actualOutputPath,
      expectedOutputPath,
      maxScore: 10,
    });
    assert.equal(
      cppBoundaryResult.status,
      "AC",
      JSON.stringify(cppBoundaryResult),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      acceptedLoopbackConnections,
      connectionsBeforeCppBoundary,
      "native C++ checker reached the host loopback listener",
    );

    fs.writeFileSync(
      path.join(root, "checker.py"),
      [
        "from pathlib import Path",
        "import socket",
        "import sys",
        "actual = Path(sys.argv[2]).read_text(encoding='utf-8')",
        "expected = Path(sys.argv[3]).read_text(encoding='utf-8')",
        "raise SystemExit(0 if actual == expected else 1)",
        "",
      ].join("\n"),
      "utf8",
    );
    const pythonChecker = await resolveChecker({
      checkerType: "checker.py",
      problemName: "SUM",
      problemDirectory: root,
      tempDirectory: root,
      pythonToolchain,
    });
    assert.equal(pythonChecker.error, undefined, pythonChecker.error);
    assert.equal(pythonChecker.runtime, "python");
    assert.ok(pythonChecker.path);
    assert.ok(pythonChecker.pythonExecutablePath);
    assert.equal(pythonChecker.pythonToolchain, pythonToolchain);
    const pythonResult = await runCustomChecker({
      checkerPath: pythonChecker.path,
      checkerRuntime: "python",
      pythonExecutablePath: pythonChecker.pythonExecutablePath,
      pythonToolchain: pythonChecker.pythonToolchain,
      inputPath,
      actualOutputPath,
      expectedOutputPath,
      maxScore: 10,
    });
    assert.equal(pythonResult.status, "AC", JSON.stringify(pythonResult));
    assert.equal(pythonResult.score, 10);

    fs.writeFileSync(
      path.join(root, "boundary.py"),
      [
        "from pathlib import Path",
        "import socket",
        "import sys",
        "try:",
        `    Path(${JSON.stringify(sentinel)}).read_text(encoding='utf-8')`,
        "    file_blocked = False",
        "except OSError:",
        "    file_blocked = True",
        "probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
        "probe.settimeout(0.5)",
        "try:",
        `    probe.connect((${JSON.stringify(endpoint.host)}, ${endpoint.port}))`,
        "    network_blocked = False",
        "except OSError:",
        "    network_blocked = True",
        "finally:",
        "    probe.close()",
        "print(f'file={file_blocked} network={network_blocked}')",
        "raise SystemExit(0 if file_blocked and network_blocked else 1)",
        "",
      ].join("\n"),
      "utf8",
    );
    const pythonBoundary = await resolveChecker({
      checkerType: "boundary.py",
      problemName: "BOUNDARY",
      problemDirectory: root,
      tempDirectory: root,
      pythonToolchain,
    });
    assert.equal(pythonBoundary.error, undefined, pythonBoundary.error);
    assert.ok(pythonBoundary.path);
    assert.ok(pythonBoundary.pythonExecutablePath);
    assert.equal(pythonBoundary.pythonToolchain, pythonToolchain);
    const connectionsBeforeRun = acceptedLoopbackConnections;
    const pythonBoundaryResult = await runCustomChecker({
      checkerPath: pythonBoundary.path,
      checkerRuntime: "python",
      pythonExecutablePath: pythonBoundary.pythonExecutablePath,
      pythonToolchain: pythonBoundary.pythonToolchain,
      inputPath,
      actualOutputPath,
      expectedOutputPath,
      maxScore: 10,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      pythonBoundaryResult.status,
      "AC",
      JSON.stringify(pythonBoundaryResult),
    );
    assert.equal(acceptedLoopbackConnections, connectionsBeforeRun);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "PRIVATE");
  },
);
