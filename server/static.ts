import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // 明確處理根路徑，確保首頁一定能開（優先於 static，避免行為差異）
  app.get("/", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });

  app.use(express.static(distPath));

  // fall through to index.html for SPA client routes only（絕不攔截 /api/*，避免健康檢查等被打成前端 404）
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
