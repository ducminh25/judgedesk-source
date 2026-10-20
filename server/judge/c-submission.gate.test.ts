import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createCompileConfig } from "../../shared/compile-config.js";
import type { NormalizedProblemConfig } from "../types.js";
import type { ResolvedToolchain } from "../toolchains/types.js";

const toolchainGateRoot = process.env.JUDGEDESK_REAL_TOOLCHAIN_GATE_ROOT;
const expectedPackageOrigin =
  process.env.JUDGEDESK_REAL_TOOLCHAIN_GATE_ORIGIN || "built-in";
if (
  expectedPackageOrigin !== "built-in"
  && expectedPackageOrigin !== "downloaded"
) {
  throw new Error(
    "JUDGEDESK_REAL_TOOLCHAIN_GATE_ORIGIN must be 'built-in' or 'downloaded'.",
  );
}
const enabled =
  (process.platform === "win32" || process.platform === "darwin")
  && process.env.JUDGEDESK_REAL_TOOLCHAIN_GATES === "1"
  && !!toolchainGateRoot;
if (enabled) {
  const resolvedGateRoot = path.resolve(toolchainGateRoot!);
  if (expectedPackageOrigin === "built-in") {
    process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR = resolvedGateRoot;
  } else {
    assert.equal(
      path.basename(resolvedGateRoot).toLowerCase(),
      "toolchains",
      "downloaded gate root must be the exact ThemisV2/toolchains directory",
    );
    process.env.THEMIS_APP_DATA_DIR = path.dirname(resolvedGateRoot);
  }
}

function nativeBoundarySource(sentinel: string, loopbackPort: number): string {
  const networkPort = ((loopbackPort & 0xff) << 8) | ((loopbackPort >> 8) & 0xff);
  return [
    "#include <stdio.h>",
    "#ifdef _WIN32",
    "#define WIN32_LEAN_AND_MEAN",
    "#include <winsock2.h>",
    "#include <windows.h>",
    "#else",
    "#include <arpa/inet.h>",
    "#include <sys/socket.h>",
    "#include <unistd.h>",
    "#endif",
    "static int network_blocked(void) {",
    "#ifdef _WIN32",
    '  HMODULE library = LoadLibraryA("ws2_32.dll");',
    "  if (library == NULL) return 1;",
    "  typedef int (WSAAPI *startup_fn)(WORD, LPWSADATA);",
    "  typedef SOCKET (WSAAPI *socket_fn)(int, int, int);",
    "  typedef int (WSAAPI *connect_fn)(SOCKET, const struct sockaddr *, int);",
    "  typedef int (WSAAPI *close_fn)(SOCKET);",
    "  typedef int (WSAAPI *cleanup_fn)(void);",
    '  startup_fn startup = (startup_fn)GetProcAddress(library, "WSAStartup");',
    '  socket_fn open_socket = (socket_fn)GetProcAddress(library, "socket");',
    '  connect_fn connect_socket = (connect_fn)GetProcAddress(library, "connect");',
    '  close_fn close_socket = (close_fn)GetProcAddress(library, "closesocket");',
    '  cleanup_fn cleanup = (cleanup_fn)GetProcAddress(library, "WSACleanup");',
    "  int blocked = 1;",
    "  WSADATA data;",
    "  if (startup != NULL && open_socket != NULL && connect_socket != NULL",
    "      && close_socket != NULL && cleanup != NULL",
    "      && startup(MAKEWORD(2, 2), &data) == 0) {",
    "    SOCKET probe = open_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);",
    "    if (probe != INVALID_SOCKET) {",
    "      struct sockaddr_in address = {0};",
    "      address.sin_family = AF_INET;",
    `      address.sin_port = ${networkPort};`,
    "      address.sin_addr.S_un.S_addr = 0x0100007f;",
    "      blocked = connect_socket(probe, (const struct sockaddr *)&address, sizeof(address)) != 0;",
    "      close_socket(probe);",
    "    }",
    "    cleanup();",
    "  }",
    "  FreeLibrary(library);",
    "  return blocked;",
    "#else",
    "  int probe = socket(AF_INET, SOCK_STREAM, 0);",
    "  if (probe < 0) return 1;",
    "  struct sockaddr_in address = {0};",
    "  address.sin_family = AF_INET;",
    `  address.sin_port = htons(${loopbackPort});`,
    '  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);',
    "  int blocked = connect(probe, (const struct sockaddr *)&address, sizeof(address)) != 0;",
    "  close(probe);",
    "  return blocked;",
    "#endif",
    "}",
    "int main(void) {",
    `  FILE *read_probe = fopen(${JSON.stringify(sentinel)}, "rb");`,
    `  FILE *write_probe = fopen(${JSON.stringify(sentinel)}, "wb");`,
    "  int read_blocked = read_probe == NULL;",
    "  int write_blocked = write_probe == NULL;",
    "  if (read_probe != NULL) fclose(read_probe);",
    "  if (write_probe != NULL) fclose(write_probe);",
    '  if (read_blocked && write_blocked && network_blocked()) puts("SAFE");',
    '  else puts("SECURITY_ESCAPE");',
    "  return 0;",
    "}",
    "",
  ].join("\n");
}

function provisionMacosTreeGuard(): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.JUDGEDESK_TREE_GUARD_REQUIRED === "1") return null;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-c-gate-tree-guard-"),
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

const macosTreeGuard = enabled ? provisionMacosTreeGuard() : null;

test(
  "the selected C++14 and C11 compilers build and execute inside the secure runner",
  {
    skip: enabled
      ? false
      : "set JUDGEDESK_REAL_TOOLCHAIN_GATES=1 and JUDGEDESK_REAL_TOOLCHAIN_GATE_ROOT",
  },
  async (t) => {
    const [
      { executorClient },
      { compileSubmission },
      { runTestCase },
      { resolveManagedToolchain, verifyLocalToolchainCandidate },
      { scheduleLocalCompatibilityProbe },
    ] =
      await Promise.all([
        import("../executor/client.js"),
        import("./compiler.js"),
        import("./testcase-runner.js"),
        import("../toolchains/resolver.js"),
        import("../toolchains/local-execution.js"),
      ]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-c-gate-"));
    t.after(async () => {
      await executorClient.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
      if (macosTreeGuard) {
        fs.rmSync(macosTreeGuard, { recursive: true, force: true });
      }
    });
    const input = path.join(root, "input.txt");
    const expected = path.join(root, "expected.txt");
    fs.writeFileSync(input, "19 23\n", "utf8");
    fs.writeFileSync(expected, "42\n", "utf8");
    const config: NormalizedProblemConfig = {
      useStdIO: true,
      useStdIn: true,
      useStdOut: true,
      inputFile: "SUM.inp",
      outputFile: "SUM.out",
      totalScore: 1,
      defaultScore: 1,
      testScores: {},
      memoryLimit: 256,
      checkerType: "C1",
      compile: createCompileConfig(),
      polygonConfig: {
        enableGroups: false,
        tests: {},
        groups: {},
      },
    };
    const cases = [
      {
        language: "cpp",
        extension: ".cpp",
        compilerName: "clang++",
        source: [
          "#include <iostream>",
          "int main() {",
          "  long long a, b;",
          "  if (!(std::cin >> a >> b)) return 1;",
          "  std::cout << a + b << '\\n';",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
      },
      {
        language: "c",
        extension: ".c",
        compilerName: "clang",
        source: [
          "#include <stdio.h>",
          "int main(void) {",
          "  long long a, b;",
          "  if (scanf(\"%lld%lld\", &a, &b) != 2) return 1;",
          "  printf(\"%lld\\n\", a + b);",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
      },
    ] as const;
    for (const gate of cases) {
      await t.test(gate.language, async () => {
        const compiler = process.platform === "win32"
          ? path.join(
              path.resolve(toolchainGateRoot!),
              "gcc-windows-x64",
              "bin",
              gate.language === "cpp" ? "g++.exe" : "gcc.exe",
            )
          : fs.realpathSync(execFileSync(
              "/usr/bin/xcrun",
              ["--find", gate.compilerName],
              { encoding: "utf8" },
            ).trim());
        assert.ok(
          fs.existsSync(compiler),
          `${gate.language} compiler is missing at ${compiler}`,
        );
        const source = path.join(root, `SUM${gate.extension}`);
        fs.writeFileSync(source, gate.source, "utf8");
        let toolchain: ResolvedToolchain;
        if (process.platform === "win32") {
          toolchain = resolveManagedToolchain(gate.language);
        } else {
          await scheduleLocalCompatibilityProbe(gate.language, compiler);
          toolchain = verifyLocalToolchainCandidate(gate.language, compiler);
        }
        assert.equal(
          toolchain.ready,
          true,
          toolchain.diagnostic
            || `managed ${gate.language} compiler is not ready`,
        );
        if (process.platform === "win32") {
          assert.equal(toolchain.packageOrigin, expectedPackageOrigin);
        } else {
          assert.equal(toolchain.provenance, "platform-certified");
        }
        const compiled = await compileSubmission({
          language: gate.language,
          contestantName: "student",
          problemName: "SUM",
          submissionPath: source,
          tempDirectory: root,
          toolchains: { [gate.language]: toolchain },
        });
        assert.equal(compiled.compileStatus, "OK", compiled.compileError);
        const result = await runTestCase({
          contestant: "student",
          problemName: "SUM",
          testName: "1",
          language: gate.language,
          submissionPath: source,
          executablePath: compiled.executablePath,
          inputPath: input,
          expectedOutputPath: expected,
          expectedOutputPreview: "42\n",
          testRoot: root,
          contestantsRoot: root,
          tempDirectory: root,
          pythonCommand: "",
          timeLimitMs: 1_000,
          score: 1,
          config,
          checker: undefined,
          program: compiled.program,
        });
        assert.equal(result.status, "AC", result.errorDetail);
        assert.equal(result.score, 1);
      });
    }

    const privateDirectory = fs.mkdtempSync(
      path.join(os.homedir(), ".judgedesk-native-boundary-"),
    );
    const sentinel = path.join(privateDirectory, "private.txt");
    const securityExpected = path.join(root, "security-expected.txt");
    fs.writeFileSync(sentinel, "PRIVATE", "utf8");
    fs.writeFileSync(securityExpected, "SAFE\n", "utf8");
    t.after(() => fs.rmSync(privateDirectory, { recursive: true, force: true }));
    let acceptedLoopbackConnections = 0;
    const loopbackServer = net.createServer((socket) => {
      acceptedLoopbackConnections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      loopbackServer.once("error", reject);
      loopbackServer.listen(0, "127.0.0.1", () => {
        loopbackServer.off("error", reject);
        resolve();
      });
    });
    t.after(
      () => new Promise<void>((resolve, reject) => {
        loopbackServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    );
    const loopbackAddress = loopbackServer.address();
    assert.ok(loopbackAddress && typeof loopbackAddress !== "string");

    for (const gate of cases) {
      await t.test(`${gate.language} private-file and network boundary`, async () => {
        const connectionsBeforeRun = acceptedLoopbackConnections;
        const source = path.join(root, `BOUNDARY${gate.extension}`);
        fs.writeFileSync(
          source,
          nativeBoundarySource(sentinel, loopbackAddress.port),
          "utf8",
        );
        let toolchain: ResolvedToolchain;
        if (process.platform === "win32") {
          toolchain = resolveManagedToolchain(gate.language);
          assert.equal(toolchain.ready, true, toolchain.diagnostic);
          assert.equal(toolchain.packageOrigin, expectedPackageOrigin);
        } else {
          const compiler = fs.realpathSync(execFileSync(
            "/usr/bin/xcrun",
            ["--find", gate.compilerName],
            { encoding: "utf8" },
          ).trim());
          await scheduleLocalCompatibilityProbe(gate.language, compiler);
          toolchain = verifyLocalToolchainCandidate(gate.language, compiler);
          assert.equal(toolchain.ready, true, toolchain.diagnostic);
          assert.equal(toolchain.provenance, "platform-certified");
        }
        const compiled = await compileSubmission({
          language: gate.language,
          contestantName: `security_${gate.language}`,
          problemName: "BOUNDARY",
          submissionPath: source,
          tempDirectory: root,
          toolchains: { [gate.language]: toolchain },
        });
        assert.equal(compiled.compileStatus, "OK", compiled.compileError);
        assert.ok(compiled.program);
        const result = await runTestCase({
          contestant: `security_${gate.language}`,
          problemName: "BOUNDARY",
          testName: "security",
          language: gate.language,
          submissionPath: source,
          executablePath: compiled.executablePath,
          inputPath: input,
          expectedOutputPath: securityExpected,
          expectedOutputPreview: "SAFE\n",
          testRoot: root,
          contestantsRoot: root,
          tempDirectory: root,
          pythonCommand: "",
          timeLimitMs: 3_000,
          score: 1,
          config,
          checker: undefined,
          program: compiled.program,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(result.status, "AC", JSON.stringify(result));
        assert.equal(
          acceptedLoopbackConnections,
          connectionsBeforeRun,
          `${gate.language} reached a host loopback listener from the sandbox`,
        );
        assert.equal(fs.readFileSync(sentinel, "utf8"), "PRIVATE");
      });
    }
  },
);
