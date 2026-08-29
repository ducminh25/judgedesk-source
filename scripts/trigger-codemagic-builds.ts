import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TOKEN = process.env.CODEMAGIC_API_TOKEN;
const APP_ID = "6a59050a8f1abc95b83e8570";

if (!TOKEN) {
  throw new Error("CODEMAGIC_API_TOKEN is missing!");
}

async function triggerBuild(payload: any) {
  const res = await fetch("https://api.codemagic.io/builds", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-token": TOKEN!,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to trigger build (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.buildId as string;
}

async function getBuildStatus(buildId: string) {
  const res = await fetch(`https://api.codemagic.io/builds/${buildId}`, {
    headers: { "x-auth-token": TOKEN! },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get build status (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.build;
}

async function downloadFile(url: string, dest: string) {
  const res = await fetch(url, {
    headers: { "x-auth-token": TOKEN! },
  });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

async function waitForBuild(name: string, buildId: string): Promise<any> {
  console.log(`[${name}] Started build: ${buildId}`);
  while (true) {
    await new Promise((r) => setTimeout(r, 15000));
    const build = await getBuildStatus(buildId);
    const status = build.status;
    console.log(`[${name}] Status: ${status}`);
    if (status === "finished") {
      return build;
    }
    if (status === "failed" || status === "canceled" || status === "timeout") {
      throw new Error(`[${name}] Build ${status}! Check logs on CodeMagic.`);
    }
  }
}

async function extractArtifacts(build: any, targetDir: string) {
  for (const artifact of build.artefacts || []) {
    const tempFile = path.join(targetDir, `_temp_${artifact.name}`);
    console.log(`Downloading ${artifact.name}...`);
    await downloadFile(artifact.url, tempFile);

    if (artifact.name.endsWith(".zip")) {
      console.log(`Extracting zip bundle ${artifact.name}...`);
      execFileSync("tar", ["-xf", tempFile, "-C", targetDir], { stdio: "inherit" });
      fs.unlinkSync(tempFile);
    }
  }
}

async function main() {
  const coreSha256 = "a2861f4f01b33be0e65cd6398faffdd36614afdf216ca618929f60e367e9017d";
  const fullSha256 = "15e83935644c2c0e4402a2a7f406573fb56c770a770baeb58f629356e2710e27";

  console.log("Triggering windows-updater-signing...");
  const winBuildId = await triggerBuild({
    appId: APP_ID,
    workflowId: "windows-updater-signing",
    branch: "main",
    environment: {
      variables: {
        WINDOWS_CORE_MSI_SHA256: coreSha256,
        WINDOWS_FULL_MSI_SHA256: fullSha256,
      },
    },
  });

  console.log("Triggering macos-arm64-release...");
  const macBuildId = await triggerBuild({
    appId: APP_ID,
    workflowId: "macos-arm64-release",
    branch: "main",
    tag: "v1.4.43",
  });

  console.log(`Windows Build ID: ${winBuildId}`);
  console.log(`Mac Build ID: ${macBuildId}`);

  const [winBuild, macBuild] = await Promise.all([
    waitForBuild("Windows Signing", winBuildId),
    waitForBuild("Mac Release", macBuildId),
  ]);

  console.log("Both CodeMagic builds succeeded!");

  const stagingDir = path.resolve("release-staging");
  fs.mkdirSync(stagingDir, { recursive: true });

  console.log("Extracting Windows artifacts...");
  await extractArtifacts(winBuild, stagingDir);

  console.log("Extracting Mac artifacts...");
  await extractArtifacts(macBuild, stagingDir);

  console.log("Files in release-staging:");
  console.log(fs.readdirSync(stagingDir));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
