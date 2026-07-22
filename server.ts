import express from "express";
import path from "path";
import { registerBatchJudgeRoute } from "./server/judge/batch-judge-route.js";
import { registerJobRoutes } from "./server/jobs.js";
import { APP_ROOT, IS_PRODUCTION, SERVER_PORT } from "./server/runtime.js";
import { executorClient } from "./server/executor/client.js";
import { registerExportRoutes } from "./server/routes/export-routes.js";
import { registerProblemRoutes } from "./server/routes/problem-routes.js";
import { registerSystemRoutes } from "./server/routes/system-routes.js";
import { registerToolchainRoutes } from "./server/routes/toolchain-routes.js";
import { startParentWatchdog } from "./server/platform/parent-watchdog.js";

startParentWatchdog(process.env.JUDGEDESK_PARENT_PID, async () => {
  console.error("[Tauri Shell] Parent process ended; shutting down backend sidecars.");
  try {
    await executorClient.shutdown();
  } finally {
    process.exit(0);
  }
});

async function startServer() {
  const secureRunner = await executorClient.start();
  if (!secureRunner.ready) {
    console.error(`[Secure Runner] Unavailable: ${secureRunner.diagnostics.join("; ")}`);
  } else {
    console.log(`[Secure Runner] Ready: ${secureRunner.mode} v${secureRunner.executorVersion}`);
  }
  const app = express();

  // Use JSON and URL encoded parsers
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  // CORS Middleware
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowedOrigins = new Set([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://tauri.localhost",
      "https://tauri.localhost",
      "tauri://localhost"
    ]);
    if (origin && allowedOrigins.has(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  registerJobRoutes(app);
  registerSystemRoutes(app);
  registerProblemRoutes(app);
  registerExportRoutes(app);
  registerToolchainRoutes(app);

  registerBatchJudgeRoute(app);

  // Setup Vite development server or serve build files
  if (!IS_PRODUCTION) {
    const viteModule = "vite";
    const { createServer: createViteServer } = await import(viteModule);
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(APP_ROOT, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(SERVER_PORT, "127.0.0.1", () => {
    console.log(`[Online Judge Server] Live on http://127.0.0.1:${SERVER_PORT}`);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void executorClient.shutdown().finally(() => process.exit(0));
  });
}

startServer().catch((err) => {
  console.error("Critical: Failed to boot Online Judge server:", err);
});
