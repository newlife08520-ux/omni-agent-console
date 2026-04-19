// Phase 106.25.4 temporary - remove after validation
import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import * as metaCommentsStorage from "./meta-comments-storage";
import { resolveCommentMetadata } from "./meta-comment-resolver";
import { SHORT_IMAGE_FALLBACK } from "./safe-after-sale-classifier";
import { runAutoExecution } from "./meta-comment-auto-execute";
import { getHandoffReplyForCustomer, HANDOFF_MANDATORY_OPENING } from "./phase2-output";
import { addAiReplyJob, enqueueDebouncedAiReply, getWorkerHeartbeatStatus } from "./queue/ai-reply.queue";
import { recordAutoReplyBlocked } from "./auto-reply-blocked";
import { handleLineWebhook } from "./controllers/line-webhook.controller";
import { handleFacebookWebhook, handleFacebookVerify, type FacebookWebhookDeps } from "./controllers/facebook-webhook.controller";
import { createToolExecutor } from "./services/tool-executor.service";
import { createAiReplyService } from "./services/ai-reply.service";
import { getTransferUnavailableSystemMessage as transferUnavailableSystemMessage } from "./transfer-unavailable-message";
import { getSuperLandingConfig, refreshPagesCache } from "./superlanding";
import * as assignment from "./assignment";
import { broadcastSSE } from "./services/sse.service";
import {
  pushLineMessage,
  sendFBMessage,
  replyToLine,
  downloadLineContent,
  downloadExternalImage,
  getLineTokenForContact,
} from "./services/messaging.service";
import { registerCoreRoutes } from "./routes/core.routes";
import { registerSettingsBrandsRoutes } from "./routes/settings-brands.routes";
import { registerMetaCommentsRoutes } from "./routes/meta-comments.routes";
import { registerContactsOrdersRoutes } from "./routes/contacts-orders.routes";
import { registerSandboxRoutes } from "./routes/sandbox.routes";
import db from "./db";
import { superAdminOrDebugToken } from "./middlewares/auth.middleware";

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "omnichannel_fb_verify_2024";


export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // 定時呼叫 fetchPages/refreshPagesCache 會佔用約 500MB RAM，僅在 ENABLE_SYNC=true 時啟用
  // 未設 ENABLE_SYNC 時不跑定時同步，請依需求設定 ENABLE_SYNC=true
  if (process.env.ENABLE_SYNC === "true") {
    setTimeout(() => {
      refreshPagesCache(getSuperLandingConfig()).catch(() => {});
    }, 30 * 1000);
    setInterval(() => {
      const freshConfig = getSuperLandingConfig();
      refreshPagesCache(freshConfig).catch(() => {});
    }, 60 * 60 * 1000);
  } else {
    console.log("[server] ENABLE_SYNC 非 true，不啟動定時同步；若需同步請設 ENABLE_SYNC=true");
  }

  registerCoreRoutes(app);

  /** 與 core.routes 內 inspect / drain / full-diag 同權限之一站式 admin（Phase 106.25.4 one-off） */
  app.get("/api/admin/brand-enable-ai", superAdminOrDebugToken, (req, res) => {
    try {
      const raw = req.query.brand_id;
      if (raw === undefined || String(raw).trim() === "") {
        return res.status(400).json({ error: "brand_id required" });
      }
      const brandId = parseInt(String(raw), 10);
      if (!Number.isFinite(brandId) || brandId < 1 || brandId > 2147483647) {
        return res.status(400).json({ error: "invalid brand_id" });
      }
      const before = db
        .prepare("SELECT id, name, is_ai_enabled FROM brands WHERE id = ?")
        .get(brandId) as { id: number; name: string; is_ai_enabled: number } | undefined;
      if (!before) {
        return res.status(404).json({ error: "brand not found" });
      }
      db.prepare("UPDATE brands SET is_ai_enabled = 1 WHERE id = ?").run(brandId);
      const after = db
        .prepare("SELECT id, name, is_ai_enabled FROM brands WHERE id = ?")
        .get(brandId) as { id: number; name: string; is_ai_enabled: number };
      const changed = before.is_ai_enabled !== after.is_ai_enabled;
      return res.json({
        note: "Phase 106.25.4 - one-off brand AI enable (remove after validation)",
        brand_id: brandId,
        before,
        after,
        changed,
      });
    } catch (e: unknown) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  registerSettingsBrandsRoutes(app);
  registerMetaCommentsRoutes(app);
  registerContactsOrdersRoutes(app);

  const toolExecutor = createToolExecutor({
    storage,
    pushLineMessage,
    sendFBMessage,
    broadcastSSE,
  });

  const { autoReplyWithAI, handleImageVisionFirst } = createAiReplyService({
    storage,
    broadcastSSE,
    pushLineMessage,
    sendFBMessage,
    toolExecutor,
    getTransferUnavailableSystemMessage: (reason) => transferUnavailableSystemMessage(storage, reason),
    getLineTokenForContact,
  });

  registerSandboxRoutes(app, { toolExecutor });

  app.post("/internal/run-ai-reply", (req, res) => {
    const secret = req.headers["x-internal-secret"];
    if (secret !== process.env.INTERNAL_API_SECRET) {
      console.error("[Loopback Error] 403 Forbidden: Secret mismatch");
      return res.status(403).json({ message: "Forbidden" });
    }
    const { contactId, message, channelToken, matchedBrandId, platform, enqueueTimestampMs } = req.body || {};
    if (!contactId || message == null) {
      console.error("[Loopback Error] 400 Bad Request: missing contactId or message");
      return res.status(400).json({ message: "contactId and message required" });
    }
    const contact = storage.getContact(Number(contactId));
    if (!contact) {
      console.error("[Loopback Error] 404 Not Found: contact not found contactId=" + contactId);
      return res.status(404).json({ message: "contact not found" });
    }
    const runStartMs = Date.now();
    const AI_REPLY_TIMEOUT_MS = 45_000;
    const AI_REPLY_TIMEOUT_FALLBACK_MSG =
      "不好意思，系統正在更新訂單資料，請稍候約 1 分鐘後再傳一次訊息給我喔～";
    console.log("[AI Latency] run-ai-reply start contactId=" + contactId);
    const enq =
      enqueueTimestampMs != null && !Number.isNaN(Number(enqueueTimestampMs))
        ? Number(enqueueTimestampMs)
        : undefined;

    let responded = false;
    const timeoutId = setTimeout(() => {
      if (responded) return;
      responded = true;
      const totalMs = Date.now() - runStartMs;
      console.error(
        "[AI Timeout] run-ai-reply timeout contactId=" + contactId + " after " + totalMs + "ms"
      );
      try {
        storage.createSystemAlert({
          alert_type: "ai_reply_timeout_soft",
          details: `severity:warning run-ai-reply timeout after ${AI_REPLY_TIMEOUT_MS}ms`,
          contact_id: Number(contactId),
          brand_id: contact.brand_id ?? undefined,
        });
        const token = (req.body?.channelToken as string | null | undefined) ?? null;
        const plat = String(contact.platform || "line");
        if (plat === "messenger" && token) {
          sendFBMessage(token, contact.platform_user_id, AI_REPLY_TIMEOUT_FALLBACK_MSG).catch(() => {});
        } else if (token) {
          pushLineMessage(contact.platform_user_id, [{ type: "text", text: AI_REPLY_TIMEOUT_FALLBACK_MSG }], token).catch(
            () => {}
          );
        } else {
          console.warn("[AI Timeout] no channelToken, skip customer fallback push contactId=" + contactId);
        }
      } catch (alertErr) {
        console.error("[AI Timeout] soft fallback failed:", alertErr);
      }
      res.status(504).json({ message: "AI reply timeout, soft fallback sent" });
    }, AI_REPLY_TIMEOUT_MS);

    autoReplyWithAI(
      contact, String(message), channelToken ?? undefined,
      matchedBrandId != null ? Number(matchedBrandId) : undefined,
      platform ? String(platform) : undefined,
      enq != null ? { enqueueTimestampMs: enq } : undefined
    )
      .then(() => {
        if (responded) return;
        responded = true;
        clearTimeout(timeoutId);
        const totalMs = Date.now() - runStartMs;
        console.log("[AI Latency] run-ai-reply done contactId=" + contactId + " in " + totalMs + "ms");
        res.status(200).json({ ok: true });
      })
      .catch((err) => {
        if (responded) return;
        responded = true;
        clearTimeout(timeoutId);
        const totalMs = Date.now() - runStartMs;
        console.error("[AI Latency] run-ai-reply failed contactId=" + contactId + " after " + totalMs + "ms", err);
        res.status(500).json({ message: err?.message || "Internal Server Error" });
      });
  });

  type UnavailableReason = "weekend" | "lunch" | "after_hours" | "all_paused" | null;
  const redisEnabled = !!process.env.REDIS_URL?.trim();
  const wrappedAddAiReplyJob = redisEnabled
    ? async (data: { contactId: number; message: string; channelToken: string | null; matchedBrandId?: number; platform?: string }) => {
        const status = await getWorkerHeartbeatStatus();
        if (status && !status.alive) {
          recordAutoReplyBlocked(storage, {
            reason: "blocked:worker_unavailable",
            contactId: data.contactId,
            platform: data.platform ?? "line",
            brandId: data.matchedBrandId,
            messageSummary: data.message ? data.message.slice(0, 80) + (data.message.length > 80 ? "?" : "") : undefined,
          });
          const contact = storage.getContact(data.contactId);
          if (contact) {
            console.log("[Queue] worker unavailable, fallback inline contactId=" + data.contactId);
            await autoReplyWithAI(contact, data.message, data.channelToken ?? undefined, data.matchedBrandId, data.platform);
          }
          return null;
        }
        return addAiReplyJob(data);
      }
    : addAiReplyJob;
  /** 一律經佇列路徑：有 REDIS_URL 時用 BullMQ debounce；否則每則直接 addAiReplyJob（無記憶體防抖） */
  const wrappedEnqueueDebouncedAiReply = async (
    platform: string,
    contactId: number,
    message: string,
    inboundEventId: string,
    channelToken: string | null,
    matchedBrandId?: number
  ): Promise<void> => {
    if (redisEnabled) {
      const status = await getWorkerHeartbeatStatus();
      if (status && !status.alive) {
        recordAutoReplyBlocked(storage, {
          reason: "blocked:worker_unavailable",
          contactId,
          platform,
          brandId: matchedBrandId,
          messageSummary: message ? message.slice(0, 80) + (message.length > 80 ? "?" : "") : undefined,
        });
        const contact = storage.getContact(contactId);
        if (contact) {
          console.log("[Queue] worker unavailable, fallback inline contactId=" + contactId);
          await autoReplyWithAI(contact, message, channelToken ?? undefined, matchedBrandId, platform);
        }
        return;
      }
      await enqueueDebouncedAiReply(platform, contactId, message, inboundEventId, channelToken, matchedBrandId);
      return;
    }
    const job = await wrappedAddAiReplyJob({
      contactId,
      message,
      channelToken,
      matchedBrandId,
      platform,
    });
    if (job == null) {
      const contact = storage.getContact(contactId);
      if (contact) {
        await autoReplyWithAI(contact, message, channelToken ?? undefined, matchedBrandId, platform);
      }
    }
  };
  const fbWebhookDeps: FacebookWebhookDeps = {
    storage,
    broadcastSSE,
    sendFBMessage,
    downloadExternalImage,
    handleImageVisionFirst,
    enqueueDebouncedAiReply: wrappedEnqueueDebouncedAiReply,
    addAiReplyJob: wrappedAddAiReplyJob,
    getHandoffReplyForCustomer: (opening: string, unavailableReason?: string | null) => getHandoffReplyForCustomer(opening, (unavailableReason ?? null) as UnavailableReason),
    HANDOFF_MANDATORY_OPENING,
    SHORT_IMAGE_FALLBACK,
    getUnavailableReason: () => (assignment.getUnavailableReason() ?? undefined) as string | undefined,
    resolveCommentMetadata,
    metaCommentsStorage,
    runAutoExecution,
    FB_VERIFY_TOKEN,
  };

  app.post("/api/webhook/line", (req, res) => {
    handleLineWebhook(req, res, {
      storage,
      broadcastSSE,
      pushLineMessage,
      replyToLine,
      downloadLineContent,
      addAiReplyJob: wrappedAddAiReplyJob,
      enqueueDebouncedAiReply: wrappedEnqueueDebouncedAiReply,
      autoReplyWithAI,
      handleImageVisionFirst,
      getHandoffReplyForCustomer: (opening: string, unavailableReason?: string | null) => getHandoffReplyForCustomer(opening, (unavailableReason ?? null) as UnavailableReason),
      HANDOFF_MANDATORY_OPENING,
      getUnavailableReason: () => (assignment.getUnavailableReason() ?? undefined) as string | undefined,
    });
  });

  app.get("/api/webhook/facebook", (req, res) => handleFacebookVerify(req, res, fbWebhookDeps));
  app.post("/api/webhook/facebook", (req, res) => handleFacebookWebhook(req, res, fbWebhookDeps));

  return httpServer;
}
