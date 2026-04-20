import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import session from "express-session";
import { createClient } from "redis";
import RedisStore from "connect-redis";
import path from "path";
import fs from "fs";
import os from "os";
import * as assignment from "./assignment";
import { getUploadsDir, getDataDir } from "./data-dir";
import db from "./db";
import cron from "node-cron";

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

    const dbModule = await import("./db");
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
      await syncRedisToSqlite(redisClient, dbModule.default as unknown as import("./redis-brands-channels").BrandsChannelsSqlite);
      console.log("[server] Redis 品牌/渠道已同步至 SQLite");
    }
    const { getRedisClient } = await import("./redis-client");
    await dbModule.runChannelsAiReplyDefaultV1(getRedisClient());

    if (!store && process.env.NODE_ENV !== "production") {
      const MemoryStore = (await import("memorystore")).default;
      const MemStore = MemoryStore(session);
      store = new MemStore({ checkPeriod: 86400000 });
    }

    /** Railway / 負載平衡探針：必須在 session 之前，避免 Redis session 讀取阻塞導致 health 逾時 */
    const sendLivenessHealth = (res: Response) => {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.set("Pragma", "no-cache");
      res.status(200).json({ ok: true });
    };
    app.get("/api/health", (_req, res) => sendLivenessHealth(res));
    app.head("/api/health", (_req, res) => {
      res.set("Cache-Control", "no-store");
      res.status(200).end();
    });

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

    httpServer.listen(port, "0.0.0.0", async () => {
      log(`serving on port ${port}`);

      // Phase 106.24：主站 in-process 消費 ai-reply 佇列（預設啟用；設 ENABLE_INPROCESS_WORKER=false 可改回獨立 worker）
      const inProcessWorkerEnabled = process.env.ENABLE_INPROCESS_WORKER !== "false";
      console.log(`[Server] in-process worker enabled: ${inProcessWorkerEnabled}`);
      try {
        if (inProcessWorkerEnabled && redisUrl && process.env.INTERNAL_API_SECRET?.trim()) {
          const internalSecret = process.env.INTERNAL_API_SECRET.trim();
          const { logInProcessWorkerDbDiagnostics, executeAiReplyQueueJob } = await import(
            "./workers/ai-reply-worker-shared"
          );
          const {
            startAiReplyWorker,
            getWorkerRedis,
            WORKER_HEARTBEAT_KEY,
            WORKER_HEARTBEAT_TTL_S,
          } = await import("./queue/ai-reply.queue");
          logInProcessWorkerDbDiagnostics();

          const callRunAiReplyLoopback = async (
            payload: import("./workers/ai-reply-worker-shared").RunAiReplyPayload
          ): Promise<void> => {
            const url = `http://127.0.0.1:${port}/internal/run-ai-reply`;
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Internal-Secret": internalSecret },
              body: JSON.stringify(payload),
            });

            /** 504：routes 層 soft timeout 已推罐頭給客人，worker 不需 retry */
            if (res.status === 504) {
              console.log("[Loopback] soft timeout 504, assuming fallback pushed by routes. contactId:", payload.contactId);
              return;
            }

            if (!res.ok) {
              const errText = await res.text().catch(() => "");
              /** Phase 106.25：非 2xx 必須拋錯讓 worker 進入 failed/retry；不可靜默 return */
              throw new Error(`Loopback HTTP ${res.status}: ${errText.slice(0, 300)}`);
            }

            /** Phase 106.26：SPA fallback 曾回 HTML 200，必須拒絕非 JSON 以免誤判成功 */
            const contentType = res.headers.get("content-type") || "";
            if (!contentType.includes("application/json")) {
              const body = await res.text().catch(() => "");
              throw new Error(`Loopback non-JSON response (content-type=${contentType}): ${body.slice(0, 200)}`);
            }
          };

          startAiReplyWorker((job) => executeAiReplyQueueJob(job, callRunAiReplyLoopback));

          const workerRedis = getWorkerRedis();
          if (workerRedis) {
            const writeHeartbeat = () => {
              const payload = JSON.stringify({
                worker_id: `in-process:pid:${process.pid}`,
                timestamp: Date.now(),
                pid: process.pid,
                hostname: os.hostname(),
              });
              workerRedis
                .set(WORKER_HEARTBEAT_KEY, payload, "EX", WORKER_HEARTBEAT_TTL_S)
                .catch((err: Error) => console.error("[Server] worker heartbeat write failed:", err?.message));
            };
            writeHeartbeat();
            setInterval(writeHeartbeat, 30_000);
          }
          console.log("[Server] in-process ai-reply BullMQ worker started (BullMQ consumer in API process).");
        } else if (inProcessWorkerEnabled && !redisUrl) {
          console.warn("[Server] in-process worker not started: REDIS_URL unset");
        } else if (inProcessWorkerEnabled && !process.env.INTERNAL_API_SECRET?.trim()) {
          console.error(
            "[Server] in-process worker not started: INTERNAL_API_SECRET unset (required for loopback /internal/run-ai-reply)"
          );
        }
      } catch (e) {
        console.error("[Server] in-process worker bootstrap failed:", e);
      }

      // Phase 106.20：LINE channel access token 健康檢查（/v2/bot/info），每 30 分鐘；首次延後 90 秒避開啟動尖峰
      const runLineHealth = () => {
        import("./services/messaging.service")
          .then(({ runLineTokenHealthChecks }) =>
            runLineTokenHealthChecks().catch((e) => console.error("[LINE token health] scheduled run failed:", e))
          )
          .catch((e) => console.error("[LINE token health] module load failed:", e));
      };
      setTimeout(runLineHealth, 90_000);
      setInterval(runLineHealth, 30 * 60 * 1000);

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
          .then(({ runOrderSync, runDeepOrderSync }) => {
            setTimeout(() => {
              console.log("[OrderSync] 首次同步：一頁近 3 天 + Shopline 近 1 天...");
              Promise.all([
                runOrderSync({ days: 3, shopline: false }).catch((e) =>
                  console.error("[OrderSync] 首次一頁同步失敗:", (e as Error)?.message || e)
                ),
                runOrderSync({ days: 1, superlanding: false }).catch((e) =>
                  console.error("[OrderSync] 首次 Shopline 同步失敗:", (e as Error)?.message || e)
                ),
              ]).catch(() => {});
            }, 120_000);

            // 一頁商店：每 15 分鐘、近 3 天（變化較快）
            setInterval(() => {
              runOrderSync({ days: 3, shopline: false }).catch((e) =>
                console.error("[OrderSync] 一頁定時同步失敗:", (e as Error)?.message || e)
              );
            }, 15 * 60 * 1000);

            // Shopline：每 60 分鐘、近 1 天（訂單量少時再降頻）
            setInterval(() => {
              runOrderSync({ days: 1, superlanding: false }).catch((e) =>
                console.error("[OrderSync] Shopline 定時同步失敗:", (e as Error)?.message || e)
              );
            }, 60 * 60 * 1000);

            // Phase 106.32：Deep Sync 已於 runOrderSync 內分批 yield；定時排程恢復。手動觸發：POST /api/admin/trigger-deep-sync
            cron.schedule("0 4 * * *", () => runDeepOrderSync(), { timezone: "Asia/Taipei" });
            cron.schedule("30 12 * * *", () => runDeepOrderSync(), { timezone: "Asia/Taipei" });
            cron.schedule("0 18 * * *", () => runDeepOrderSync(), { timezone: "Asia/Taipei" });
            cron.schedule("0 23 * * *", () => runDeepOrderSync(), { timezone: "Asia/Taipei" });

            console.log(
              "[Deep Sync] 排程已註冊：04:00 / 12:30 / 18:00 / 23:00 (Asia/Taipei)；啟動後自動 Deep 仍停用，請用手動 API"
            );

            // Phase 106.30/106.32：啟動後 60 秒首次 Deep Sync 保持停用（避免一開機就深層同步）；需要時 POST /api/admin/trigger-deep-sync
            // setTimeout(() => {
            //   console.log("[Deep Sync] 啟動後首次同步");
            //   runDeepOrderSync().catch((err) => console.error("[Deep Sync] 首次同步失敗:", err));
            // }, 60_000);

            console.log("[server] Shopline 訂單同步已啟用：每 60 分鐘，days: 1");
            console.log(
              "[server] 訂單定時同步已啟用（一頁每 15 分鐘／近 3 天；Shopline 每 60 分鐘／近 1 天）"
            );
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

      const PRODUCT_SYNC_INTERVAL = 24 * 60 * 60 * 1000;
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

      console.log("[server] 商品定時同步已啟用（每 24 小時，啟動 30 秒後首次同步）");

      // 24 小時閒置結案：每 15 分鐘掃描一次，客戶最後一則為 user 且超過 idle_close_hours 未回則結案（排除 awaiting_human / high_risk）。
      setInterval(async () => {
        try {
          const { storage } = await import("./storage");
          const { runIdleCloseJob, getIdleCloseHours } = await import("./idle-close-job");
          const hours = getIdleCloseHours(storage);
          const results = await runIdleCloseJob(storage, hours);
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

      // 啟動後自動同步 prompt 到 DB（每次啟動皆以檔案為準覆寫 DB，不以 DB 既有值為保留條件）
      setTimeout(async () => {
        try {
          const { storage } = await import("./storage");

          const globalPromptPath = path.join(process.cwd(), "docs/persona/PHASE97_MASTER_SLIM.txt");
          const brand1Path = path.join(process.cwd(), "docs/persona/brands/brand_1_phase97_slim.txt");
          const brand2Path = path.join(process.cwd(), "docs/persona/brands/brand_2_phase97_slim.txt");

          let syncedCount = 0;

          // Global prompt（無條件以檔案覆寫；檔案不存在或內容空白則跳過）
          try {
            if (fs.existsSync(globalPromptPath)) {
              const content = fs.readFileSync(globalPromptPath, "utf-8");
              if (content && content.trim().length > 0) {
                storage.setSetting("system_prompt", content);
                console.log(`[startup-sync] Global prompt 已更新（${content.length} chars）`);
                syncedCount++;
              }
            }
          } catch (e) {
            console.error("[startup-sync] Global prompt 同步失敗:", e);
          }

          // Brand 1 prompt（無條件以檔案覆寫）
          try {
            if (fs.existsSync(brand1Path)) {
              const content = fs.readFileSync(brand1Path, "utf-8");
              if (content && content.trim().length > 0) {
                db.prepare("UPDATE brands SET system_prompt = ? WHERE id = 1").run(content);
                console.log(`[startup-sync] Brand 1 prompt 已更新（${content.length} chars）`);
                syncedCount++;
              }
            }
          } catch (e) {
            console.error("[startup-sync] Brand 1 prompt 同步失敗:", e);
          }

          // Brand 2 prompt（無條件以檔案覆寫）
          try {
            if (fs.existsSync(brand2Path)) {
              const content = fs.readFileSync(brand2Path, "utf-8");
              if (content && content.trim().length > 0) {
                db.prepare("UPDATE brands SET system_prompt = ? WHERE id = 2").run(content);
                console.log(`[startup-sync] Brand 2 prompt 已更新（${content.length} chars）`);
                syncedCount++;
              }
            }
          } catch (e) {
            console.error("[startup-sync] Brand 2 prompt 同步失敗:", e);
          }

          console.log(`[startup-sync] Prompt 啟動同步完成，共更新 ${syncedCount} 份`);

          const b1row = db
            .prepare("SELECT shopline_store_domain FROM brands WHERE id = 1")
            .get() as { shopline_store_domain?: string } | undefined;
          if (!String(b1row?.shopline_store_domain ?? "").trim()) {
            db.prepare("UPDATE brands SET shopline_store_domain = ? WHERE id = 1").run("enjoythelife.shoplineapp.com");
          }

          try {
            const b1form = db
              .prepare("SELECT cancel_form_url, return_form_url, exchange_form_url FROM brands WHERE id = 1")
              .get() as any;
            if (
              b1form &&
              !String(b1form.cancel_form_url ?? "").trim() &&
              !String(b1form.return_form_url ?? "").trim() &&
              !String(b1form.exchange_form_url ?? "").trim()
            ) {
              db.prepare(
                "UPDATE brands SET cancel_form_url = ?, return_form_url = ?, exchange_form_url = ? WHERE id = 1"
              ).run("https://jsj.top/f/x253ie", "https://jsj.top/f/rwcIDN", "https://jsj.top/f/PwcbA7");
              console.log("[startup] Brand 1 表單 URL 已設定");
            }

            const b2form = db
              .prepare("SELECT cancel_form_url, return_form_url, exchange_form_url FROM brands WHERE id = 2")
              .get() as any;
            if (
              b2form &&
              !String(b2form.cancel_form_url ?? "").trim() &&
              !String(b2form.return_form_url ?? "").trim() &&
              !String(b2form.exchange_form_url ?? "").trim()
            ) {
              db.prepare(
                "UPDATE brands SET cancel_form_url = ?, return_form_url = ?, exchange_form_url = ? WHERE id = 2"
              ).run("https://jsj.top/f/x253ie", "https://jsj.top/f/rwcIDN", "https://jsj.top/f/PwcbA7");
              console.log("[startup] Brand 2 表單 URL 已設定");
            }
          } catch (e) {
            console.error("[startup] 表單 URL 設定失敗:", e);
          }
        } catch (e) {
          console.error("[startup-sync] Prompt 同步整體失敗:", e);
        }
      }, 5000);
    });
  } catch (err) {
    console.error("[server] Startup failed:", err);
    process.exit(1);
  }
})();