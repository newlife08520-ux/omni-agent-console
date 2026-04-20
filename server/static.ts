import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  // 支援 bundled 後 __dirname 在 dist/，或從專案根目錄執行 node dist/index.cjs 時用 cwd
  let distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    const fallback = path.resolve(process.cwd(), "dist", "public");
    if (fs.existsSync(fallback)) {
      distPath = fallback;
      console.log("[server] serveStatic 使用 fallback 路徑:", distPath);
    } else {
      console.error("[server] 找不到前端 build 目錄。嘗試過:", path.resolve(__dirname, "public"), "與", fallback);
      throw new Error(
        `Could not find the build directory. Tried: ${distPath}, ${fallback}. Make sure to run client build first (e.g. vite build).`,
      );
    }
  } else {
    console.log("[server] serveStatic 路徑:", distPath);
  }

  // 明確處理根路徑，確保首頁一定能開（優先於 static，避免行為差異）
  app.get("/", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });

  app.use(express.static(distPath));

  // fall through to index.html for SPA client routes only（絕不攔截 /api/*、/uploads/*、/internal/*）
  // 否則 LINE 下載的圖片 URL（/uploads/...）會被誤送 index.html，後台聊天室圖片破圖。
  // Phase 106.26：/internal/*（含 POST /internal/run-ai-reply）若被送 index.html，worker loopback 會誤判 200 成功而從未進 autoReplyWithAI。
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    if (req.path === "/uploads" || req.path.startsWith("/uploads/")) return next();
    if (req.path.startsWith("/internal")) return next();
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
