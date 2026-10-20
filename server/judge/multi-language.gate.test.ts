import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCompileConfig } from "../../shared/compile-config.js";
import type {
  NormalizedProblemConfig,
  SubmissionLanguage,
} from "../types.js";
import type { ToolchainKind } from "../toolchains/types.js";

interface LanguageGate {
  language: SubmissionLanguage;
  toolchainKind: ToolchainKind;
  extension: string;
  source: string;
}

const languageGates: Readonly<Record<string, LanguageGate>> = {
  pascal: {
    language: "pascal",
    toolchainKind: "pascal",
    extension: ".pas",
    source: [
      "program Main;",
      "var a, b: Int64;",
      "begin",
      "  read(a, b);",
      "  writeln(a + b);",
      "end.",
      "",
    ].join("\n"),
  },
  go: {
    language: "go",
    toolchainKind: "go",
    extension: ".go",
    source: [
      "package main",
      'import "fmt"',
      "func main() {",
      "  var a, b int64",
      "  if _, err := fmt.Scan(&a, &b); err != nil { return }",
      "  fmt.Println(a + b)",
      "}",
      "",
    ].join("\n"),
  },
  java: {
    language: "java",
    toolchainKind: "java",
    extension: ".java",
    source: [
      "import java.io.BufferedInputStream;",
      "public class Main {",
      "  private static long readLong() throws Exception {",
      "    BufferedInputStream in = Holder.IN;",
      "    int c;",
      "    do { c = in.read(); } while (c <= 32 && c >= 0);",
      "    long value = 0;",
      "    while (c > 32) { value = value * 10 + c - '0'; c = in.read(); }",
      "    return value;",
      "  }",
      "  private static class Holder {",
      "    private static final BufferedInputStream IN = new BufferedInputStream(System.in);",
      "  }",
      "  public static void main(String[] args) throws Exception {",
      "    System.out.println(readLong() + readLong());",
      "  }",
      "}",
      "",
    ].join("\n"),
  },
  rust: {
    language: "rust",
    toolchainKind: "rust",
    extension: ".rs",
    source: [
      "use std::io::{self, Read};",
      "fn main() {",
      "    let mut input = String::new();",
      "    io::stdin().read_to_string(&mut input).unwrap();",
      "    let mut values = input.split_whitespace().map(|v| v.parse::<i64>().unwrap());",
      "    println!(\"{}\", values.next().unwrap() + values.next().unwrap());",
      "}",
      "",
    ].join("\n"),
  },
  python: {
    language: "python",
    toolchainKind: "python",
    extension: ".py",
    source: [
      "import sys",
      "values = [int(value) for value in sys.stdin.read().split()]",
      "print(values[0] + values[1])",
      "",
    ].join("\n"),
  },
  javascript: {
    language: "javascript",
    toolchainKind: "javascript",
    extension: ".js",
    source: [
      'const fs = require("node:fs");',
      'const values = fs.readFileSync(0, "utf8").trim().split(/\\s+/).map(BigInt);',
      'process.stdout.write(`${values[0] + values[1]}\\n`);',
      "",
    ].join("\n"),
  },
  csharp: {
    language: "csharp",
    toolchainKind: "csharp",
    extension: ".cs",
    source: [
      "using System;",
      "public static class Program {",
      "  public static void Main() {",
      "    string[] values = Console.In.ReadToEnd().Split(",
      "      (char[]?)null, StringSplitOptions.RemoveEmptyEntries);",
      "    Console.WriteLine(long.Parse(values[0]) + long.Parse(values[1]));",
      "  }",
      "}",
      "",
    ].join("\n"),
  },
  scratch: {
    language: "scratch",
    toolchainKind: "scratch",
    extension: ".json",
    source: JSON.stringify({
      meta: {
        semver: "3.0.0",
        vm: "0.2.0",
        agent: "JudgeDesk Gate Test",
      },
      targets: [
        {
          isStage: true,
          name: "Stage",
          variables: {
            v_a: ["A", 0],
            v_b: ["B", 0],
          },
          lists: {},
          broadcasts: {},
          blocks: {},
          comments: {},
          currentCostume: 0,
          costumes: [
            {
              name: "backdrop1",
              dataFormat: "svg",
              assetId: "cd21514d0531fd5252b7ea9412c702fe",
              md5ext: "cd21514d0531fd5252b7ea9412c702fe.svg",
            },
          ],
          sounds: [],
        },
        {
          isStage: false,
          name: "Sprite1",
          variables: {},
          lists: {},
          broadcasts: {},
          blocks: {
            flag: {
              opcode: "event_whenflagclicked",
              next: "ask1",
              parent: null,
              inputs: {},
              fields: {},
              shadow: false,
              topLevel: true,
            },
            ask1: {
              opcode: "sensing_askandwait",
              next: "set1",
              parent: "flag",
              inputs: { QUESTION: [1, [10, "A?"]] },
              fields: {},
              shadow: false,
              topLevel: false,
            },
            set1: {
              opcode: "data_setvariableto",
              next: "ask2",
              parent: "ask1",
              inputs: { VALUE: [3, "ans1", [10, "0"]] },
              fields: { VARIABLE: ["A", "v_a"] },
              shadow: false,
              topLevel: false,
            },
            ans1: {
              opcode: "sensing_answer",
              next: null,
              parent: "set1",
              inputs: {},
              fields: {},
              shadow: false,
              topLevel: false,
            },
            ask2: {
              opcode: "sensing_askandwait",
              next: "set2",
              parent: "set1",
              inputs: { QUESTION: [1, [10, "B?"]] },
              fields: {},
              shadow: false,
              topLevel: false,
            },
            set2: {
              opcode: "data_setvariableto",
              next: "say",
              parent: "ask2",
              inputs: { VALUE: [3, "ans2", [10, "0"]] },
              fields: { VARIABLE: ["B", "v_b"] },
              shadow: false,
              topLevel: false,
            },
            ans2: {
              opcode: "sensing_answer",
              next: null,
              parent: "set2",
              inputs: {},
              fields: {},
              shadow: false,
              topLevel: false,
            },
            say: {
              opcode: "looks_say",
              next: null,
              parent: "set2",
              inputs: { MESSAGE: [3, "add", [10, "0"]] },
              fields: {},
              shadow: false,
              topLevel: false,
            },
            add: {
              opcode: "operator_add",
              next: null,
              parent: "say",
              inputs: {
                NUM1: [3, [12, "A", "v_a"], [10, "0"]],
                NUM2: [3, [12, "B", "v_b"], [10, "0"]],
              },
              fields: {},
              shadow: false,
              topLevel: false,
            },
          },
          comments: {},
          currentCostume: 0,
          costumes: [
            {
              name: "costume1",
              dataFormat: "svg",
              assetId: "b7853f557e4426412e64bb3da6531a99",
              md5ext: "b7853f557e4426412e64bb3da6531a99.svg",
            },
          ],
          sounds: [],
        },
      ],
    }),
  },
};

function managedRuntimeSecurityGate(
  name: string,
  sentinelPath: string,
  loopbackPort: number,
): LanguageGate | null {
  const sentinelLiteral = JSON.stringify(sentinelPath);
  if (name === "pascal") {
    const pascalSentinel = `'${sentinelPath.replaceAll("'", "''")}'`;
    return {
      language: "pascal",
      toolchainKind: "pascal",
      extension: ".pas",
      source: [
        "program Main;",
        "uses Sockets, SysUtils;",
        `const Sentinel = ${pascalSentinel};`,
        `const LoopbackPort = ${loopbackPort};`,
        "var inputFile, outputFile: Text;",
        "var fileReadBlocked, fileWriteBlocked, networkBlocked: Boolean;",
        "var socketHandle: LongInt;",
        "var address: TInetSockAddr;",
        "begin",
        "  {$I-}",
        "  Assign(inputFile, Sentinel);",
        "  Reset(inputFile);",
        "  fileReadBlocked := IOResult <> 0;",
        "  if not fileReadBlocked then Close(inputFile);",
        "  Assign(outputFile, Sentinel);",
        "  Rewrite(outputFile);",
        "  fileWriteBlocked := IOResult <> 0;",
        "  if not fileWriteBlocked then begin",
        "    Writeln(outputFile, 'SECURITY_ESCAPE');",
        "    Close(outputFile);",
        "  end;",
        "  {$I+}",
        "  FillChar(address, SizeOf(address), 0);",
        "  address.sin_family := AF_INET;",
        "  address.sin_port := htons(LoopbackPort);",
        "  address.sin_addr := StrToNetAddr('127.0.0.1');",
        "  socketHandle := fpSocket(AF_INET, SOCK_STREAM, 0);",
        "  if socketHandle < 0 then networkBlocked := True",
        "  else begin",
        "    networkBlocked := fpConnect(socketHandle, @address, SizeOf(address)) <> 0;",
        "    CloseSocket(socketHandle);",
        "  end;",
        "  if fileReadBlocked and fileWriteBlocked and networkBlocked then Writeln('SAFE')",
        "  else Writeln('UNSAFE fileRead=', fileReadBlocked,",
        "    ' fileWrite=', fileWriteBlocked, ' network=', networkBlocked);",
        "end.",
        "",
      ].join("\n"),
    };
  }
  if (name === "javascript") {
    return {
      language: "javascript",
      toolchainKind: "javascript",
      extension: ".js",
      source: [
        'const fs = require("node:fs");',
        'const net = require("node:net");',
        `const sentinel = ${sentinelLiteral};`,
        "let fileBlocked = false;",
        "try { fs.readFileSync(sentinel); } catch (error) {",
        '  fileBlocked = error && (error.code === "EACCES" || error.code === "EPERM");',
        "}",
        "let finished = false;",
        "function finish(networkBlocked, detail) {",
        "  if (finished) return;",
        "  finished = true;",
        '  process.stdout.write(fileBlocked && networkBlocked ? "SAFE\\n" : `UNSAFE file=${fileBlocked} network=${networkBlocked} detail=${detail}\\n`);',
        "}",
        "try {",
        `  const socket = net.createConnection({ host: "127.0.0.1", port: ${loopbackPort} });`,
        '  socket.once("connect", () => { socket.destroy(); finish(false, "connected"); });',
        '  socket.once("error", (error) => finish(true, error && error.code));',
        '  setTimeout(() => { socket.destroy(); finish(false, "timeout"); }, 1000);',
        "} catch (error) {",
        '  finish(true, error && error.code);',
        "}",
        "",
      ].join("\n"),
    };
  }
  if (name === "csharp") {
    return {
      language: "csharp",
      toolchainKind: "csharp",
      extension: ".cs",
      source: [
        "using System;",
        "using System.IO;",
        "using System.Net.Sockets;",
        "using System.Threading;",
        "using System.Threading.Tasks;",
        "public static class Program {",
        "  public static async Task Main() {",
        "    bool fileBlocked = false;",
        `    try { File.ReadAllText(${sentinelLiteral}); }`,
        "    catch (UnauthorizedAccessException) { fileBlocked = true; }",
        "    bool networkBlocked = false;",
        '    string networkDetail = "connected";',
        "    using CancellationTokenSource cancellation = new(500);",
        `    try { using TcpClient client = new(); await client.ConnectAsync("127.0.0.1", ${loopbackPort}, cancellation.Token); }`,
        "    catch (SocketException error) {",
        "      networkBlocked = true;",
        "      networkDetail = error.SocketErrorCode.ToString();",
        "    }",
        "    catch (OperationCanceledException) {",
        "      networkBlocked = true;",
        '      networkDetail = "timeout";',
        "    }",
        '    Console.WriteLine(fileBlocked && networkBlocked ? "SAFE" : $"UNSAFE file={fileBlocked} network={networkBlocked} detail={networkDetail}");',
        "  }",
        "}",
        "",
      ].join("\n"),
    };
  }
  if (name === "java") {
    return {
      language: "java",
      toolchainKind: "java",
      extension: ".java",
      source: [
        "import java.io.IOException;",
        "import java.net.InetSocketAddress;",
        "import java.net.Socket;",
        "import java.nio.file.Files;",
        "import java.nio.file.Path;",
        "public class Main {",
        "  public static void main(String[] args) {",
        "    boolean fileBlocked = false;",
        `    try { Files.readString(Path.of(${sentinelLiteral})); }`,
        "    catch (IOException | SecurityException error) { fileBlocked = true; }",
        "    boolean networkBlocked = false;",
        '    String networkDetail = "connected";',
        "    try (Socket socket = new Socket()) {",
        `      socket.connect(new InetSocketAddress("127.0.0.1", ${loopbackPort}), 500);`,
        "    }",
        "    catch (IOException | SecurityException error) {",
        "      networkBlocked = true;",
        "      networkDetail = error.getClass().getSimpleName();",
        "    }",
        '    System.out.println(fileBlocked && networkBlocked ? "SAFE" :',
        '      "UNSAFE file=" + fileBlocked + " network=" + networkBlocked + " detail=" + networkDetail);',
        "  }",
        "}",
        "",
      ].join("\n"),
    };
  }
  if (name === "python") {
    return {
      language: "python",
      toolchainKind: "python",
      extension: ".py",
      source: [
        "import socket",
        `sentinel = ${sentinelLiteral}`,
        "file_blocked = False",
        "try:",
        "    with open(sentinel, encoding='utf-8') as private_file:",
        "        private_file.read()",
        "except (OSError, PermissionError):",
        "    file_blocked = True",
        "network_blocked = False",
        "network_detail = 'connected'",
        "probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
        "probe.settimeout(0.5)",
        "try:",
        `    probe.connect(('127.0.0.1', ${loopbackPort}))`,
        "except OSError as error:",
        "    network_blocked = True",
        "    network_detail = type(error).__name__",
        "finally:",
        "    probe.close()",
        "print('SAFE' if file_blocked and network_blocked else",
        "      f'UNSAFE file={file_blocked} network={network_blocked} detail={network_detail}')",
        "",
      ].join("\n"),
    };
  }
  return null;
}

test("managed runtime security matrix includes every production interpreted runtime", () => {
  for (const name of ["pascal", "java", "python"] as const) {
    assert.ok(
      managedRuntimeSecurityGate(name, path.join(os.homedir(), "private.txt"), 1),
      `${name} has no private-file/network boundary fixture`,
    );
  }
});

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

const requestedGateNames = (
  process.env.JUDGEDESK_REAL_LANGUAGE_GATES
  || "pascal,java,python"
)
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
function provisionMacosTreeGuard(): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.JUDGEDESK_TREE_GUARD_REQUIRED === "1") return null;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-language-gate-tree-guard-"),
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

const config: NormalizedProblemConfig = {
  useStdIO: true,
  useStdIn: true,
  useStdOut: true,
  inputFile: "SUM.inp",
  outputFile: "SUM.out",
  totalScore: 1,
  defaultScore: 1,
  testScores: {},
  memoryLimit: 512,
  checkerType: "C1",
  compile: createCompileConfig(),
  polygonConfig: {
    enableGroups: false,
    tests: {},
    groups: {},
  },
};

test(
  "managed language packages compile and execute inside the secure runner",
  {
    skip: enabled
      ? false
      : "set JUDGEDESK_REAL_TOOLCHAIN_GATES=1 and JUDGEDESK_REAL_TOOLCHAIN_GATE_ROOT",
  },
  async (t) => {
    for (const name of requestedGateNames) {
      assert.ok(languageGates[name], `Unknown language gate '${name}'.`);
    }
    const [
      { executorClient },
      { compileSubmission },
      { runTestCase },
      { resolveManagedToolchain },
    ] = await Promise.all([
      import("../executor/client.js"),
      import("./compiler.js"),
      import("./testcase-runner.js"),
      import("../toolchains/resolver.js"),
    ]);
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "judgedesk-language-gate-"),
    );
    t.after(async () => {
      await executorClient.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
      if (macosTreeGuard) {
        fs.rmSync(macosTreeGuard, { recursive: true, force: true });
      }
    });
    const input = path.join(root, "input.txt");
    const expected = path.join(root, "expected.txt");
    fs.writeFileSync(input, "19\n23\n", "utf8");
    fs.writeFileSync(expected, "42\n", "utf8");

    for (const name of requestedGateNames) {
      const gate = languageGates[name];
      await t.test(name, async () => {
        const source = path.join(root, `SUM${gate.extension}`);
        fs.writeFileSync(source, gate.source, "utf8");
        const toolchain = resolveManagedToolchain(gate.toolchainKind);
        assert.equal(
          toolchain.ready,
          true,
          `${name}: ${toolchain.diagnostic || "managed toolchain is not ready"}`,
        );
        assert.equal(toolchain.packageOrigin, expectedPackageOrigin);
        assert.ok(toolchain.packageDigest);
        assert.ok(toolchain.packageComponentId);
        const compiled = await compileSubmission({
          language: gate.language,
          contestantName: "student",
          problemName: "SUM",
          submissionPath: source,
          tempDirectory: root,
          toolchains: {
            [gate.toolchainKind]: toolchain,
          },
        });
        assert.equal(
          compiled.compileStatus,
          "OK",
          `${name}: ${compiled.compileError}`,
        );
        assert.ok(compiled.program, `${name}: prepared program is missing`);
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
          timeLimitMs: 5_000,
          score: 1,
          config,
          checker: undefined,
          program: compiled.program,
        });
        assert.equal(result.status, "AC", `${name}: ${result.errorDetail}`);
        assert.equal(result.score, 1);
      });
    }

    // The OS temp directory is intentionally usable by regular AppContainers on
    // Windows. Put the sentinel directly under the user's private home ACL so
    // this gate measures a real host-file boundary.
    const privateDirectory = fs.mkdtempSync(
      path.join(os.homedir(), ".judgedesk-runtime-boundary-"),
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
    assert.ok(
      loopbackAddress && typeof loopbackAddress !== "string",
      "loopback probe did not bind an IP socket",
    );
    const loopbackPort = loopbackAddress.port;
    for (const name of requestedGateNames) {
      const gate = managedRuntimeSecurityGate(name, sentinel, loopbackPort);
      if (!gate) continue;
      await t.test(`${name} private-file and network boundary`, async () => {
        const connectionsBeforeRun = acceptedLoopbackConnections;
        const source = path.join(root, `BOUNDARY${gate.extension}`);
        fs.writeFileSync(source, gate.source, "utf8");
        const toolchain = resolveManagedToolchain(gate.toolchainKind);
        assert.equal(toolchain.ready, true, toolchain.diagnostic);
        const compiled = await compileSubmission({
          language: gate.language,
          contestantName: `security_${name}`,
          problemName: "BOUNDARY",
          submissionPath: source,
          tempDirectory: root,
          toolchains: {
            [gate.toolchainKind]: toolchain,
          },
        });
        assert.equal(compiled.compileStatus, "OK", compiled.compileError);
        assert.ok(compiled.program);
        const result = await runTestCase({
          contestant: `security_${name}`,
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
          `${name} reached a host loopback listener from the sandbox`,
        );
        assert.equal(fs.readFileSync(sentinel, "utf8"), "PRIVATE");
      });
    }
  },
);
