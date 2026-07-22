import type { Express } from "express";
import { selectDirectory } from "../platform/directory-picker.js";
import { getHostStatus } from "../platform/host-status.js";
import { executorClient } from "../executor/client.js";

export function registerSystemRoutes(app: Express): void {
  app.get("/api/status", (_req, res) => {
    res.json(getHostStatus());
  });

  app.post("/api/shutdown", async (_req, res) => {
    await executorClient.shutdown();
    res.json({ success: true });
    setTimeout(() => process.exit(0), 50);
  });

  app.post("/api/select-directory", (req, res) => {
    try {
      const { defaultPath } = req.body;
      const selectedPath = selectDirectory(defaultPath);
      console.log("[SelectDirectory] Path selected:", selectedPath);
      if (selectedPath === null) {
        res.json({ success: false, error: "Canceled" });
      } else {
        res.json({ success: true, path: selectedPath });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SelectDirectory] Picker error:", message);
      res.json({ success: false, error: message });
    }
  });
}
