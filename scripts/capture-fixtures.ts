import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NodeBackendAdapter } from "../server/test-fixtures/api-contracts/backend-adapter.js";
import {
  CANONICAL_CONTRACT_CASES,
  createContractContext,
  cleanContractContext,
} from "../server/test-fixtures/api-contracts/contract-cases.js";
import {
  normalizeVolatile,
  parseSseInitialEvent,
  parseNdjsonStream,
} from "../server/test-fixtures/api-contracts/normalizer.js";
import {
  createIsolatedTestEnvironment,
  recordHostAppDataHashes,
  assertHostAppDataUnchanged,
  runCompositionalTeardown,
  type IsolatedTestEnvironment,
} from "../server/test-fixtures/api-contracts/test-environment.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(repoRoot, "server", "test-fixtures", "api-contracts");

async function capture(): Promise<void> {
  let hostBaseline: Map<string, string> | null = null;
  let env: IsolatedTestEnvironment | null = null;
  let adapter: NodeBackendAdapter | null = null;
  let ctx: ReturnType<typeof createContractContext> | null = null;

  try {
    hostBaseline = recordHostAppDataHashes();
    env = createIsolatedTestEnvironment();
    adapter = new NodeBackendAdapter(env);

    console.log(`[capture-fixtures] Created isolated test root: ${env.rootDir}`);
    await adapter.start();
    console.log(`[capture-fixtures] Node adapter started at ${adapter.baseUrl}`);

    ctx = createContractContext(env.tempDir);
    for (const testCase of CANONICAL_CONTRACT_CASES) {
      testCase.before?.(ctx);
      const casePath = testCase.path(ctx);
      const headers = testCase.headers ? testCase.headers(ctx) : {};
      const rawBody = testCase.body ? testCase.body(ctx) : null;

      console.log(`  -> Capturing [${testCase.method} ${casePath}] into ${testCase.fixtureFile} ...`);

      const fetchInit: RequestInit = {
        method: testCase.method,
        headers,
        signal: AbortSignal.timeout(5000),
      };
      if (rawBody) {
        fetchInit.body = rawBody as BodyInit;
      }

      const res = await adapter.fetch(casePath, fetchInit);
      if (res.status !== testCase.expectedStatus) {
        const errBody = await res.text();
        throw new Error(
          `Unexpected status for ${testCase.id} [${testCase.method} ${casePath}]: expected HTTP ${testCase.expectedStatus}, got HTTP ${res.status}. Body: ${errBody}`,
        );
      }

      const contentType = res.headers.get("content-type") || "";
      let actualBody: unknown = null;

      if (testCase.streaming === "sse") {
        const reader = res.body?.getReader();
        if (reader) {
          const { value } = await reader.read();
          await reader.cancel();
          const text = value ? new TextDecoder().decode(value) : "";
          actualBody = parseSseInitialEvent(text);
        } else {
          actualBody = { protocol: "text/event-stream" };
        }
      } else if (testCase.streaming === "ndjson") {
        const text = await res.text();
        actualBody = parseNdjsonStream(text);
      } else if (contentType.includes("application/json")) {
        actualBody = await res.json();
      } else {
        actualBody = await res.text();
      }

      const normalized = normalizeVolatile(actualBody, {
        envRootDir: env.rootDir,
        tempRoot: env.tempDir,
      });

      const targetPath = path.join(fixturesDir, testCase.fixtureFile);
      fs.writeFileSync(
        targetPath,
        typeof normalized === "string" ? normalized : JSON.stringify(normalized, null, 2),
        "utf8",
      );
    }

    console.log(`[capture-fixtures] Successfully captured all ${CANONICAL_CONTRACT_CASES.length} fixtures!`);
  } finally {
    await runCompositionalTeardown([
      {
        name: "backendAdapter",
        run: async () => {
          if (adapter) await adapter.close();
        },
      },
      {
        name: "contractContext",
        run: () => {
          if (ctx) cleanContractContext(ctx);
        },
      },
      {
        name: "testEnvironment",
        run: async () => {
          if (env) await env.cleanup();
        },
      },
      {
        name: "hostAppDataAudit",
        run: () => {
          if (hostBaseline) {
            assertHostAppDataUnchanged(hostBaseline);
            console.log("[capture-fixtures] Verified host AppData byte-for-byte unchanged.");
          }
        },
      },
    ]);
  }
}

capture().catch((err) => {
  console.error("[capture-fixtures] Capture error:", err);
  process.exit(1);
});
