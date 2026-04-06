import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import session from "express-session";
import { createClient } from "redis";
import RedisStore from "connect-redis";
import path from "path";
import fs from "fs";
import * as assignment from "./assignment";
import { getUploadsDir, getDataDir } from "./data-dir";
import db from "./db";

const app = express();
const httpServer = createServer(app);

// 雲端反向代理 (Railway 等) 下必須設定，讓 req.secure 正確，session cookie 的 Secure 才會生效
app.set("trust proxy", 1);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// 若未來加入 compression 中介層，請排除 GET /api/events，否則 SSE 串流可能被壓縮導致代理層 ERR_HTTP2_PROTOCOL_ERROR 或連線中斷。
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("ETag", "false");
  next();
});
app.set("etag", false);

const sessionSecret = process.env.SESSION_SECRET?.trim();
if (!sessionSecret) {
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: In production, SESSION_SECRET must be set. Refusing to start.");
    process.exit(1);
  }
}

const redisUrl = process.env.REDIS_URL?.trim();
if (!redisUrl) {
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: REDIS_URL must be set in production. Refusing to start.");
    process.exit(1);
  }
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

(globalThis as any).__serverStartTime = new Date().toISOString();

(async () => {
  try {
    const dataDir = getDataDir();
    console.log("[server] DATA_DIR =", dataDir);
    console.log("[server] DB path =", path.join(dataDir, "omnichannel.db"));
    if (process.env.NODE_ENV === "production" && dataDir === "/data") {
      console.warn("[server] 使用預設 /data。若未在 Railway 掛載 Volume 至 /data，重啟或重新部署後品牌/渠道等資料會遺失，請見 docs/RAILWAY_PERSISTENT_STORAGE.md");
    }

    // production 時先掛載靜態檔（/、/assets/*），避免 /assets/* 被 session、SSE 等中間件阻塞導致 pending
    if (process.env.NODE_ENV === "production") {
      serveStatic(app);
    }

    let store: session.Store | undefined;

    if (redisUrl) {
      const redisClient = createClient({ url: redisUrl });
      redisClient.on("error", (err) => console.error("[Redis] error", err));
      await redisClient.connect();
      store = new RedisStore({
        client: redisClient,
        prefix: "sess:",
      });
      const { setRedisClient } = await import("./redis-client");
      setRedisClient(redisClient);
      const { syncRedisToSqlite } = await import("./redis-brands-channels");
      const dbModule = await import("./db");
      await syncRedisToSqlite(redisClient, dbModule.default as unknown as Parameters<typeof syncRedisToSqlite>[1]);
      console.log("[server] Redis 品牌/渠道已同步至 SQLite");
    }

    if (!store && process.env.NODE_ENV !== "production") {
      const MemoryStore = (await import("memorystore")).default;
      const MemStore = MemoryStore(session);
      store = new MemStore({ checkPeriod: 86400000 });
    }

    app.use(
      session({
        store,
        secret: sessionSecret || "omnichannel-secret-key",
        resave: false,
        saveUninitialized: false,
        cookie: {
          maxAge: 24 * 60 * 60 * 1000,
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production", // production (Railway HTTPS) 必須 true，需配合 trust proxy
        },
      }),
    );

    app.use("/uploads", express.static(getUploadsDir()));
    await registerRoutes(httpServer, app);

    app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";

      console.error("Internal Server Error:", err);

      if (res.headersSent) {
        return next(err);
      }

      return res.status(status).json({ message });
    });

    if (process.env.NODE_ENV !== "production") {
      const { setupVite } = await import("./vite");
      await setupVite(httpServer, app);
    }
    // production 時靜態檔已在上面先掛載

    const port = parseInt(process.env.PORT || "8080", 10);

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      console.error("[server] Listen error:", err.message);
      if (err.code === "EADDRINUSE") {
        console.error(`[server] Port ${port} is already in use. Change PORT or stop the other process.`);
      }
      process.exit(1);
    });

    httpServer.listen(port, "0.0.0.0", () => {
      log(`serving on port ${port}`);

      // 逾時重分配定時器：僅在 ENABLE_SYNC=true 時執行，避免低 RAM 環境下與其他背景任務疊加負載（預設關閉）。
      if (process.env.ENABLE_SYNC === "true") {
        setInterval(() => {
          try {
            const results = assignment.runOverdueReassign();
            if (results.some((r) => r.reassigned)) {
              console.log("[assignment] 逾時重分配:", results.filter((r) => r.reassigned).map((r) => r.contactId));
            }
          } catch (e) {
            console.error("[assignment] runOverdueReassign error:", e);
          }
        }, 60 * 1000);
      }

      function cleanupOldNormalizedOrders() {
        try {
          const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 19)
            .replace("T", " ");
          const result = db.prepare("DELETE FROM orders_normalized WHERE created_at < ?").run(cutoff);
          if (result.changes > 0) {
            console.log(`[OrderCleanup] 清理了 ${result.changes} 筆超過 90 天的訂單快取`);
          }
        } catch (e) {
          console.error("[OrderCleanup] 清理失敗:", (e as Error)?.message);
        }
      }

      setInterval(cleanupOldNormalizedOrders, 24 * 60 * 60 * 1000);

      if (process.env.ENABLE_ORDER_SYNC === "true") {
        import("./scripts/sync-orders-normalized")
          .then(({ runOrderSync }) => {
            setTimeout(() => {
              console.log("[OrderSync] 首次同步開始（近 7 天）...");
              runOrderSync({ days: 7 }).catch((e) =>
                console.error("[OrderSync] 首次同步失敗:", (e as Error)?.message || e)
              );
            }, 120_000);

            // runOrderSync：非 backfill 時 SuperLanding maxPages=100（每頁 200 筆≈2 萬筆上限），定時近 3 天足夠；大量歷史請分批手動跑
            setInterval(() => {
              runOrderSync({ days: 3 }).catch((e) =>
                console.error("[OrderSync] 定時同步失敗:", (e as Error)?.message || e)
              );
            }, 15 * 60 * 1000);

            console.log("[server] 訂單定時同步已啟用（每 15 分鐘同步近 3 天）");
          })
          .catch((e) => {
            console.error(
              "[server] 訂單同步模組載入失敗（runOrderSync 可能未 export）:",
              (e as Error)?.message || e
            );
          });
      } else {
        console.log("[server] ENABLE_ORDER_SYNC 未啟用；若需定時同步請設 ENABLE_ORDER_SYNC=true");
      }

      const PRODUCT_SYNC_INTERVAL = 6 * 60 * 60 * 1000;
      const PRODUCT_SYNC_INITIAL_DELAY = 30 * 1000;

      setTimeout(async () => {
        try {
          const { syncShoplineProductsToCatalog } = await import("./shopline");
          const brands = db.prepare("SELECT id, shopline_store_domain, shopline_api_token FROM brands").all() as {
            id: number;
            shopline_store_domain: string;
            shopline_api_token: string;
          }[];

          for (const brand of brands) {
            const config = { storeDomain: brand.shopline_store_domain, apiToken: brand.shopline_api_token };
            if (!String(config.storeDomain || "").trim() || !String(config.apiToken || "").trim()) {
              console.log(`[product-sync] 品牌 ${brand.id} 缺少 Shopline 設定，跳過`);
              continue;
            }
            try {
              await syncShoplineProductsToCatalog(brand.id, config);
            } catch (e) {
              console.error(`[product-sync] 品牌 ${brand.id} 同步失敗:`, e);
            }
          }

          console.log("[product-sync] 首次商品同步完成");
        } catch (e) {
          console.error("[product-sync] 首次同步失敗:", e);
        }

        setInterval(async () => {
          try {
            const { syncShoplineProductsToCatalog } = await import("./shopline");
            const brands = db.prepare("SELECT id, shopline_store_domain, shopline_api_token FROM brands").all() as {
              id: number;
              shopline_store_domain: string;
              shopline_api_token: string;
            }[];

            for (const brand of brands) {
              const config = { storeDomain: brand.shopline_store_domain, apiToken: brand.shopline_api_token };
              if (!String(config.storeDomain || "").trim() || !String(config.apiToken || "").trim()) continue;
              try {
                await syncShoplineProductsToCatalog(brand.id, config);
              } catch (e) {
                console.error(`[product-sync] 品牌 ${brand.id} 定時同步失敗:`, e);
              }
            }
            console.log("[product-sync] 定時商品同步完成");
          } catch (e) {
            console.error("[product-sync] 定時同步失敗:", e);
          }
        }, PRODUCT_SYNC_INTERVAL);
      }, PRODUCT_SYNC_INITIAL_DELAY);

      console.log("[server] 商品定時同步已啟用（每 6 小時，啟動 30 秒後首次同步）");

      // 24 小時閒置結案：每 15 分鐘掃描一次，客戶最後一則為 user 且超過 idle_close_hours 未回則結案（排除 awaiting_human / high_risk）。
      setInterval(async () => {
        try {
          const { storage } = await import("./storage");
          const { runIdleCloseJob, getIdleCloseHours } = await import("./idle-close-job");
          const hours = getIdleCloseHours(storage);
          const results = runIdleCloseJob(storage, hours);
          if (results.length > 0) {
            const closed = results.filter((r) => r.closed);
            if (closed.length > 0) console.log("[idle-close] 24h 閒置結案:", closed.length, "筆", closed.map((r) => r.contactId));
          }
        } catch (e) {
          console.error("[idle-close] runIdleCloseJob error:", e);
        }
      }, 15 * 60 * 1000);

      const domain = process.env.APP_DOMAIN
        ? `https://${process.env.APP_DOMAIN}`
        : `http://localhost:${port}`;

      console.log("\n" + "=".repeat(70));
      console.log("  Webhook URLs (請複製到各平台後台設定)");
      console.log("=".repeat(70));
      console.log(`  LINE  Webhook URL : ${domain}/api/webhook/line`);
      console.log(`  FB    Webhook URL : ${domain}/api/webhook/facebook`);
      console.log(`  FB    Verify Token: ${process.env.FB_VERIFY_TOKEN || "omnichannel_fb_verify_2024"}`);
      console.log("=".repeat(70));
      console.log(`  SSE  Events URL   : ${domain}/api/events`);
      console.log("=".repeat(70) + "\n");

      // 啟動後自動同步 prompt 到 DB
      setTimeout(() => {
        try {
          const root = process.cwd();

          const globalPrompt = fs
            .readFileSync(path.join(root, "docs/persona/PHASE97_MASTER_SLIM.txt"), "utf-8")
            .trim();
          db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('system_prompt', ?)").run(globalPrompt);

          const b1 = fs
            .readFileSync(path.join(root, "docs/persona/brands/brand_1_phase97_slim.txt"), "utf-8")
            .trim();
          db.prepare("UPDATE brands SET system_prompt = ? WHERE id = 1").run(b1);

          const b2 = fs
            .readFileSync(path.join(root, "docs/persona/brands/brand_2_phase97_slim.txt"), "utf-8")
            .trim();
          db.prepare("UPDATE brands SET system_prompt = ? WHERE id = 2").run(b2);

          const b1row = db
            .prepare("SELECT shopline_store_domain FROM brands WHERE id = 1")
            .get() as { shopline_store_domain?: string } | undefined;
          if (!String(b1row?.shopline_store_domain ?? "").trim()) {
            db.prepare("UPDATE brands SET shopline_store_domain = ? WHERE id = 1").run("enjoythelife.shoplineapp.com");
          }

          console.log("[startup] Prompt 已自動同步到 DB（Global + Brand 1 + Brand 2）");
        } catch (e) {
          console.error("[startup] Prompt 同步失敗:", e);
        }
      }, 5000);
    });
  } catch (err) {
    console.error("[server] Startup failed:", err);
    process.exit(1);
  }
})();