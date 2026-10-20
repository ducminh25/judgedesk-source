#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "docs", "verification", "pure-rust-core", "api-contract-manifest.json");
const inventoryJsonPath = path.join(repoRoot, "docs", "verification", "pure-rust-core", "api-contract-inventory.json");
const matrixDocPath = path.join(repoRoot, "docs", "verification", "pure-rust-core", "api-contract-matrix.md");

/**
 * @typedef {Object} InventoryResult
 * @property {boolean} passed
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {number} manifestRoutes
 * @property {number} frontendCallersFound
 * @property {number} nodeRoutesFound
 * @property {number} rustRoutesFound
 */

export function loadManifest() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

export function scanFrontendCallers(srcDir = path.join(repoRoot, "src")) {
  const callers = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        walk(fullPath);
      } else if (entry.isFile() && /\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx") || entry.name.endsWith(".spec.ts")) continue;
        const code = fs.readFileSync(fullPath, "utf8");
        const sf = ts.createSourceFile(fullPath, code, ts.ScriptTarget.Latest, true);
        const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, "/");
        const varMap = new Map();

        function visit(node) {
          // Track string/template variable declarations (e.g. const testsUrl = `...`)
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            if (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) {
              varMap.set(node.name.text, node.initializer.text);
            } else if (ts.isTemplateExpression(node.initializer)) {
              varMap.set(node.name.text, node.initializer.getText(sf));
            }
          }

          let callTarget = null;
          let args = null;
          if (ts.isCallExpression(node)) {
            const exp = node.expression.getText(sf);
            if (exp === "apiFetch" || exp === "fetch") {
              callTarget = exp;
              args = node.arguments;
            }
          } else if (ts.isNewExpression(node)) {
            const exp = node.expression.getText(sf);
            if (exp === "EventSource") {
              callTarget = exp;
              args = node.arguments;
            }
          }

          if (callTarget && args && args.length > 0) {
            const firstArg = args[0];
            let urlText = null;
            if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
              urlText = firstArg.text;
            } else if (ts.isTemplateExpression(firstArg)) {
              urlText = firstArg.getText(sf);
              if (urlText.startsWith("`") && urlText.endsWith("`")) {
                urlText = urlText.slice(1, -1);
              }
            } else if (ts.isIdentifier(firstArg) && varMap.has(firstArg.text)) {
              urlText = varMap.get(firstArg.text);
              if (urlText.startsWith("`") && urlText.endsWith("`")) {
                urlText = urlText.slice(1, -1);
              }
            }

            if (urlText && urlText.includes("/api/")) {
              let method = "GET";
              if (args.length > 1 && ts.isObjectLiteralExpression(args[1])) {
                for (const prop of args[1].properties) {
                  if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === "method") {
                    if (ts.isStringLiteral(prop.initializer)) {
                      method = prop.initializer.text.toUpperCase();
                    }
                  }
                }
              }
              const basePath = urlText.split("?")[0];
              callers.push({
                file: relPath,
                rawUrl: urlText,
                basePath,
                method,
              });
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(sf);
      }
    }
  }

  walk(srcDir);

  // Check src-tauri for backend shutdown caller
  const tauriBackendFile = path.join(repoRoot, "src-tauri", "src", "backend.rs");
  if (fs.existsSync(tauriBackendFile)) {
    const content = fs.readFileSync(tauriBackendFile, "utf8");
    if (/POST \/api\/shutdown/.test(content) || /\/api\/shutdown/.test(content)) {
      callers.push({
        file: "src-tauri/src/backend.rs",
        rawUrl: "/api/shutdown",
        basePath: "/api/shutdown",
        method: "POST",
      });
    }
  }

  callers.sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.method.localeCompare(b.method) ||
    a.basePath.localeCompare(b.basePath) ||
    a.rawUrl.localeCompare(b.rawUrl)
  );

  return callers;
}

export function scanNodeRoutes(serverDir = path.join(repoRoot, "server")) {
  const routes = [];
  const filesToScan = [];

  const serverTs = path.join(repoRoot, "server.ts");
  if (fs.existsSync(serverTs)) {
    filesToScan.push(serverTs);
  }

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "test-fixtures" || entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.isFile() && /\.(?:ts|js)$/.test(entry.name)) {
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.js") || entry.name.endsWith(".spec.ts")) continue;
        filesToScan.push(full);
      }
    }
  }

  walk(serverDir);
  filesToScan.sort((a, b) => a.localeCompare(b));

  const expressRouteRegex = /(?:app|router)\.(get|post|put|delete)\s*\(\s*["'](\/api\/[^"']+)["']/g;

  for (const file of filesToScan) {
    const content = fs.readFileSync(file, "utf8");
    const relFile = path.relative(repoRoot, file).replace(/\\/g, "/");

    let match;
    expressRouteRegex.lastIndex = 0;
    while ((match = expressRouteRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      routes.push({ method, path: routePath, file: relFile });
    }
  }

  routes.sort((a, b) =>
    a.method.localeCompare(b.method) ||
    a.path.localeCompare(b.path) ||
    a.file.localeCompare(b.file)
  );

  return routes;
}

export function scanRustRoutes(rustServerDir = path.join(repoRoot, "crates", "judgedesk-core", "src", "server")) {
  const routes = [];
  const filesToScan = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        filesToScan.push(full);
      }
    }
  }

  walk(rustServerDir);
  filesToScan.sort((a, b) => a.localeCompare(b));

  for (const file of filesToScan) {
    const content = fs.readFileSync(file, "utf8");
    const relFile = path.relative(repoRoot, file).replace(/\\/g, "/");

    let searchFrom = 0;
    while (searchFrom < content.length) {
      const routeStart = content.indexOf(".route(", searchFrom);
      if (routeStart === -1) break;

      const openParen = routeStart + ".route".length;
      let depth = 0;
      let quote = null;
      let escaped = false;
      let closeParen = -1;
      for (let index = openParen; index < content.length; index += 1) {
        const character = content[index];
        if (quote !== null) {
          if (escaped) {
            escaped = false;
          } else if (character === "\\") {
            escaped = true;
          } else if (character === quote) {
            quote = null;
          }
          continue;
        }
        if (character === '"' || character === "'") {
          quote = character;
        } else if (character === "(") {
          depth += 1;
        } else if (character === ")") {
          depth -= 1;
          if (depth === 0) {
            closeParen = index;
            break;
          }
        }
      }

      if (closeParen === -1) {
        throw new Error(`Unterminated Rust route declaration in ${relFile} at offset ${routeStart}.`);
      }
      searchFrom = closeParen + 1;

      const routeCall = content.slice(openParen + 1, closeParen);
      const routeMatch = routeCall.match(/^\s*["'](\/api\/[^"']+)["']\s*,\s*([\s\S]+)$/);
      if (!routeMatch) continue;
      const rawPath = routeMatch[1];
      const handlersStr = routeMatch[2];

      const normalizedPath = rawPath
        .replace(/\{([^}]+)\}/g, ":$1")
        .replace(/:profile_id/g, ":profileId");

      const methods = [];
      if (/\bget\(/.test(handlersStr)) methods.push("GET");
      if (/\bpost\(/.test(handlersStr)) methods.push("POST");
      if (/\bput\(/.test(handlersStr)) methods.push("PUT");
      if (/\bdelete\(/.test(handlersStr)) methods.push("DELETE");

      for (const method of methods) {
        routes.push({
          method,
          rawPath,
          normalizedPath,
          file: relFile,
        });
      }
    }
  }

  routes.sort((a, b) =>
    a.method.localeCompare(b.method) ||
    a.normalizedPath.localeCompare(b.normalizedPath) ||
    a.file.localeCompare(b.file)
  );

  return routes;
}

export function matchCallerToManifest(caller, manifestRoutes) {
  for (const r of manifestRoutes) {
    if (r.method !== caller.method) continue;

    if (r.path === caller.basePath) return r;
    if (r.dynamicPattern) {
      const reg = new RegExp(r.dynamicPattern);
      if (reg.test(caller.basePath)) return r;
    }

    const regexFromColon = new RegExp("^" + r.path.replace(/:[a-zA-Z0-9_]+/g, "[^/]+") + "$");
    if (regexFromColon.test(caller.basePath)) return r;

    const templateRegex = new RegExp("^" + r.path.replace(/:[a-zA-Z0-9_]+/g, "(?:\\$\\{[^}]+\\}|[^/]+)") + "$");
    if (templateRegex.test(caller.basePath)) return r;
  }
  return null;
}

export function generateMatrixMarkdown(manifest, inventory) {
  const lines = [];
  lines.push("# JudgeDesk Pure Rust Core — Canonical API & Stream Contract Matrix");
  lines.push("");
  lines.push("> **Authoritative Endpoint Contract Matrix for Pure Rust Core Migration**  ");
  lines.push("> **Plan Reference:** `WP0.2` in `docs/pure-rust-core-detailed-implementation-plan.md`  ");
  lines.push(`> **Generated At:** ${manifest.generatedAt}  `);
  lines.push(`> **Total Contracted Endpoints:** ${manifest.totalRoutes}  `);
  lines.push("> **Released Baseline:** `v1.5.0` | **Development Target:** `v1.6.0`  ");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 1. Inventory Summary");
  lines.push("");
  lines.push(`- **Contracted Routes in Manifest:** ${manifest.totalRoutes}`);
  lines.push(`- **Frontend API Callers Discovered:** ${inventory.frontendCallersFound}`);
  lines.push(`- **Node Backend Routes Discovered:** ${inventory.nodeRoutesFound}`);
  lines.push(`- **Rust Backend Routes Discovered:** ${inventory.rustRoutesFound}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 2. API Contract Matrix");
  lines.push("");
  lines.push("| ID | Method | Path | Streaming | Status Codes | Frontend Consumer | Concurrency Gates | Persistence | Rust Parity Notes |");
  lines.push("|---|---|---|---|---|---|---|---|---|");

  for (const r of manifest.routes) {
    const callers = r.frontendCallers.map(c => `\`${c.file}\``).join(", ") || "*Backend/Tauri internal*";
    const gates = r.concurrencyGates.join("; ") || "—";
    const persist = r.persistence || "—";
    const parity = r.rustParityGaps ? `⚠️ ${r.rustParityGaps}` : "✅ Parity in design";
    lines.push(`| \`${r.id}\` | **${r.method}** | \`${r.path}\` | \`${r.streaming}\` | \`${r.statusCodes.join(", ")}\` | ${callers} | ${gates} | ${persist} | ${parity} |`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 3. Streaming and Event Contracts");
  lines.push("");
  lines.push("### 3.1 `/api/batch-judge` (NDJSON Stream)");
  lines.push("- **Framing:** Newline-delimited JSON (`application/x-ndjson`), line terminated by `\\n`.");
  lines.push("- **Header requirement:** `X-JudgeDesk-Job-Id: <job-id>` must be returned in the response headers.");
  lines.push("- **Event Order Contract:**");
  lines.push("  1. `progress` with `{ contestant: \"\", problem: \"\", action: \"progress.initializing\", percent: 0 }`");
  lines.push("  2. `metadata` with `RunMetadata` containing `build`, `executor`, and `toolchains` (`cpp` AND `python`)");
  lines.push("  3. Zero or more test execution `progress` events");
  lines.push("  4. Per-problem `problem_completed` events with `{ contestant, problemResult }`");
  lines.push("  5. Terminating event: `done` (`{ success: true }`) on success, or `error` (`{ message: string }`) on failure.");
  lines.push("");
  lines.push("### 3.2 `/api/osd/events` (Server-Sent Events)");
  lines.push("- **Framing:** W3C Server-Sent Events (`text/event-stream`), `Cache-Control: no-cache`, `Connection: keep-alive`.");
  lines.push("- **Payload:** `data: <JSON>\\n\\n` with heartbeat comments `:\\n\\n`.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 4. Known Discrepancies and Authority Resolutions");
  lines.push("");
  lines.push("| Conflict Area | Legacy Documentation / Migration Plan | Shipped Node Backend & Frontend Code | Canonical Resolution (WP0.2 Contract) |");
  lines.push("|---|---|---|---|");
  lines.push("| Judging Endpoint Path | Some prose cites `/api/judge/session` | `/api/batch-judge` called by `src/features/judging/useJudgeSession.ts` | **`/api/batch-judge`** is authoritative. |");
  lines.push("| Judging Stream Protocol | Some prose refers to SSE `EventSource` | `apiFetch` + `ReadableStream` line parser consuming NDJSON | **Newline-delimited JSON (`application/x-ndjson`)** is authoritative. |");
  lines.push("| Batch Judge Events | Prose cites `job_start`, `test_progress`, `job_complete` | Code consumes `metadata`, `progress`, `problem_completed`, `done`, `error` | Shipped event names `metadata`, `progress`, `problem_completed`, `done`, `error` are authoritative. |");
  lines.push("| Exporter Metadata Dependency | Exporter assumed toolchains is optional | `src/features/export/score-workbook.ts` reads `metadata.toolchains.python` directly | Rust must emit `toolchains.python` in `metadata` event. |");
  lines.push("| Job Registry & Cancellation | Prose omits pre-admission cancellation | `JudgeJobRegistry` records pending cancellations and attaches/detaches runs | Job ID and registration boundary are mandatory. |");
  lines.push("| Folder Selection Shell | Native dialog | Node uses `selectDirectory`, Rust used unsanitized PowerShell string | Safe, bounded folder selection is mandatory. |");
  lines.push("| Score Export Wire Protocol | Legacy text cited `score-export-bundle` / 25MB | `shared/score-export-wire.ts` defines `score-export-v1` / 256 MiB limit | Shipped MIME `application/vnd.judgedesk.score-export-v1` and 256 MiB limit are authoritative. |");
  lines.push("");

  return lines.join("\n");
}

export function runContractInventory(options = {}) {
  const { writeReport = false } = options;
  const manifest = loadManifest();
  const manifestRoutes = manifest.routes;
  const errors = [];
  const warnings = [];

  const frontendCallers = scanFrontendCallers();
  const nodeRoutes = scanNodeRoutes();
  const rustRoutes = scanRustRoutes();

  // 1. Verify every frontend caller maps to a contract row (checking both method and path)
  for (const caller of frontendCallers) {
    const matched = matchCallerToManifest(caller, manifestRoutes);
    if (!matched) {
      errors.push(`Frontend caller '${caller.method} ${caller.rawUrl}' in ${caller.file} has no matching contract row in manifest.`);
    }
  }

  // 2. Verify every Node route maps to a contract row and source file matches
  for (const nr of nodeRoutes) {
    const matched = manifestRoutes.find(
      (r) => r.method === nr.method && r.path === nr.path,
    );
    if (!matched) {
      errors.push(`Node route '${nr.method} ${nr.path}' in ${nr.file} is missing from contract manifest.`);
    } else if (matched.nodeImplementation && matched.nodeImplementation.file !== nr.file) {
      errors.push(`Node route '${nr.method} ${nr.path}' discovered in '${nr.file}', but manifest expected '${matched.nodeImplementation.file}'.`);
    }
  }

  // 3. Verify every Rust route maps to a contract row and source file matches
  for (const rr of rustRoutes) {
    const matched = manifestRoutes.find(
      (r) => r.method === rr.method && r.path === rr.normalizedPath,
    );
    if (!matched) {
      errors.push(`Rust route '${rr.method} ${rr.rawPath}' in ${rr.file} is missing from contract manifest.`);
    } else if (matched.rustImplementation && matched.rustImplementation.file !== rr.file) {
      errors.push(`Rust route '${rr.method} ${rr.rawPath}' discovered in '${rr.file}', but manifest expected '${matched.rustImplementation.file}'.`);
    }
  }

  // 4. Verify every Manifest route is implemented in Node and Rust at specified source files
  for (const mr of manifestRoutes) {
    const nodeImpl = nodeRoutes.find(
      (nr) => nr.method === mr.method && nr.path === mr.path && nr.file === mr.nodeImplementation.file,
    );
    if (!nodeImpl) {
      errors.push(`Manifest route '${mr.method} ${mr.path}' is not implemented in Node backend at '${mr.nodeImplementation.file}'.`);
    }

    const rustImpl = rustRoutes.find(
      (rr) => rr.method === mr.method && rr.normalizedPath === mr.path && rr.file === mr.rustImplementation.file,
    );
    if (!rustImpl) {
      errors.push(`Manifest route '${mr.method} ${mr.path}' is not implemented in Rust backend at '${mr.rustImplementation.file}'.`);
    }
  }

  // 5. Verify total route counts match dynamically
  if (manifestRoutes.length !== nodeRoutes.length) {
    errors.push(`Route count mismatch: manifest has ${manifestRoutes.length} routes, Node backend has ${nodeRoutes.length} routes.`);
  }
  if (manifestRoutes.length !== rustRoutes.length) {
    errors.push(`Route count mismatch: manifest has ${manifestRoutes.length} routes, Rust backend has ${rustRoutes.length} routes.`);
  }

  const passed = errors.length === 0;
  const result = {
    passed,
    errors,
    warnings,
    manifestRoutes: manifestRoutes.length,
    frontendCallersFound: frontendCallers.length,
    nodeRoutesFound: nodeRoutes.length,
    rustRoutesFound: rustRoutes.length,
  };

  if (writeReport) {
    // Generate matrix markdown file
    const markdown = generateMatrixMarkdown(manifest, result);
    fs.writeFileSync(matrixDocPath, markdown, "utf8");

    // Generate inventory JSON artifact (deterministic, without volatile timestamps)
    const inventoryData = {
      manifestRoutesCount: manifestRoutes.length,
      nodeRoutesCount: nodeRoutes.length,
      rustRoutesCount: rustRoutes.length,
      frontendCallersCount: frontendCallers.length,
      nodeRoutes,
      rustRoutes,
      frontendCallers,
      manifestRoutes: manifestRoutes.map((r) => ({
        id: r.id,
        method: r.method,
        path: r.path,
        streaming: r.streaming,
        statusCodes: r.statusCodes,
        concurrencyGates: r.concurrencyGates,
        persistence: r.persistence,
        rustParityGaps: r.rustParityGaps,
        nodeImplementation: r.nodeImplementation,
        rustImplementation: r.rustImplementation,
      })),
    };
    fs.writeFileSync(inventoryJsonPath, JSON.stringify(inventoryData, null, 2), "utf8");
  }

  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runContractInventory({ writeReport: true });
  console.log(`[check-api-contracts] Manifest routes: ${result.manifestRoutes}`);
  console.log(`[check-api-contracts] Frontend callers: ${result.frontendCallersFound}`);
  console.log(`[check-api-contracts] Node routes: ${result.nodeRoutesFound}`);
  console.log(`[check-api-contracts] Rust routes: ${result.rustRoutesFound}`);

  if (!result.passed) {
    console.error(`\n[check-api-contracts] FAILED with ${result.errors.length} error(s):`);
    for (const err of result.errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  console.log("[check-api-contracts] SUCCESS: all API callers and routes match contract manifest cleanly.");
  process.exit(0);
}
