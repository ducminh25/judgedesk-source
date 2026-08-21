import type { Express } from "express";
import { osdService } from "../judge/osd-service.js";

export function registerOsdRoutes(app: Express): void {
  app.post("/api/osd/start", (req, res) => {
    const { osdPath, contestantsPath, testPath, enableLog, problemConfigs } = req.body || {};

    if (!osdPath || !contestantsPath || !testPath) {
      return res.status(400).json({
        success: false,
        message: "Cần cung cấp đầy đủ đường dẫn thư mục OSD, Thư mục Thí sinh và Thư mục Đề thi.",
      });
    }

    const result = osdService.start(
      {
        osdPath,
        contestantsPath,
        testPath,
        enableLog,
      },
      problemConfigs,
    );

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    return res.json({
      success: true,
      status: osdService.getStatus(),
    });
  });

  app.post("/api/osd/stop", (_req, res) => {
    osdService.stop();
    return res.json({
      success: true,
      status: osdService.getStatus(),
    });
  });

  app.get("/api/osd/status", (_req, res) => {
    return res.json({
      success: true,
      status: osdService.getStatus(),
    });
  });

  app.get("/api/osd/events", (_req, res) => {
    osdService.addSseClient(res);
  });
}
