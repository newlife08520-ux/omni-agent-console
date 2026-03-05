import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import session from "express-session";
import { createClient } from "redis";
import RedisStore from "connect-redis";
import path from "path";
import * as assignment from "./assignment";
import { getUploadsDir } from "./data-dir";

const app = express();
const httpServer = createServer(app);

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

(async () => {
  try {
    let store: session.Store | undefined;

    if (redisUrl) {
      const redisClient = createClient({ url: redisUrl });
      redisClient.on("error", (err) => console.error("[Redis] error", err));
      await redisClient.connect();
      store = new RedisStore({
        client: redisClient,
        prefix: "sess:",
      });
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
          secure: process.env.NODE_ENV === "production",
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

    if (process.env.NODE_ENV === "production") {
      serveStatic(app);
    } else {
      const { setupVite } = await import("./vite");
      await setupVite(httpServer, app);
    }

    const port = parseInt(process.env.PORT || "5001", 10);

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      console.error("[server] Listen error:", err.message);
      if (err.code === "EADDRINUSE") {
        console.error(`[server] Port ${port} is already in use. Change PORT or stop the other process.`);
      }
      process.exit(1);
    });

    httpServer.listen(port, "0.0.0.0", () => {
      log(`serving on port ${port}`);

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
    });
  } catch (err) {
    console.error("[server] Startup failed:", err);
    process.exit(1);
  }
})();