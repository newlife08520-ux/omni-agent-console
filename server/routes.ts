// Phase 106.37-urgent-diag temporary — remove after incident closed
import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import db from "./db";
import { superAdminOrDebugToken } from "./middlewares/auth.middleware";
import { getRedisClient } from "./redis-client";
import { WORKER_HEARTBEAT_KEY } from "./queue/ai-reply.queue";
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

  // ============================================================
  // Phase 106.37-urgent-diag temporary — remove after incident closed
  // GET /api/admin/urgent-diag?token=...
  // 一次撈齊：contact 4211 / 最近訊息 / ai_reply_deliveries / system_alerts (近 2h)
  //          / channels 完整列表 / recent_contacts / worker_heartbeat
  // 敏感值全遮（access_token 只露前 10 字 + 長度）
  // ============================================================
  app.get("/api/admin/urgent-diag", superAdminOrDebugToken, async (_req, res) => {
    const TARGET_CONTACT_ID = 4211;
    const result: Record<string, unknown> = {
      generated_at: new Date().toISOString(),
      phase: "106.37-urgent-diag",
      target_contact_id: TARGET_CONTACT_ID,
    };

    try {
      // 1) contact 4211 full row
      try {
        const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(TARGET_CONTACT_ID);
        result.contact_4211 = row ?? null;
      } catch (e: any) {
        result.contact_4211_error = String(e?.message ?? e);
      }

      // 2) contact 4211 最近 10 則 messages（sender_type, content 前 80, created_at）
      try {
        const rows = db
          .prepare(
            `SELECT id, sender_type, message_type, substr(content, 1, 80) AS content_head,
                    length(content) AS content_len, created_at
               FROM messages
              WHERE contact_id = ?
              ORDER BY id DESC
              LIMIT 10`
          )
          .all(TARGET_CONTACT_ID);
        result.recent_messages_4211 = rows;
      } catch (e: any) {
        result.recent_messages_4211_error = String(e?.message ?? e);
      }

      // 3) ai_reply_deliveries 最近 10 筆（含 4211 的）
      try {
        const recent = db
          .prepare(
            `SELECT delivery_key, platform, contact_id,
                    substr(merged_text, 1, 80) AS merged_text_head,
                    status, last_error, created_at, updated_at, sent_at
               FROM ai_reply_deliveries
              ORDER BY datetime(created_at) DESC
              LIMIT 10`
          )
          .all();
        const for4211 = db
          .prepare(
            `SELECT delivery_key, platform, contact_id,
                    substr(merged_text, 1, 80) AS merged_text_head,
                    status, last_error, created_at, updated_at, sent_at
               FROM ai_reply_deliveries
              WHERE contact_id = ?
              ORDER BY datetime(created_at) DESC
              LIMIT 10`
          )
          .all(TARGET_CONTACT_ID);
        result.ai_reply_deliveries = {
          recent_10: recent,
          for_contact_4211: for4211,
        };
      } catch (e: any) {
        result.ai_reply_deliveries_error = String(e?.message ?? e);
      }

      // 4) system_alerts 最近 2 小時（特別關注 timeout/sync/line_channel_ai 類）
      try {
        const all2h = db
          .prepare(
            `SELECT id, alert_type, details, brand_id, contact_id, created_at
               FROM system_alerts
              WHERE datetime(created_at) >= datetime('now', '-2 hours')
              ORDER BY datetime(created_at) DESC
              LIMIT 500`
          )
          .all() as Array<{
            id: number;
            alert_type: string;
            details: string;
            brand_id: number | null;
            contact_id: number | null;
            created_at: string;
          }>;

        const focusKeys = ["timeout", "sync", "line_channel_ai"];
        const focused = all2h.filter((r) =>
          focusKeys.some((k) => r.alert_type.toLowerCase().includes(k))
        );
        const byType: Record<string, number> = {};
        for (const r of all2h) {
          byType[r.alert_type] = (byType[r.alert_type] ?? 0) + 1;
        }
        result.system_alerts_2h = {
          window_hours: 2,
          total: all2h.length,
          by_type: byType,
          focused_count: focused.length,
          focused,
          all: all2h,
        };
      } catch (e: any) {
        result.system_alerts_2h_error = String(e?.message ?? e);
      }

      // 5) channels 完整列表（id, name, is_ai_enabled, token_prefix(前10), token_length）
      try {
        const rows = db
          .prepare(
            `SELECT id, brand_id, platform, channel_name, bot_id,
                    access_token, is_ai_enabled, is_active, created_at
               FROM channels
              ORDER BY id ASC`
          )
          .all() as Array<{
            id: number;
            brand_id: number;
            platform: string;
            channel_name: string;
            bot_id: string;
            access_token: string;
            is_ai_enabled: number;
            is_active: number;
            created_at: string;
          }>;
        result.channels = rows.map((c) => {
          const tok = c.access_token ?? "";
          return {
            id: c.id,
            brand_id: c.brand_id,
            platform: c.platform,
            name: c.channel_name,
            bot_id: c.bot_id,
            is_ai_enabled: c.is_ai_enabled,
            is_active: c.is_active,
            token_prefix: tok ? tok.slice(0, 10) : "",
            token_length: tok.length,
            created_at: c.created_at,
          };
        });
      } catch (e: any) {
        result.channels_error = String(e?.message ?? e);
      }

      // 6) recent_contacts 最新 10 筆
      try {
        const rows = db
          .prepare(
            `SELECT id, platform, brand_id, channel_id, display_name, status,
                    needs_human, last_message_at, created_at
               FROM contacts
              ORDER BY datetime(COALESCE(last_message_at, created_at)) DESC
              LIMIT 10`
          )
          .all();
        result.recent_contacts = rows;
      } catch (e: any) {
        result.recent_contacts_error = String(e?.message ?? e);
      }

      // 7) worker_heartbeat（alive, age_sec）
      try {
        const redisEnabled = !!process.env.REDIS_URL?.trim();
        let alive = false;
        let ageSec: number | null = null;
        let lastSeenAt: string | null = null;
        if (redisEnabled) {
          const redis = getRedisClient();
          if (redis) {
            const raw = await redis.get(WORKER_HEARTBEAT_KEY);
            if (raw) {
              try {
                const data = JSON.parse(raw) as { timestamp?: number };
                if (typeof data?.timestamp === "number") {
                  alive = true;
                  ageSec = Math.round((Date.now() - data.timestamp) / 1000);
                  lastSeenAt = new Date(data.timestamp).toISOString();
                }
              } catch (_e) {}
            }
          }
        }
        result.worker_heartbeat = {
          redis_enabled: redisEnabled,
          alive,
          age_sec: ageSec,
          last_seen_at: lastSeenAt,
        };
      } catch (e: any) {
        result.worker_heartbeat_error = String(e?.message ?? e);
      }

      return res.json(result);
    } catch (e: any) {
      result.fatal_error = String(e?.message ?? e);
      return res.status(500).json(result);
    }
  });

  return httpServer;
}
