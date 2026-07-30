import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDotnetCscArgs,
  validateDotnetArtifactDirectory,
  validateJavaClassDirectory,
} from "./compiler.js";

test("Java class-directory validation requires an unpackaged Main entrypoint", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-java-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Main.class"), "class");
  fs.writeFileSync(path.join(root, "Main$FastInput.class"), "class");
  validateJavaClassDirectory(root);

  fs.mkdirSync(path.join(root, "contest"));
  assert.throws(
    () => validateJavaClassDirectory(root),
    /JAVA_ARTIFACT_INVALID/,
  );
});

test(".NET artifact validation accepts only the fixed JudgeDesk assembly closure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-dotnet-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [
    "JudgeDeskSubmission.dll",
    "JudgeDeskSubmission.deps.json",
    "JudgeDeskSubmission.runtimeconfig.json",
  ]) {
    fs.writeFileSync(path.join(root, file), file);
  }
  validateDotnetArtifactDirectory(root);
  fs.writeFileSync(path.join(root, "unexpected.dll"), "unexpected");
  assert.throws(
    () => validateDotnetArtifactDirectory(root),
    /DOTNET_ARTIFACT_INVALID/,
  );
});

test(".NET compilation invokes pinned Roslyn directly with an offline reference set", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-dotnet-layout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compiler = path.join(
    root,
    "sdk",
    "10.0.302",
    "Roslyn",
    "bincore",
    "csc.dll",
  );
  const references = path.join(
    root,
    "packs",
    "Microsoft.NETCore.App.Ref",
    "10.0.10",
    "ref",
    "net10.0",
  );
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.mkdirSync(references, { recursive: true });
  fs.writeFileSync(compiler, "compiler");
  for (const name of [
    "System.Runtime.dll",
    "System.Console.dll",
    ...Array.from({ length: 98 }, (_, index) => `Reference${index}.dll`),
  ]) {
    fs.writeFileSync(path.join(references, name), name);
  }
  const args = buildDotnetCscArgs({
    workspacePath: path.join(root, "workspace"),
    sourcePath: path.join(root, "workspace", "inputs", "Submission.cs"),
    outputDirectory: path.join(root, "workspace", "compiled-output"),
    toolchainRoot: root,
  });
  assert.deepEqual(args.slice(0, 2), ["exec", compiler]);
  assert.ok(args.includes("/noconfig"));
  assert.ok(args.includes("/nostdlib+"));
  assert.ok(args.includes(`/lib:${references}`));
  assert.ok(args.includes("/reference:System.Runtime.dll"));
  assert.ok(!args.includes("build"));
  assert.ok(!args.some((argument) => argument.includes("restore")));
});
