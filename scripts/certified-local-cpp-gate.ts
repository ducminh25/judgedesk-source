import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executorClient } from "../server/executor/client.js";
import {
  compileSubmission,
  resolveChecker,
} from "../server/judge/compiler.js";
import { ensureCertifiedLocalCppSessionProbe } from "../server/judge/certified-local-session-probe.js";
import { verifyLocalToolchainCandidate } from "../server/toolchains/resolver.js";

async function main(): Promise<void> {
  const compilerPath = process.argv[2];
  if (!compilerPath || !path.isAbsolute(compilerPath)) {
    throw new Error("Usage: tsx scripts/certified-local-cpp-gate.ts <absolute-g++-path>");
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-resolver-e2e-"));
  try {
    const health = await executorClient.start();
    if (!health.ready) throw new Error(health.diagnostics.join("; "));
    const toolchain = verifyLocalToolchainCandidate("cpp", compilerPath);
    const probeStarted = process.hrtime.bigint();
    await ensureCertifiedLocalCppSessionProbe(toolchain, temporary);
    const sessionProbeMs = Number(process.hrtime.bigint() - probeStarted) / 1_000_000;
    const submissionPath = path.join(temporary, "main.cpp");
    fs.writeFileSync(
      submissionPath,
      '#include <cstdio>\nint main(){std::puts("42");}\n',
    );
    const compilation = await compileSubmission({
      language: "cpp",
      contestantName: "certificate",
      problemName: "resolver-probe",
      submissionPath,
      tempDirectory: temporary,
      cppToolchain: toolchain,
    });
    const problemDirectory = path.join(temporary, "problem");
    fs.mkdirSync(problemDirectory);
    fs.writeFileSync(
      path.join(problemDirectory, "checker.cpp"),
      [
        '#include "testlib.h"',
        "int main(int argc, char** argv){",
        "  registerTestlibCmd(argc, argv);",
        '  quitf(_ok, "ok");',
        "}",
        "",
      ].join("\n"),
    );
    const checker = await resolveChecker({
      checkerType: "checker.cpp",
      problemName: "resolver-probe",
      problemDirectory,
      tempDirectory: temporary,
      cppToolchain: toolchain,
    });
    const output = {
      toolchain: {
        ready: toolchain.ready,
        source: toolchain.source,
        provenance: toolchain.provenance,
        certificateId: toolchain.certificateId,
        selectedPath: toolchain.executablePath,
        executionPath: toolchain.executionPath,
      },
      sessionProbeMs: Math.round(sessionProbeMs * 10) / 10,
      submission: {
        status: compilation.compileStatus,
        error: compilation.compileError,
      },
      checker: {
        runtime: checker.runtime,
        error: checker.error,
        produced: !!checker.path && fs.existsSync(checker.path),
      },
    };
    console.log(JSON.stringify(output, null, 2));
    if (
      !toolchain.ready
      || toolchain.provenance !== "certified-local"
      || !toolchain.executionPath
      || compilation.compileStatus !== "OK"
      || checker.error
      || !checker.path
    ) {
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    await executorClient.shutdown().catch(() => undefined);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
