import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "../storage";
import * as metaCommentsStorage from "../meta-comments-storage";
import { resolveCommentMetadata } from "../meta-comment-resolver";
import { replyToComment, hideComment } from "../meta-facebook-comment-api";
import { checkHighRiskByRule, checkLineRedirectByRule, checkSafeConfirmByRule, COMFORT_MESSAGE } from "../meta-comment-guardrail";
import {
  classifyMessageForSafeAfterSale,
  FALLBACK_AFTER_SALE_LINE_LABEL,
  SAFE_IMAGE_ONLY_REPLY,
  SHORT_IMAGE_FALLBACK,
  shouldEscalateImageSupplement,
  IMAGE_SUPPLEMENT_ESCALATE_MESSAGE,
} from "../safe-after-sale-classifier";
import { runAutoExecution, computeMainStatus } from "../meta-comment-auto-execute";
import * as riskRules from "../meta-comment-risk-rules";
import { resolveConversationState, isHumanRequestMessage, isAlreadyProvidedMessage, isLinkRequestMessage, isLinkRequestCorrectionMessage, ORDER_LOOKUP_PATTERNS, looksLikeOrderNumber, isAiHandlableIntent } from "../conversation-state-resolver";
import { buildReplyPlan, shouldNotLeadWithOrderLookup, isAftersalesComfortFirst, type ReplyPlanMode } from "../reply-plan-builder";
import { enforceOutputGuard, HANDOFF_MANDATORY_OPENING, buildHandoffReply, getHandoffReplyForCustomer } from "../phase2-output";
import { runPostGenerationGuard, isModeNoPromo, runOfficialChannelGuard, runGlobalPlatformGuard } from "../content-guard";
import { recordGuardHit, getGuardStats } from "../content-guard-stats";
import { shouldHandoffDueToAwkwardOrRepeat } from "../awkward-repeat-handoff";
import { isRatingEligible } from "../rating-eligibility";
import db from "../db";
import { fetchOrders, lookupOrderById, lookupOrdersByDateAndFilter, fetchPages, lookupOrdersByPageAndPhone, ensurePagesCacheLoaded, refreshPagesCache, getCachedPages, getCachedPagesAge, buildProductCatalogPrompt, getSuperLandingConfig } from "../superlanding";
import type { SuperLandingConfig } from "../superlanding";
import type { OrderInfo, Contact, ContactStatus, IssueType, MetaCommentTemplate, MetaComment } from "@shared/schema";
import {
  unifiedLookupById,
  unifiedLookupByProductAndPhone,
  unifiedLookupByDateAndContact,
  unifiedLookupByPhoneGlobal,
  getUnifiedStatusLabel,
  getPaymentInterpretationForAI,
  shouldPreferShoplineLookup,
} from "../order-service";
import { shouldBypassLocalPhoneIndex } from "../order-lookup-policy";
import { packDeterministicMultiOrderToolResult } from "../order-multi-renderer";
import { getOrdersByPhone, lookupOrdersByProductAliasAndPhoneLocal, normalizePhone } from "../order-index";
import { tryOrderFastPath } from "../order-fast-path";
import {
  formatOrderOnePage,
  formatLocalOnlyCandidateSummary,
  payKindForOrder,
  sourceChannelLabel,
  buildDeterministicFollowUpReply,
} from "../order-reply-utils";
import { normalizeCustomerFacingOrderReply } from "../customer-reply-normalizer";
import { packDeterministicSingleOrderToolResult, buildSingleOrderCustomerReply } from "../order-single-renderer";
import { isValidOrderDeterministicPayload, orderDeterministicContractFields } from "../deterministic-order-contract";
import { orderFeatureFlags } from "../order-feature-flags";
import { buildActiveOrderContextFromOrder } from "../order-active-context";
import {
  sortCandidatesNewestFirst,
  pickLatestCandidate,
  pickEarliestCandidate,
  pickCandidateByOrderDate,
  filterCandidatesBySource,
} from "../order-multi-selector";
import { lookupShoplineOrdersByPhoneExact, syncShoplineProductsToCatalog } from "../shopline";
import * as assignment from "../assignment";
import {
  detectIntentLevel,
  classifyOrderNumber,
  computeCasePriority,
  suggestTagsFromContent,
} from "../intent-and-order";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import * as XLSX from "xlsx";
import { addAiReplyJob, enqueueDebouncedAiReply, WORKER_HEARTBEAT_KEY, getWorkerHeartbeatStatus, getQueueJobCounts } from "../queue/ai-reply.queue";
import { getRedisClient } from "../redis-client";
import { recordAutoReplyBlocked } from "../auto-reply-blocked";
import { handleLineWebhook } from "../controllers/line-webhook.controller";
import { handleFacebookWebhook, handleFacebookVerify, type FacebookWebhookDeps } from "../controllers/facebook-webhook.controller";
import { applyHandoff, normalizeHandoffReason } from "../services/handoff";
import { ANALYTICS_CONCERN_KEYWORD_GROUPS } from "../analytics-concern-keywords";
import { assembleEnrichedSystemPrompt } from "../services/prompt-builder";
import { createToolExecutor } from "../services/tool-executor.service";
import {
  createAiReplyService,
  detectHighRisk,
  getEnrichedSystemPrompt,
} from "../services/ai-reply.service";
import { getTransferUnavailableSystemMessage as transferUnavailableSystemMessage } from "../transfer-unavailable-message";
import { orderLookupTools, humanHandoffTools, imageTools } from "../openai-tools";
import { resolveModel, resolveOpenAIModel } from "../openai-model";

import OpenAI from "openai";
import { parseFileContent, isImageFile } from "../file-parser";
import { authMiddleware, superAdminOnly, managerOrAbove, parseIdParam } from "../middlewares/auth.middleware";
import { broadcastSSE, registerSseRoutes } from "../services/sse.service";
import {
  upload,
  imageAssetUpload,
  chatUpload,
  sandboxUpload,
  avatarUpload,
  uploadDir,
  imageAssetsDir,
  fixMulterFilename,
  stripBOM,
} from "../middlewares/upload.middleware";
import { maskSensitiveInfo } from "../utils/mask-sensitive-info";
import {
  getLineTokenForContact,
  getFbTokenForContact,
  replyToLine,
  pushLineMessage,
  sendFBMessage,
  sendRatingFlexMessage,
  downloadLineContent,
  downloadExternalImage,
} from "../services/messaging.service";

const HOME_SHIPPING_KEYWORDS = ["宅酈", "宅酈到府", "到府", "home", "delivery"];
/** 超商/門市關鍵字（不含宅配） */
const PAYMENT_FAIL_STATUS_KW = ["失敗", "未成功", "付款失敗"];
const PAYMENT_FAIL_METHOD_KW = ["失敗", "未付"];
const PAYMENT_SUCCESS_STATUS_KW = ["已確認", "待出貨", "已出貨", "已完成"];
const PAYMENT_PENDING_STATUS_KW = ["待付款", "未付款", "確認中", "新訂單"];
const FULFILLMENT_SHIPPED_KW = ["已出貨", "已送達"];
const FULFILLMENT_PENDING_SHIP_KW = ["新訂單", "待出貨", "處理中"];
const FULFILLMENT_CANCELED_KW = ["已取消"];
const FULFILLMENT_PROCESSING_KW = ["已確認", "待出貨", "出貨中"];
const FULFILLMENT_NEW_KW = ["新訂單"];

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "omnichannel_fb_verify_2024";

const productCatalogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function registerCoreRoutes(app: Express): void {
    app.get("/api/health", (_req, res) => {
      res.json({ ok: true });
    });

    app.get("/api/debug/status", (_req, res) => {
      try {
        const allChannels = storage.getChannels();
        const allBrands = storage.getBrands();
        const allContacts = storage.getContacts();
        const contactCount = allContacts.length;
        const recentContacts = allContacts
          .sort((a: any, b: any) => new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime())
          .slice(0, 8)
          .map((c: any) => ({
            id: c.id,
            display_name: c.display_name,
            platform: c.platform,
            brand_id: c.brand_id,
            last_message: c.last_message?.substring(0, 40),
            last_message_at: c.last_message_at,
          }));
        const globalToken = storage.getSetting("line_channel_access_token");
        const globalSecret = storage.getSetting("line_channel_secret");
        const testMode = storage.getSetting("test_mode");
        const metaPagesList = metaCommentsStorage.getMetaPageSettingsList();
        return res.json({
          timestamp: new Date().toISOString(),
          code_version: "v4-bulletproof",
          test_mode: testMode,
          redis_enabled: !!process.env.REDIS_URL?.trim(),
          internal_api_secret_configured: !!process.env.INTERNAL_API_SECRET?.trim(),
          worker_mode_expected: !!process.env.REDIS_URL?.trim(),
          meta_page_settings_summary: {
            total: metaPagesList.length,
            page_ids: metaPagesList.map((p: { page_id: string }) => p.page_id),
          },
          brands: allBrands.map(b => ({ id: b.id, name: b.name, slug: b.slug })),
          channels: allChannels.map(c => ({
            id: c.id,
            brand_id: c.brand_id,
            brand_name: c.brand_name,
            platform: c.platform,
            channel_name: c.channel_name,
            bot_id: c.bot_id || "(EMPTY)",
            has_token: !!(c.access_token),
            has_secret: !!(c.channel_secret),
            is_active: c.is_active,
            is_ai_enabled: c.is_ai_enabled,
          })),
          global_settings: {
            has_token: !!globalToken,
            has_secret: !!globalSecret,
          },
          total_contacts: contactCount,
          recent_contacts: recentContacts,
        });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/debug/runtime", async (_req, res) => {
      try {
        const testMode = storage.getSetting("test_mode");
        const allChannels = storage.getChannels();
        const metaPagesList = metaCommentsStorage.getMetaPageSettingsList();
        let channelActivity: Record<number, { last_inbound_at: string | null; last_outbound_at: string | null }> = {};
        try {
          const rows = db.prepare(`
            SELECT c.channel_id,
              MAX(CASE WHEN m.sender_type = 'user' THEN m.created_at END) AS last_inbound_at,
              MAX(CASE WHEN m.sender_type IN ('ai','admin') THEN m.created_at END) AS last_outbound_at
            FROM messages m
            JOIN contacts c ON m.contact_id = c.id
            WHERE c.channel_id IS NOT NULL
            GROUP BY c.channel_id
          `).all() as { channel_id: number; last_inbound_at: string | null; last_outbound_at: string | null }[];
          for (const r of rows) {
            channelActivity[r.channel_id] = { last_inbound_at: r.last_inbound_at ?? null, last_outbound_at: r.last_outbound_at ?? null };
          }
        } catch (_e) {}
        const channels = allChannels.map(c => {
          const act = channelActivity[c.id];
          return {
            id: c.id,
            brand_id: c.brand_id,
            brand_name: c.brand_name,
            platform: c.platform,
            channel_name: c.channel_name,
            bot_id: c.bot_id || "(EMPTY)",
            is_active: c.is_active,
            is_ai_enabled: c.is_ai_enabled,
            has_token: !!(c.access_token?.trim()),
            has_secret: !!(c.channel_secret?.trim()),
            last_inbound_at: act?.last_inbound_at ?? null,
            last_outbound_at: act?.last_outbound_at ?? null,
          };
        });
        const meta_pages = metaPagesList.map((p: { id: number; page_id: string; page_name: string | null; brand_id: number; auto_reply_enabled: number; auto_hide_sensitive: number; auto_route_line_enabled: number }) => ({
          id: p.id,
          page_id: p.page_id,
          page_name: p.page_name,
          brand_id: p.brand_id,
          auto_reply_enabled: p.auto_reply_enabled,
          auto_hide_sensitive: p.auto_hide_sensitive,
          auto_route_line_enabled: p.auto_route_line_enabled,
          has_channel_token: !!allChannels.find(ch => ch.bot_id === p.page_id)?.access_token?.trim(),
        }));
        const redisEnabled = !!process.env.REDIS_URL?.trim();
        let worker_alive = false;
        let worker_last_seen_at: string | null = null;
        let worker_heartbeat_age_sec: number | null = null;
        const redis = getRedisClient();
        if (redis && redisEnabled) {
          try {
            const raw = await redis.get(WORKER_HEARTBEAT_KEY);
            if (raw) {
              const data = JSON.parse(raw) as { timestamp?: number };
              const ts = data?.timestamp;
              if (typeof ts === "number") {
                worker_alive = true;
                worker_last_seen_at = new Date(ts).toISOString();
                worker_heartbeat_age_sec = Math.round((Date.now() - ts) / 1000);
              }
            }
          } catch (_e) {}
        }
        const queue_mode = redisEnabled ? "redis_worker" : "inline";
        const degraded_mode = redisEnabled && !worker_alive;
        let queue_waiting_count: number | null = null;
        let queue_active_count: number | null = null;
        let queue_delayed_count: number | null = null;
        let queue_failed_count: number | null = null;
        const queueCounts = await getQueueJobCounts();
        if (queueCounts) {
          queue_waiting_count = queueCounts.waiting;
          queue_active_count = queueCounts.active;
          queue_delayed_count = queueCounts.delayed;
          queue_failed_count = queueCounts.failed;
        }
        let last_blocked_reason: string | null = null;
        let last_blocked_at: string | null = null;
        let last_successful_ai_reply_at: string | null = null;
        try {
          const blockedRow = db.prepare("SELECT details, created_at FROM system_alerts WHERE alert_type = 'auto_reply_blocked' ORDER BY created_at DESC LIMIT 1").get() as { details?: string; created_at?: string } | undefined;
          if (blockedRow?.details != null) {
            last_blocked_reason = blockedRow.details.split(/\s/)[0] ?? null;
            last_blocked_at = blockedRow.created_at ?? null;
          }
          const sentRow = db.prepare("SELECT MAX(sent_at) AS t FROM ai_reply_deliveries WHERE status = 'sent' AND sent_at IS NOT NULL").get() as { t: string | null } | undefined;
          if (sentRow?.t) last_successful_ai_reply_at = sentRow.t;
        } catch (_e) {}
        return res.json({
          timestamp: new Date().toISOString(),
          node_env: process.env.NODE_ENV ?? "development",
          test_mode: testMode,
          redis_enabled: redisEnabled,
          internal_api_secret_configured: !!process.env.INTERNAL_API_SECRET?.trim(),
          internal_api_url: process.env.INTERNAL_API_URL ? "(set)" : "",
          worker_mode_expected: redisEnabled,
          worker_alive,
          worker_last_seen_at,
          worker_heartbeat_age_sec,
          queue_mode,
          degraded_mode,
          queue_waiting_count,
          queue_active_count,
          queue_delayed_count,
          queue_failed_count,
          last_blocked_reason,
          last_blocked_at,
          last_successful_ai_reply_at,
          channels,
          meta_pages,
        });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/debug/handoff-alerts", (req: any, res) => {
      try {
        const reason = req.query.reason as string | undefined;
        const source = req.query.source as string | undefined;
        const contact_id = req.query.contact_id != null ? parseInt(String(req.query.contact_id)) : undefined;
        const since = req.query.since as string | undefined;
        const until = req.query.until as string | undefined;
        let rows = db.prepare("SELECT id, contact_id, brand_id, details, created_at FROM system_alerts WHERE alert_type = 'transfer' ORDER BY created_at DESC LIMIT 500").all() as { id: number; contact_id: number | null; brand_id: number | null; details: string; created_at: string }[];
        if (contact_id != null) rows = rows.filter(r => r.contact_id === contact_id);
        if (since) rows = rows.filter(r => r.created_at >= since);
        if (until) rows = rows.filter(r => r.created_at <= until);
        const parsed = rows.map(r => {
          let payload: { source?: string; reason?: string; reason_detail?: string | null; contact_id?: number; previous_status?: string | null; next_status?: string } = {};
          try {
            payload = JSON.parse(r.details) as typeof payload;
          } catch (_e) {}
          return {
            id: r.id,
            contact_id: r.contact_id,
            brand_id: r.brand_id,
            created_at: r.created_at,
            source: payload.source ?? null,
            reason: payload.reason ?? null,
            reason_detail: payload.reason_detail ?? null,
            previous_status: payload.previous_status ?? null,
            next_status: payload.next_status ?? null,
          };
        });
        let filtered = parsed;
        if (reason) filtered = filtered.filter(p => p.reason === reason);
        if (source) filtered = filtered.filter(p => p.source === source);
        return res.json({ handoff_alerts: filtered });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/debug/prompt-preview", async (req: any, res) => {
      try {
        const brandId = req.query.brandId != null ? parseInt(String(req.query.brandId)) : undefined;
        const result = await assembleEnrichedSystemPrompt(brandId);
        const { full_prompt, sections: sectionsMeta, includes } = result;
        return res.json({
          brand_id: brandId ?? null,
          model: resolveOpenAIModel(),
          full_prompt,
          total_prompt_length: full_prompt.length,
          sections: sectionsMeta.map(s => ({ key: s.key, title: s.title, length: s.length })),
          includes: {
            catalog: includes.catalog,
            marketing: includes.marketing,
            knowledge: includes.knowledge,
            image: includes.image,
            global_policy: includes.global_policy,
            brand_persona: includes.brand_persona,
            human_hours: includes.human_hours,
            flow_principles: includes.flow_principles,
          },
        });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    registerSseRoutes(app);

    app.post("/api/auth/login", (req, res) => {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ success: false, message: "????????" });
      }
      const user = storage.authenticateUser(username, password);
      if (user) {
        const s = (req as any).session;
        s.authenticated = true;
        s.userId = user.id;
        s.userRole = user.role;
        s.username = user.username;
        s.displayName = user.display_name;
        if (user.role === "cs_agent") {
          storage.updateUserOnline(user.id, 1, 1);
        }
        return res.json({
          success: true,
          message: "????",
          user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        });
      }
      return res.status(401).json({ success: false, message: "???????" });
    });

    /** 部署驗證用：無需登入 */
    app.get("/api/version", (_req, res) => {
      const buildTime = new Date().toISOString();
      res.json({
        version: "phase2-shopline-sync",
        build_time: buildTime,
        features: [
          "gemini-3.1-pro",
          "rag-lite-knowledge",
          "marketing-rules-active",
          "product-catalog",
          "recommend-products-tool",
          "excel-import",
          "shopline-product-sync",
        ],
      });
    });

    app.post("/api/admin/sync-products", authMiddleware, async (_req, res) => {
      try {
        const brands = db.prepare("SELECT id, shopline_store_domain, shopline_api_token FROM brands").all() as {
          id: number;
          shopline_store_domain: string;
          shopline_api_token: string;
        }[];

        const results: unknown[] = [];
        for (const brand of brands) {
          const config = { storeDomain: brand.shopline_store_domain, apiToken: brand.shopline_api_token };
          if (!String(config.storeDomain || "").trim() || !String(config.apiToken || "").trim()) {
            results.push({ brand_id: brand.id, status: "skipped", reason: "missing config" });
            continue;
          }
          try {
            const r = await syncShoplineProductsToCatalog(brand.id, config);
            results.push({ brand_id: brand.id, status: "ok", ...r });
          } catch (e) {
            results.push({ brand_id: brand.id, status: "error", error: (e as Error).message });
          }
        }

        return res.json({ ok: true, results });
      } catch (e) {
        return res.status(500).json({ error: (e as Error).message });
      }
    });

    app.post(
      "/api/admin/products/:brandId/upload-excel",
      authMiddleware,
      superAdminOnly,
      productCatalogUpload.single("file"),
      (req, res) => {
        const brandId = parseInt(String(req.params.brandId), 10);
        if (!Number.isFinite(brandId) || brandId < 1) {
          return res.status(400).json({ error: "無效品牌 ID" });
        }
        if (!(req as any).file) return res.status(400).json({ error: "請上傳檔案" });

        try {
          const fileBuf = (req as any).file.buffer as Buffer;
          const workbook = XLSX.read(fileBuf, { type: "buffer" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

          let imported = 0;
          let currentProduct: Record<string, string> | null = null;

          for (let i = 1; i < rows.length; i++) {
            const row = rows[i] as unknown[];
            const name = String(row[0] ?? "").trim();
            const keywords = String(row[1] ?? "").trim();
            const prefix = String(row[2] ?? "").trim();
            const pageId = String(row[3] ?? "").trim().replace(/\.0$/, "");
            const url = String(row[4] ?? "").trim();
            const faqLine = String(row[5] ?? "").trim();

            if (name) {
              if (currentProduct) {
                storage.upsertProduct(brandId, currentProduct);
                imported++;
              }
              currentProduct = {
                product_id: prefix || `p-${i}`,
                title: name,
                keywords,
                order_prefix: prefix,
                page_id: pageId,
                url: url.startsWith("http") ? url : "",
                description_short: faqLine.replace(/^特色[：:]?\s*/, ""),
                faq: faqLine,
              };
            } else if (faqLine && currentProduct) {
              if (/^FAQ/i.test(faqLine)) {
                currentProduct.faq = (currentProduct.faq || "") + "\n" + faqLine;
              } else {
                currentProduct.faq = (currentProduct.faq || "") + "\n" + faqLine;
                currentProduct.description_short = (currentProduct.description_short || "") + " " + faqLine;
              }
            }
          }
          if (currentProduct) {
            storage.upsertProduct(brandId, currentProduct);
            imported++;
          }

          return res.json({ ok: true, imported, message: `成功匯入 ${imported} 個商品` });
        } catch (e) {
          console.error("[product-upload] error:", e);
          return res.status(500).json({ error: (e as Error).message });
        }
      }
    );

    app.get("/api/admin/products/:brandId", authMiddleware, (req, res) => {
      const brandId = parseIdParam(req.params.brandId);
      if (brandId == null) return res.status(400).json({ error: "無效品牌 ID" });
      const products = storage.getProductCatalog(brandId);
      return res.json({ ok: true, total: products.length, products });
    });

    app.get("/api/admin/products/:brandId/search", authMiddleware, (req, res) => {
      const brandId = parseIdParam(req.params.brandId);
      if (brandId == null) return res.status(400).json({ error: "無效品牌 ID" });
      const keyword = String(req.query.q || "");
      const products = storage.searchProducts(brandId, keyword);
      return res.json({ ok: true, products });
    });

    app.post("/api/admin/products/:brandId/bulk", authMiddleware, superAdminOnly, (req, res) => {
      const brandId = parseInt(String(req.params.brandId), 10);
      if (!Number.isFinite(brandId) || brandId < 1) {
        return res.status(400).json({ error: "無效品牌 ID" });
      }
      const products = (req.body as { products?: unknown })?.products;
      if (!Array.isArray(products)) return res.status(400).json({ error: "需要 products 陣列" });
      let count = 0;
      for (const p of products) {
        if (p && typeof p === "object" && (p as any).product_id && (p as any).title) {
          storage.upsertProduct(brandId, p as Record<string, unknown>);
          count++;
        }
      }
      return res.json({ ok: true, imported: count });
    });

    app.get("/api/auth/check", (req, res) => {
      const s = (req as any).session;
      if (s?.authenticated === true) {
        return res.json({
          authenticated: true,
          user: { id: s.userId, username: s.username, display_name: s.displayName, role: s.userRole },
        });
      }
      return res.json({ authenticated: false });
    });

    app.post("/api/auth/logout", (req, res) => {
      const s = (req as any).session;
      const userId = s?.userId;
      const role = s?.userRole ?? s?.role;
      if (userId != null && role === "cs_agent") {
        storage.updateUserOnline(userId, 0);
      }
      s.authenticated = false;
      s.userId = null;
      s.userRole = null;
      s.username = null;
      s.displayName = null;
      return res.json({ success: true });
    });

    app.post("/api/admin/refresh-profiles", authMiddleware, superAdminOnly, async (_req, res) => {
      try {
        const contacts = storage.getContacts();
        const lineContacts = contacts.filter(c => c.platform === "line" && c.platform_user_id && c.platform_user_id !== "unknown");
        const fbContacts = contacts.filter(c => c.platform === "messenger" && c.platform_user_id);
        let lineUpdated = 0;
        let lineFailed = 0;
        for (const contact of lineContacts) {
          const token = getLineTokenForContact(contact);
          if (!token) { lineFailed++; continue; }
          try {
            const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${contact.platform_user_id}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (profileRes.ok) {
              const profile = await profileRes.json() as { displayName?: string; pictureUrl?: string };
              if (profile.displayName || profile.pictureUrl) {
                const displayName = profile.displayName || (contact.display_name ?? "LINE??");
                const avatarUrl = profile.pictureUrl ?? contact.avatar_url ?? null;
                storage.updateContactProfile(contact.id, displayName, avatarUrl);
                lineUpdated++;
              }
            } else {
              lineFailed++;
            }
            await new Promise(r => setTimeout(r, 100));
          } catch (_e) {
            lineFailed++;
          }
        }
        let fbUpdated = 0;
        let fbFailed = 0;
        for (const contact of fbContacts) {
          const token = getFbTokenForContact(contact);
          if (!token) { fbFailed++; continue; }
          try {
            const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(contact.platform_user_id)}?fields=first_name,last_name,name,picture.type(large)&access_token=${encodeURIComponent(token)}`;
            const profileRes = await fetch(url);
            if (profileRes.ok) {
              const profile = await profileRes.json() as { first_name?: string; last_name?: string; name?: string; picture?: { data?: { url?: string } } };
              const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim()
                || (typeof profile.name === "string" ? profile.name.trim() : undefined);
              const avatarUrl = profile.picture?.data?.url || null;
              if (fullName || avatarUrl) {
                storage.updateContactProfile(contact.id, fullName || (contact.display_name ?? "FB??"), avatarUrl ?? contact.avatar_url ?? null);
                fbUpdated++;
              }
            } else {
              fbFailed++;
            }
            await new Promise(r => setTimeout(r, 100));
          } catch (_e) {
            fbFailed++;
          }
        }
        return res.json({
          success: true,
          line: { total: lineContacts.length, updated: lineUpdated, failed: lineFailed },
          facebook: { total: fbContacts.length, updated: fbUpdated, failed: fbFailed },
        });
      } catch (err: any) {
        return res.status(500).json({ success: false, message: err.message });
      }
    });

    app.get("/api/admin/brands/:brandId/form-urls", authMiddleware, (req, res) => {
      const brandId = parseIdParam(req.params.brandId);
      if (brandId == null) return res.status(400).json({ error: "無效品牌 ID" });
      const urls = storage.getBrandFormUrls(brandId);
      res.json({ ok: true, ...urls });
    });

    app.put("/api/admin/brands/:brandId/form-urls", authMiddleware, (req: any, res) => {
      if (!req.session?.userRole || req.session.userRole !== "super_admin") {
        return res.status(403).json({ error: "forbidden" });
      }
      const brandId = parseIdParam(req.params.brandId);
      if (brandId == null) return res.status(400).json({ error: "無效品牌 ID" });
      storage.updateBrandFormUrls(brandId, req.body || {});
      res.json({ ok: true });
    });

    /** super_admin：檢視 DB 內 Global / 品牌 system_prompt 長度與預覽（部署驗收用） */
    app.get("/api/admin/prompt-status", authMiddleware, (req: any, res) => {
      if (!req.session?.userRole || req.session.userRole !== "super_admin") {
        return res.status(403).json({ error: "forbidden" });
      }
      try {
        const globalPrompt = storage.getSetting("system_prompt") || "";
        const brand1Prompt = db.prepare("SELECT system_prompt FROM brands WHERE id = 1").get() as
          | { system_prompt?: string | null }
          | undefined;
        const brand2Prompt = db.prepare("SELECT system_prompt FROM brands WHERE id = 2").get() as
          | { system_prompt?: string | null }
          | undefined;
        const g1 = brand1Prompt?.system_prompt ?? "";
        const g2 = brand2Prompt?.system_prompt ?? "";
        return res.json({
          ok: true,
          global: {
            length: globalPrompt.length,
            preview_start: globalPrompt.substring(0, 300),
            preview_end: globalPrompt.substring(Math.max(0, globalPrompt.length - 300)),
          },
          brand_1: {
            length: g1.length,
            preview_start: g1.substring(0, 300),
          },
          brand_2: {
            length: g2.length,
            preview_start: g2.substring(0, 300),
          },
        });
      } catch (e) {
        return res.status(500).json({ error: (e as Error).message });
      }
    });

    /** super_admin：從 docs/persona 強制寫回 system_prompt（與啟動延遲同步同源檔案） */
    app.post("/api/admin/force-sync-prompt", authMiddleware, (req: any, res) => {
      if (!req.session?.userRole || req.session.userRole !== "super_admin") {
        return res.status(403).json({ error: "forbidden" });
      }
      try {
        const root = process.cwd();
        const globalPrompt = fs
          .readFileSync(path.join(root, "docs/persona/PHASE97_MASTER_SLIM.txt"), "utf-8")
          .trim();
        const brand1Prompt = fs
          .readFileSync(path.join(root, "docs/persona/brands/brand_1_phase97_slim.txt"), "utf-8")
          .trim();
        const brand2Prompt = fs
          .readFileSync(path.join(root, "docs/persona/brands/brand_2_phase97_slim.txt"), "utf-8")
          .trim();
        storage.setSetting("system_prompt", globalPrompt);
        db.prepare("UPDATE brands SET system_prompt = ? WHERE id = 1").run(brand1Prompt);
        db.prepare("UPDATE brands SET system_prompt = ? WHERE id = 2").run(brand2Prompt);
        return res.json({
          ok: true,
          synced: {
            global: globalPrompt.length,
            brand_1: brand1Prompt.length,
            brand_2: brand2Prompt.length,
          },
        });
      } catch (e) {
        return res.status(500).json({ error: (e as Error).message });
      }
    });

    /** super_admin：手動觸發訂單同步（背景執行，不等待完成） */
    app.post("/api/admin/sync-orders", authMiddleware, superAdminOnly, async (_req, res) => {
      try {
        const { runOrderSync } = await import("../scripts/sync-orders-normalized");
        runOrderSync({ days: 30 })
          .then((r) => console.log("[ManualSync] 完成:", r))
          .catch((e) => console.error("[ManualSync] 失敗:", e));
        return res.json({ ok: true, message: "同步已啟動（背景執行），約需 10-15 分鐘" });
      } catch (e) {
        return res.status(500).json({ error: (e as Error).message });
      }
    });

    /** super_admin：從 docs/persona 同步 Global + 品牌 system_prompt 至 DB（路徑用 process.cwd，避免 CJS bundle 下 import.meta 不可用） */
    app.post("/api/admin/sync-prompts", async (req: any, res) => {
      if (!req.session?.userRole || req.session.userRole !== "super_admin") {
        return res.status(403).json({ error: "forbidden" });
      }
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

        const b1row = db.prepare("SELECT shopline_store_domain FROM brands WHERE id = 1").get() as {
          shopline_store_domain?: string | null;
        } | undefined;
        let shoplineDomainOut = b1row?.shopline_store_domain?.trim() ?? "";
        if (!shoplineDomainOut) {
          db.prepare("UPDATE brands SET shopline_store_domain = ? WHERE id = 1").run(
            "enjoythelife.shoplineapp.com"
          );
          console.log("[sync-prompts] 品牌 1 shopline_store_domain 已補設");
          shoplineDomainOut = "enjoythelife.shoplineapp.com";
        }

        return res.json({
          ok: true,
          global: globalPrompt.length + " chars",
          brand1: b1.length + " chars",
          brand2: b2.length + " chars",
          shopline_domain: shoplineDomainOut || "已補設",
        });
      } catch (e) {
        console.error("[sync-prompts] error:", e);
        return res.status(500).json({ error: (e as Error).message });
      }
    });

    app.get("/api/debug/runtime-flags", authMiddleware, (_req: any, res) => {
      try {
        return res.json({
          timestamp: new Date().toISOString(),
          server_flags: {
            ENABLE_ORDER_FAST_PATH: orderFeatureFlags.orderFastPath,
            CONSERVATIVE_SINGLE_ORDER: orderFeatureFlags.conservativeSingleOrder,
            ENABLE_ORDER_FINAL_NORMALIZER: orderFeatureFlags.orderFinalNormalizer,
            ENABLE_GENERIC_DETERMINISTIC_ORDER: orderFeatureFlags.genericDeterministicOrder,
            ENABLE_ORDER_ULTRA_LITE_PROMPT: orderFeatureFlags.orderUltraLitePrompt,
            ENABLE_ORDER_LATENCY_V2: orderFeatureFlags.orderLatencyV2,
          },
          note: "前端 SSE/輪詢由 build-time VITE_DISABLE_SSE 決定，此 API 僅回傳 server 端旗標。",
        });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/internal/guard-stats", authMiddleware, (req: any, res) => {
      if (!["super_admin", "marketing_manager"].includes(req.session?.userRole)) {
        return res.status(403).json({ message: "????" });
      }
      return res.json(getGuardStats());
    });

    app.get("/api/health/status", authMiddleware, async (_req, res) => {
      const results: Record<string, { status: "ok" | "error" | "unconfigured"; message: string }> = {};

      const apiKey = storage.getSetting("openai_api_key");
      if (!apiKey || apiKey.trim() === "") {
        results.openai = { status: "unconfigured", message: "???? API ??" };
      } else {
        try {
          const openai = new OpenAI({ apiKey });
          const rmHealth = resolveModel();
          const openaiPingModel = rmHealth.provider === "openai" ? rmHealth.model : "gpt-4o-mini";
          await openai.chat.completions.create({
            model: openaiPingModel,
            messages: [{ role: "user", content: "hi" }],
            max_completion_tokens: 5,
          });
          results.openai = { status: "ok", message: "????" };
        } catch (err: any) {
          results.openai = { status: "error", message: `????: ${err.message}` };
        }
      }

      const brands = storage.getBrands();
      for (const brand of brands) {
        const merchantNo = brand.superlanding_merchant_no || storage.getSetting("superlanding_merchant_no") || "";
        const accessKey = brand.superlanding_access_key || storage.getSetting("superlanding_access_key") || "";
        const key = `superlanding_brand_${brand.id}`;
        if (!merchantNo || !accessKey) {
          results[key] = { status: "unconfigured", message: "????" };
        } else {
          try {
            const slUrl = `https://api.super-landing.com/orders.json?merchant_no=${encodeURIComponent(merchantNo)}&access_key=${encodeURIComponent(accessKey)}&per_page=1`;
            const slRes = await fetch(slUrl, { headers: { Accept: "application/json" } });
            if (slRes.ok) {
              results[key] = { status: "ok", message: "????" };
            } else {
              results[key] = { status: "error", message: `HTTP ${slRes.status}` };
            }
          } catch (err: any) {
            results[key] = { status: "error", message: err.message };
          }
        }

        const channels = storage.getChannelsByBrand(brand.id);
        for (const ch of channels) {
          const chKey = `channel_${ch.id}`;
          if (ch.platform === "line") {
            if (!ch.access_token) {
              results[chKey] = { status: "unconfigured", message: "???? Token" };
            } else {
              try {
                const verifyRes = await fetch("https://api.line.me/v2/bot/info", { headers: { Authorization: `Bearer ${ch.access_token}` } });
                if (verifyRes.ok) {
                  results[chKey] = { status: "ok", message: "????" };
                } else {
                  results[chKey] = { status: "error", message: `???? (${verifyRes.status})` };
                }
              } catch (err: any) {
                results[chKey] = { status: "error", message: err.message };
              }
            }
          } else {
            results[chKey] = ch.access_token ? { status: "ok", message: "??? Token" } : { status: "unconfigured", message: "???? Token" };
          }
        }
      }

      return res.json(results);
    });



    app.get("/api/team", authMiddleware, managerOrAbove, (_req, res) => {
      return res.json(storage.getTeamMembers());
    });

    app.post("/api/team", authMiddleware, superAdminOnly, (req, res) => {
      const { username, password, display_name, role } = req.body;
      if (!username || !password || !display_name) {
        return res.status(400).json({ message: "???????" });
      }
      if (!["super_admin", "marketing_manager", "cs_agent"].includes(role)) {
        return res.status(400).json({ message: "????? super_admin, marketing_manager ? cs_agent" });
      }
      try {
        const user = storage.createUser(username, password, display_name, role);
        return res.json({ success: true, member: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, created_at: user.created_at } });
      } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint")) {
          return res.status(400).json({ message: "??????" });
        }
        return res.status(500).json({ message: "????" });
      }
    });

    app.put("/api/team/:id", authMiddleware, superAdminOnly, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const { display_name, role, password } = req.body;
      if (!display_name) return res.status(400).json({ message: "?????" });
      if (!["super_admin", "marketing_manager", "cs_agent"].includes(role)) return res.status(400).json({ message: "????" });
      if (!storage.updateUser(id, display_name, role, password || undefined)) {
        return res.status(404).json({ message: "???????" });
      }
      return res.json({ success: true });
    });

    app.delete("/api/team/:id", authMiddleware, superAdminOnly, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const s = (req as any).session;
      if (id === s.userId) {
        return res.status(400).json({ message: "????????????" });
      }
      if (!storage.deleteUser(id)) return res.status(404).json({ message: "???????" });
      return res.json({ success: true });
    });

    app.get("/api/team/:id/brand-assignments", authMiddleware, (req: any, res) => {
      const userId = parseIdParam(req.params.id);
      if (userId === null) return res.status(400).json({ message: "??? ID" });
      const me = req.session?.userId;
      const role = req.session?.userRole ?? req.session?.role;
      const isSupervisor = role === "super_admin" || role === "marketing_manager";
      if (userId !== me && !isSupervisor) return res.status(403).json({ message: "????????????" });
      const user = storage.getUserById(userId);
      if (!user) return res.status(404).json({ message: "???????" });
      const assignments = storage.getAgentBrandAssignments(userId);
      return res.json(assignments);
    });

    app.put("/api/team/:id/brand-assignments", authMiddleware, managerOrAbove, (req, res) => {
      const userId = parseIdParam(req.params.id);
      if (userId === null) return res.status(400).json({ message: "??? ID" });
      const { assignments } = req.body || {};
      if (!Array.isArray(assignments)) return res.status(400).json({ message: "??? assignments ??" });
      const user = storage.getUserById(userId);
      if (!user) return res.status(404).json({ message: "???????" });
      const normalized = assignments.map((a: any) => {
        const brand_id = typeof a.brand_id === "number" ? a.brand_id : parseInt(String(a.brand_id), 10);
        const role: import("@shared/schema").AgentBrandRole = a.role === "backup" ? "backup" : "primary";
        return { brand_id, role };
      }).filter((a: { brand_id: number; role: import("@shared/schema").AgentBrandRole }) => !Number.isNaN(a.brand_id));
      storage.setAgentBrandAssignments(userId, normalized);
      return res.json({ success: true, assignments: storage.getAgentBrandAssignments(userId) });
    });

    app.get("/api/team/available-agents", authMiddleware, (req, res) => {
      const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
      const eligible = assignment.getEligibleAgents();
      const eligibleSet = new Set(eligible.map((e) => e.agentId));
      const list = members.map((m) => {
        const u = storage.getUserById(m.id);
        const status = storage.getAgentStatus(m.id);
        const openCases = m.open_cases_count ?? storage.getOpenCasesCountForAgent(m.id);
        return {
          id: m.id,
          display_name: m.display_name,
          avatar_url: m.avatar_url ?? u?.avatar_url ?? null,
          is_online: m.is_online ?? 0,
          is_available: m.is_available ?? 1,
          last_active_at: m.last_active_at ?? null,
          open_cases_count: openCases,
          max_active_conversations: m.max_active_conversations ?? 10,
          auto_assign_enabled: m.auto_assign_enabled ?? 1,
          can_assign: eligibleSet.has(m.id),
          on_duty: status?.on_duty ?? 1,
          work_start_time: status?.work_start_time ?? "09:00",
          work_end_time: status?.work_end_time ?? "18:00",
          is_in_work: assignment.isAgentInWork(m.id),
        };
      });
      return res.json(list);
    });

    app.put("/api/team/:id/agent-status", authMiddleware, superAdminOnly, (req: any, res) => {
      const userId = parseIdParam(req.params.id);
      if (userId === null) return res.status(400).json({ message: "??? ID" });
      const { auto_assign_enabled, max_active_conversations } = req.body || {};
      const status = storage.getAgentStatus(userId);
      storage.upsertAgentStatus({
        user_id: userId,
        auto_assign_enabled: auto_assign_enabled !== undefined ? (auto_assign_enabled ? 1 : 0) : status?.auto_assign_enabled ?? 1,
        max_active_conversations: max_active_conversations !== undefined ? Math.max(1, Math.min(50, parseInt(String(max_active_conversations), 10) || 10)) : status?.max_active_conversations ?? 10,
      });
      return res.json({ success: true });
    });

    app.post("/api/team/:id/avatar", authMiddleware, avatarUpload.single("file"), (req: any, res) => {
      const userId = parseIdParam(req.params.id);
      if (userId === null) return res.status(400).json({ message: "??? ID" });
      const me = req.session?.userId;
      const role = req.session?.userRole ?? req.session?.role;
      const isSelf = me === userId;
      const isAdmin = role === "super_admin";
      if (!isSelf && !isAdmin) return res.status(403).json({ message: "????????????????" });
      if (!req.file) return res.status(400).json({ message: "????? (file)" });
      const avatarUrl = `/uploads/avatars/${req.file.filename}`;
      storage.updateUserAvatar(userId, avatarUrl);
      return res.json({ success: true, avatar_url: avatarUrl });
    });

    const isSupervisor = (req: any) => ["super_admin", "marketing_manager"].includes(req.session?.userRole);

    app.get("/api/agent-status", authMiddleware, (req: any, res) => {
      const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
      if (isSupervisor(req)) {
        const list = members.map((m) => {
          const status = storage.getAgentStatus(m.id);
          const openCases = m.open_cases_count ?? storage.getOpenCasesCountForAgent(m.id);
          const maxActive = status?.max_active_conversations ?? m.max_active_conversations ?? 10;
          return {
            user_id: m.id,
            display_name: m.display_name,
            is_online: m.is_online ?? 0,
            is_available: m.is_available ?? 1,
            last_active_at: m.last_active_at ?? null,
            priority: status?.priority ?? 1,
            on_duty: status?.on_duty ?? 1,
            lunch_break: status?.lunch_break ?? 0,
            pause_new_cases: status?.pause_new_cases ?? 0,
            today_assigned_count: status?.today_assigned_count ?? 0,
            open_cases_count: openCases,
            max_active_conversations: maxActive,
            work_start_time: status?.work_start_time ?? "09:00",
            work_end_time: status?.work_end_time ?? "18:00",
            lunch_start_time: status?.lunch_start_time ?? "12:00",
            lunch_end_time: status?.lunch_end_time ?? "13:00",
            updated_at: status?.updated_at,
          };
        });
        return res.json(list);
      }
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ message: "???" });
      const status = storage.getAgentStatus(userId);
      const openCases = storage.getOpenCasesCountForAgent(userId);
      const me = members.find((m) => m.id === userId);
      if (!me) return res.json({ user_id: userId, priority: 1, on_duty: 1, lunch_break: 0, pause_new_cases: 0, today_assigned_count: 0, open_cases_count: openCases, max_active_conversations: 10, is_online: 0, is_available: 1, work_start_time: "09:00", work_end_time: "18:00", lunch_start_time: "12:00", lunch_end_time: "13:00", updated_at: null });
      const maxActive = status?.max_active_conversations ?? (me as any).max_active_conversations ?? 10;
      return res.json({ ...status, user_id: me.id, display_name: me.display_name, open_cases_count: openCases, max_active_conversations: maxActive, is_online: (me as any).is_online ?? 0, is_available: (me as any).is_available ?? 1 });
    });

    app.get("/api/agent-stats/me", authMiddleware, (req: any, res) => {
      const userId = req.session?.userId;
      const role = req.session?.userRole;
      if (!userId || role !== "cs_agent") {
        return res.json({ my_cases: 0, pending_reply: 0, urgent: 0, overdue: 0, tracking: 0, closed_today: 0, open_cases_count: 0, max_active_conversations: 10, is_online: 0, is_available: 1 });
      }
      const status = storage.getAgentStatus(userId);
      const openCases = storage.getOpenCasesCountForAgent(userId);
      const maxActive = status?.max_active_conversations ?? 10;
      const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
      const me = members.find((m) => m.id === userId);
      const isOnline = (me as any)?.is_online ?? 0;
      const isAvailable = (me as any)?.is_available ?? 1;
      const counts = storage.getAgentStatsCounts(userId);
      return res.json({ my_cases: openCases, pending_reply: counts.pending_reply, urgent: counts.urgent_simple, overdue: counts.overdue, tracking: counts.tracking, closed_today: counts.closed_today, open_cases_count: openCases, max_active_conversations: maxActive, is_online: isOnline, is_available: isAvailable });
    });

    app.get("/api/manager-stats", authMiddleware, (req: any, res) => {
      if (!isSupervisor(req)) return res.json({ today_new: 0, unassigned: 0, urgent: 0, overdue: 0, closed_today: 0, vip_unhandled: 0, team: [] });
      const brandId = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const counts = storage.getManagerStatsCounts(brandId);
      const agents = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
      const bulk = storage.getOpenAndPendingReplyByAgent(brandId);
      const team = agents.map((m) => {
        const st = storage.getAgentStatus(m.id);
        return {
          id: m.id,
          display_name: m.display_name,
          is_online: (m as any).is_online ?? 0,
          is_available: (m as any).is_available ?? 1,
          open_cases_count: bulk.open_by_agent[m.id] ?? 0,
          max_active_conversations: st?.max_active_conversations ?? 10,
          pending_reply: bulk.pending_reply_by_agent[m.id] ?? 0,
        };
      });
      return res.json({ today_new: counts.today_new, unassigned: counts.unassigned, urgent: counts.urgent_simple, overdue: counts.overdue, closed_today: counts.closed_today, vip_unhandled: counts.vip_unhandled, team });
    });

    app.put("/api/agent-status/me", authMiddleware, (req: any, res) => {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ message: "???" });
      const body = req.body || {};
      if (body.is_online !== undefined || body.is_available !== undefined) {
        storage.updateUserOnline(userId, body.is_online !== undefined ? (body.is_online ? 1 : 0) : 1, body.is_available !== undefined ? (body.is_available ? 1 : 0) : undefined);
      }
      storage.upsertAgentStatus({
        user_id: userId,
        priority: body.priority,
        on_duty: body.on_duty,
        lunch_break: body.lunch_break,
        pause_new_cases: body.pause_new_cases,
        work_start_time: body.work_start_time,
        work_end_time: body.work_end_time,
        lunch_start_time: body.lunch_start_time,
        lunch_end_time: body.lunch_end_time,
        max_active_conversations: body.max_active_conversations,
        auto_assign_enabled: body.auto_assign_enabled,
      });
      return res.json({ success: true });
    });

    app.post("/api/contacts/:id/assign", authMiddleware, (req: any, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "??? ID" });
      const contact = storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "?????? mapping" });
      const byUserId = req.session?.userId;
      if (!byUserId) return res.status(401).json({ message: "???" });
      const rawAgentId = req.body?.agent_id ?? req.get("x-assign-agent-id");
      const bodyAgentId = rawAgentId !== undefined && rawAgentId !== null && rawAgentId !== "" ? Number(rawAgentId) : null;
      const role = req.session?.userRole ?? req.session?.role;
      const isManager = role === "super_admin" || role === "marketing_manager";
      const wantsManualAssign = bodyAgentId != null && !Number.isNaN(bodyAgentId) && Number.isInteger(bodyAgentId);
      if (process.env.NODE_ENV !== "production") {
        const fromHeader = req.body?.agent_id === undefined && req.get("x-assign-agent-id");
        console.log("[assign]", { contactId, "body.agent_id": req.body?.agent_id, "x-assign-agent-id": req.get("x-assign-agent-id"), bodyAgentId, wantsManualAssign, role, isManager, usedHeaderFallback: !!fromHeader });
      }

      try {
        let agentId: number | null = null;
        if (wantsManualAssign) {
          if (!isManager) return res.status(403).json({ message: "????????????????????" });
          const ok = assignment.assignCaseManual(contactId, bodyAgentId!, byUserId, req.body?.reason ?? null);
          if (!ok) {
            const members = storage.getTeamMembers().filter((m: { role: string }) => m.role === "cs_agent");
            const target = members.find((m: { id: number }) => m.id === bodyAgentId);
            if (!target) return res.status(400).json({ message: "?????????????" });
            const openCases = target.open_cases_count ?? storage.getOpenCasesCountForAgent(bodyAgentId!);
            const maxActive = target.max_active_conversations ?? 10;
            return res.status(400).json({ message: `????????? (${openCases}/${maxActive})` });
          }
          agentId = bodyAgentId;
        } else {
          agentId = assignment.assignCase(contactId);
          if (agentId == null) return res.status(503).json({ message: "?????????????1) ??????????? 2) ???????????????????" });
        }
        broadcastSSE("contacts_updated", { contact_id: contactId });
        const updated = storage.getContact(contactId);
        const assignedTo = agentId ? storage.getUserById(agentId) : null;
        return res.json({
          success: true,
          assigned_agent_id: agentId,
          assigned_to_user_id: updated?.assigned_agent_id ?? agentId,
          assigned_at: updated?.assigned_at ?? updated?.first_assigned_at ?? null,
          assignment_status: updated?.assignment_status ?? "assigned",
          assignment_method: updated?.assignment_method ?? (wantsManualAssign ? "manual" : "auto"),
          assigned_agent_name: assignedTo?.display_name ?? null,
          assigned_agent_avatar_url: assignedTo?.avatar_url ?? null,
          last_human_reply_at: updated?.last_human_reply_at ?? null,
          reassign_count: updated?.reassign_count ?? 0,
          needs_assignment: updated?.needs_assignment ?? 0,
          response_sla_deadline_at: updated?.response_sla_deadline_at ?? null,
        });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const isConstraint = /CHECK constraint failed|constraint failed|SQLITE_CONSTRAINT/i.test(msg);
        console.error("[assign] ????", contactId, err);
        if (isConstraint) {
          return res.status(500).json({ message: "?????????????????????????????????" });
        }
        return res.status(500).json({ message: msg && msg.length < 200 ? msg : "??????????????" });
      }
    });

    app.post("/api/contacts/:id/unassign", authMiddleware, (req: any, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "??? ID" });
      const contact = storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "?????? mapping" });
      const byUserId = req.session?.userId;
      if (!byUserId) return res.status(401).json({ message: "???" });
      const isManager = (req.session?.userRole ?? req.session?.role) === "super_admin" || (req.session?.userRole ?? req.session?.role) === "marketing_manager";
      if (!isManager) return res.status(403).json({ message: "?????????" });
      const ok = assignment.unassignCase(contactId, byUserId);
      if (!ok) return res.status(404).json({ message: "???????" });
      broadcastSSE("contacts_updated", { contact_id: contactId });
      const updated = storage.getContact(contactId);
      return res.json({
        success: true,
        assigned_to_user_id: null,
        assigned_at: null,
        assignment_status: updated?.assignment_status ?? "waiting_human",
        assignment_method: null,
        assigned_agent_name: null,
        assigned_agent_avatar_url: null,
        last_human_reply_at: updated?.last_human_reply_at ?? null,
        reassign_count: updated?.reassign_count ?? 0,
        needs_assignment: updated?.needs_assignment ?? 1,
        response_sla_deadline_at: null,
      });
    });

    app.get("/api/contacts/:id/assignment", authMiddleware, (req, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "??? ID" });
      const contact = storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "?????? mapping" });
      const assignedTo = contact.assigned_agent_id ? storage.getUserById(contact.assigned_agent_id) : null;
      // 供操作者判斷：此對話目前是否會由 AI 回覆
      let ai_will_reply = true;
      let ai_not_reply_reason: string | null = null;
      if (contact.needs_human === 1) {
        ai_will_reply = false;
        ai_not_reply_reason = "已轉人工";
      } else if (contact.channel_id != null) {
        const ch = storage.getChannel(contact.channel_id);
        if (!ch || ch.is_ai_enabled !== 1) {
          ai_will_reply = false;
          ai_not_reply_reason = "此渠道未開啟 AI 回覆";
        }
      }
      return res.json({
        assigned_to_user_id: contact.assigned_agent_id,
        assigned_at: contact.assigned_at ?? contact.first_assigned_at,
        assignment_status: contact.assignment_status,
        assignment_method: contact.assignment_method,
        assignment_reason: (contact as any).assignment_reason ?? null,
        last_human_reply_at: contact.last_human_reply_at,
        reassign_count: contact.reassign_count ?? 0,
        needs_assignment: contact.needs_assignment ?? 0,
        response_sla_deadline_at: contact.response_sla_deadline_at,
        assigned_agent_name: assignedTo?.display_name ?? null,
        assigned_agent_avatar_url: assignedTo?.avatar_url ?? null,
        ai_will_reply,
        ai_not_reply_reason,
      });
    });

    app.post("/api/contacts/:id/reassign", authMiddleware, (req: any, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "??? ID" });
      const { new_agent_id, note } = req.body || {};
      const newAgentId = new_agent_id != null ? Number(new_agent_id) : null;
      if (newAgentId == null || !Number.isInteger(newAgentId)) return res.status(400).json({ message: "??? new_agent_id" });
      const byAgentId = req.session?.userId;
      if (!byAgentId) return res.status(401).json({ message: "???" });
      try {
        const ok = assignment.reassignCase(contactId, newAgentId, byAgentId, note || null);
        if (!ok) return res.status(404).json({ message: "???????" });
        broadcastSSE("contacts_updated", { contact_id: contactId });
        const updated = storage.getContact(contactId);
        const assignedTo = updated?.assigned_agent_id ? storage.getUserById(updated.assigned_agent_id) : null;
        return res.json({
          success: true,
          assigned_to_user_id: updated?.assigned_agent_id ?? null,
          assigned_at: updated?.assigned_at ?? updated?.first_assigned_at ?? null,
          assignment_status: updated?.assignment_status ?? "assigned",
          assignment_method: updated?.assignment_method ?? "reassign",
          assigned_agent_name: assignedTo?.display_name ?? null,
          assigned_agent_avatar_url: assignedTo?.avatar_url ?? null,
          last_human_reply_at: updated?.last_human_reply_at ?? null,
          reassign_count: updated?.reassign_count ?? 0,
          needs_assignment: updated?.needs_assignment ?? 0,
          response_sla_deadline_at: updated?.response_sla_deadline_at ?? null,
        });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (/CHECK constraint failed|constraint failed|SQLITE_CONSTRAINT/i.test(msg)) {
          console.error("[reassign] ????", contactId, err);
          return res.status(500).json({ message: "?????????????????????????????????" });
        }
        throw err;
      }
    });

    app.get("/api/contacts/:id/assignment-history", authMiddleware, (req, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "??? ID" });
      const history = storage.getAssignmentHistory(contactId);
      const withNames = history.map((h) => {
        const toUser = storage.getUserById(h.assigned_to_agent_id);
        const byUser = h.assigned_by_agent_id ? storage.getUserById(h.assigned_by_agent_id) : null;
        return { ...h, assigned_to_name: toUser?.display_name, assigned_by_name: byUser?.display_name };
      });
      return res.json(withNames);
    });

    app.get("/api/performance/me", authMiddleware, (req: any, res) => {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ message: "???" });
      const brandId = req.query.brand_id ? parseInt(String(req.query.brand_id), 10) : undefined;
      const stats = storage.getAgentPerformanceStats(userId, Number.isNaN(brandId as number) ? undefined : brandId);
      return res.json(stats);
    });

    app.get("/api/performance", authMiddleware, managerOrAbove, (req: any, res) => {
      const brandId = req.query.brand_id ? parseInt(String(req.query.brand_id), 10) : undefined;
      const bid = Number.isNaN(brandId as number) ? undefined : brandId;
      const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
      const list = members.map((m) => ({ agent_id: m.id, display_name: m.display_name, ...storage.getAgentPerformanceStats(m.id, bid) }));
      return res.json(list);
    });

    app.get("/api/supervisor/report", authMiddleware, managerOrAbove, (req: any, res) => {
      const brandId = req.query.brand_id ? parseInt(String(req.query.brand_id), 10) : undefined;
      const bid = Number.isNaN(brandId as number) ? undefined : brandId;
      const report = storage.getSupervisorReport(bid);
      return res.json(report);
    });

    app.get("/api/manager-dashboard", authMiddleware, (req: any, res) => {
      if (!isSupervisor(req)) return res.json({ cards: {}, status_distribution: [], agent_workload: [], alerts: [], issue_type_rank: [], tag_rank: [] });
      const brandIdRaw = req.query.brand_id ? parseInt(String(req.query.brand_id), 10) : undefined;
      const brandId = Number.isNaN(brandIdRaw as number) ? undefined : brandIdRaw;
      const snap = storage.getManagerDashboardSnapshot(brandId);
      const report = storage.getSupervisorReport(brandId);
      const todayPending = snap.today_pending;
      const urgent = snap.urgent;
      const unassigned = snap.unassigned;
      const overdue = snap.overdue;
      const vipUnhandled = snap.vip_unhandled;
      const closedToday = snap.closed_today;
      const totalToday = snap.today_new;
      const todayCloseRate = totalToday > 0 ? Math.round((closedToday / totalToday) * 100) : 0;
      const agents = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
      const agentWorkload = agents.map((m) => {
        const st = storage.getAgentStatus(m.id);
        const openCases = snap.open_by_agent[m.id] ?? 0;
        const maxActive = st?.max_active_conversations ?? 10;
        const pendingReply = snap.pending_reply_by_agent[m.id] ?? 0;
        return { id: m.id, name: m.display_name, open: openCases, max: maxActive, pending: pendingReply };
      });
      const statusLabels: Record<string, string> = {
        pending: "待處理",
        processing: "處理中",
        awaiting_human: "待人接",
        assigned: "已指派",
        waiting_customer: "待客戶回覆",
        high_risk: "高風險",
        new_case: "新案件",
        closed: "已結案",
        resolved: "已解決",
      };
      const statusDistribution = snap.status_distribution.map(({ status, count }) => ({
        label: statusLabels[status] || status,
        count,
      }));
      const unassignedThreshold = 5;
      const alerts: { type: string; count: number; threshold?: number }[] = [];
      if (overdue > 0) alerts.push({ type: "逾時未回", count: overdue });
      if (urgent > 0) alerts.push({ type: "緊急案件", count: urgent });
      if (vipUnhandled > 0) alerts.push({ type: "VIP 待處理", count: vipUnhandled });
      if (unassigned >= unassignedThreshold) alerts.push({ type: "待分配過多", count: unassigned, threshold: unassignedThreshold });
      const issueTypeRank = (report.category_ratio || []).map((c: { label: string; count: number }) => ({ name: c.label, count: c.count }));
      const tagRank = (report.tag_rank || []).map((t: { tag: string; count: number }) => ({ name: t.tag, count: t.count }));
      return res.json({
        cards: { today_pending: todayPending, urgent, unassigned, today_close_rate: todayCloseRate, closed_today: closedToday, today_new: totalToday },
        status_distribution: statusDistribution,
        agent_workload: agentWorkload,
        alerts,
        issue_type_rank: issueTypeRank,
        tag_rank: tagRank,
      });
    });

    app.get("/api/notifications/unread-count", authMiddleware, (req, res) => {
      const count = storage.getUnreadHumanCaseCount();
      return res.json({ count });
    });

    app.post("/api/notifications/mark-read", authMiddleware, (req: any, res) => {
      const contactId = req.body?.contact_id != null ? parseInt(String(req.body.contact_id), 10) : undefined;
      if (contactId !== undefined && Number.isNaN(contactId)) return res.status(400).json({ message: "??? contact_id" });
      storage.markCaseNotificationsRead(contactId);
      return res.json({ success: true });
    });

    app.get("/api/assignment/eligible", authMiddleware, (req, res) => {
      const eligible = assignment.getEligibleAgents();
      const withNames = eligible.map((e) => ({ ...e, display_name: storage.getUserById(e.agentId)?.display_name }));
      return res.json(withNames);
    });

    app.get("/api/assignment/unavailable-reason", authMiddleware, (req, res) => {
      const reason = assignment.getUnavailableReason();
      return res.json({ reason });
    });

    app.post("/api/assignment/run-overdue-reassign", authMiddleware, managerOrAbove, (req, res) => {
      const results = assignment.runOverdueReassign();
      return res.json({ results });
    });

    app.get("/api/analytics", authMiddleware, managerOrAbove, (req: any, res) => {
      const range = (req.query.range as string) || "today";
      const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;

      const now = new Date();
      let startDate: string;
      let endDate: string = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().substring(0, 19).replace("T", " ");

      if (range === "custom" && req.query.start && req.query.end) {
        startDate = (req.query.start as string) + " 00:00:00";
        endDate = (req.query.end as string) + " 23:59:59";
      } else if (range === "30d") {
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().substring(0, 19).replace("T", " ");
      } else if (range === "7d") {
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 19).replace("T", " ");
      } else {
        startDate = now.toISOString().substring(0, 10) + " 00:00:00";
      }

      const brandFilter = brandId ? " AND c.brand_id = ?" : "";
      const brandParam = brandId ? [brandId] : [];

      const msgStats = db.prepare(`
        SELECT 
          SUM(CASE WHEN m.sender_type = 'user' THEN 1 ELSE 0 END) as user_msgs,
          SUM(CASE WHEN m.sender_type = 'ai' THEN 1 ELSE 0 END) as ai_msgs,
          SUM(CASE WHEN m.sender_type = 'admin' THEN 1 ELSE 0 END) as admin_msgs
        FROM messages m
        JOIN contacts c ON m.contact_id = c.id
        WHERE m.created_at >= ? AND m.created_at <= ?${brandFilter}
      `).get(startDate, endDate, ...brandParam) as any;
      const userMsgs: number = msgStats?.user_msgs || 0;
      const aiMsgs: number = msgStats?.ai_msgs || 0;
      const adminMsgs: number = msgStats?.admin_msgs || 0;

      const activeContactsRow = db.prepare(`
        SELECT COUNT(DISTINCT c.id) as cnt FROM contacts c
        JOIN messages m ON m.contact_id = c.id
        WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
      `).get(startDate, endDate, ...brandParam) as { cnt: number };
      const active = activeContactsRow?.cnt || 0;

      const contactStatusInRange = db.prepare(`
        SELECT c.status, COUNT(DISTINCT c.id) as cnt
        FROM contacts c
        JOIN messages m ON m.contact_id = c.id
        WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
        GROUP BY c.status
      `).all(startDate, endDate, ...brandParam) as { status: string; cnt: number }[];

      let resolvedCount = 0;
      const statusMap: Record<string, number> = {};
      for (const row of contactStatusInRange) {
        statusMap[row.status] = (statusMap[row.status] || 0) + row.cnt;
        if (row.status === "resolved") resolvedCount += row.cnt;
      }
      const completionRate = active > 0 ? Math.round((resolvedCount / active) * 1000) / 10 : null;

      const transferCount = (db.prepare(`
        SELECT COUNT(DISTINCT c.id) as cnt FROM contacts c
        JOIN messages m ON m.contact_id = c.id
        WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
          AND (c.status IN ('awaiting_human', 'high_risk') OR c.needs_human = 1)
      `).get(startDate, endDate, ...brandParam) as { cnt: number })?.cnt || 0;
      const transferRate = active > 0 ? Math.round((transferCount / active) * 1000) / 10 : null;

      const aiLogStats = storage.getAiLogStats(startDate, endDate, brandId);
      const aiHasData = aiLogStats.totalAiResponses > 0;
      const aiResolutionRate = aiHasData
        ? Math.round(((aiLogStats.totalAiResponses - aiLogStats.transferTriggered) / aiLogStats.totalAiResponses) * 1000) / 10
        : null;
      const orderQueryHasData = aiLogStats.orderQueryCount > 0;
      const orderQuerySuccessRate = orderQueryHasData
        ? Math.round((aiLogStats.orderQuerySuccess / aiLogStats.orderQueryCount) * 1000) / 10
        : null;

      const avgMessagesPerContact = active > 0 ? Math.round((userMsgs / active) * 10) / 10 : null;

      const totalMsgs = userMsgs + aiMsgs + adminMsgs;
      const messageSplit = [
        { name: "客戶", value: userMsgs, pct: totalMsgs > 0 ? Math.round((userMsgs / totalMsgs) * 1000) / 10 : 0 },
        { name: "AI 回覆", value: aiMsgs, pct: totalMsgs > 0 ? Math.round((aiMsgs / totalMsgs) * 1000) / 10 : 0 },
        { name: "真人客服", value: adminMsgs, pct: totalMsgs > 0 ? Math.round((adminMsgs / totalMsgs) * 1000) / 10 : 0 },
      ];

      const statusLabels: Record<string, string> = {
        pending: "待處理",
        processing: "處理中",
        resolved: "已解決",
        ai_handling: "AI 處理中",
        awaiting_human: "待人工",
        high_risk: "高風險",
        closed: "已結案",
      };
      const statusDistribution = Object.entries(statusMap)
        .map(([status, count]) => ({ name: statusLabels[status] || status, value: count }))
        .sort((a, b) => b.value - a.value);

      const issueTypeDistribution: { name: string; value: number }[] = [];
      const issueTypeCounts = db.prepare(`
        SELECT c.issue_type, COUNT(DISTINCT c.id) as count FROM contacts c
        JOIN messages m ON m.contact_id = c.id
        WHERE c.issue_type IS NOT NULL AND m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
        GROUP BY c.issue_type ORDER BY count DESC
      `).all(startDate, endDate, ...brandParam) as { issue_type: string; count: number }[];
      const issueTypeLabels: Record<string, string> = {
        order_inquiry: "訂單查詢",
        product_consult: "商品諮詢",
        return_refund: "退換貨",
        complaint: "客訴",
        order_modify: "修改訂單",
        general: "一般",
        other: "其他",
      };
      for (const it of issueTypeCounts) {
        issueTypeDistribution.push({ name: issueTypeLabels[it.issue_type] || it.issue_type, value: it.count });
      }
      const classifiedCount = issueTypeDistribution.reduce((s, d) => s + d.value, 0);
      const intentUnclassifiedPct = active > 0 ? Math.round(((active - classifiedCount) / active) * 100) : 0;

      const intentDistribution: { name: string; value: number; isEstimate: boolean }[] = [];
      if (issueTypeDistribution.length > 0) {
        for (const it of issueTypeDistribution) {
          intentDistribution.push({ name: it.name, value: it.value, isEstimate: false });
        }
      } else if (userMsgs > 0) {
        const topKeywords = storage.getTopKeywordsFromMessages(startDate, endDate, brandId);
        const intentCategories: [string, string[]][] = [
          ["訂單物流", ["訂單", "查詢", "物流", "出貨", "貨態", "配送", "到貨", "單號"]],
          ["商品諮詢", ["商品", "規格", "尺寸", "顏色", "庫存"]],
          ["退換貨", ["退貨", "退款", "換貨", "取消訂單"]],
          ["客訴不滿", ["投訴", "客訴", "抱怨", "不滿", "申訴", "誇張", "生氣", "失望"]],
          ["其他／一般", ["謝謝", "你好", "請問", "想問", "緊急", "急"]],
        ];
        for (const [category, kws] of intentCategories) {
          let catCount = 0;
          for (const kw of kws) {
            const found = topKeywords.find(k => k.keyword === kw);
            if (found) catCount += found.count;
          }
          if (catCount > 0) {
            intentDistribution.push({ name: category, value: catCount, isEstimate: true });
          }
        }
        intentDistribution.sort((a, b) => b.value - a.value);
      }

      const transferReasons = aiLogStats.transferReasons.map(r => ({ ...r, reason: maskSensitiveInfo(r.reason) }));
      const systemTransferReasons = db.prepare(`
        SELECT details, COUNT(*) as count FROM system_alerts
        WHERE alert_type = 'transfer' AND created_at >= ? AND created_at <= ?
        GROUP BY details ORDER BY count DESC LIMIT 10
      `).all(startDate, endDate) as { details: string; count: number }[];
      const allTransferReasons = transferReasons.length > 0 ? transferReasons : systemTransferReasons.map(r => ({ reason: maskSensitiveInfo(r.details), count: r.count }));

      const platformStats = db.prepare(`
        SELECT c.platform, COUNT(DISTINCT c.id) as count FROM contacts c
        JOIN messages m ON m.contact_id = c.id
        WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
        GROUP BY c.platform
      `).all(startDate, endDate, ...brandParam) as { platform: string; count: number }[];
      const platformDistribution = platformStats.map(p => ({
        name: p.platform === "line" ? "LINE" : p.platform === "messenger" ? "Messenger" : p.platform,
        value: p.count,
      }));

      const dailyVolumeRaw = db.prepare(`
        SELECT date(m.created_at) as d,
          SUM(CASE WHEN m.sender_type='user' THEN 1 ELSE 0 END) as user_cnt,
          SUM(CASE WHEN m.sender_type='ai' THEN 1 ELSE 0 END) as ai_cnt,
          SUM(CASE WHEN m.sender_type='admin' THEN 1 ELSE 0 END) as admin_cnt
        FROM messages m
        JOIN contacts c ON m.contact_id = c.id
        WHERE m.created_at >= ? AND m.created_at <= ?${brandFilter}
        GROUP BY date(m.created_at) ORDER BY d
      `).all(startDate, endDate, ...brandParam) as { d: string; user_cnt: number; ai_cnt: number; admin_cnt: number }[];
      const dailyVolume = dailyVolumeRaw.map(r => ({
        date: r.d,
        user: r.user_cnt || 0,
        ai: r.ai_cnt || 0,
        admin: r.admin_cnt || 0,
      }));

      const topKeywordsAll = storage.getTopKeywordsFromMessages(startDate, endDate, brandId);

      const userMessages = db.prepare(`
        SELECT m.content FROM messages m
        JOIN contacts c ON m.contact_id = c.id
        WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
        ORDER BY m.created_at DESC LIMIT 500
      `).all(startDate, endDate, ...brandParam) as { content: string }[];

      const productKeywords = [
        "包", "托特", "後背包", "手提包", "肩背包", "側背包",
        "甜", "糖", "巧克力", "蛋糕", "餅乾", "糖果",
        "面膜", "精華", "乳液", "洗髮", "沐浴", "保健",
        "訂單", "出貨", "物流", "退貨", "退款",
      ];
      const productMentions: Record<string, number> = {};
      for (const msg of userMessages) {
        const text = msg.content != null ? String(msg.content) : "";
        for (const pk of productKeywords) {
          if (text.includes(pk)) {
            productMentions[pk] = (productMentions[pk] || 0) + 1;
          }
        }
      }
      const hotProducts = Object.entries(productMentions)
        .map(([name, mentions]) => ({ name, mentions }))
        .sort((a, b) => b.mentions - a.mentions)
        .slice(0, 8);

      const concernCounts: Record<string, number> = {};
      for (const msg of userMessages) {
        const text = msg.content != null ? String(msg.content) : "";
        if (!text) continue;
        for (const { concern, keywords } of ANALYTICS_CONCERN_KEYWORD_GROUPS) {
          if (keywords.some((kw) => kw.length > 0 && text.includes(kw))) {
            concernCounts[concern] = (concernCounts[concern] || 0) + 1;
          }
        }
      }
      const customerConcerns = Object.entries(concernCounts)
        .map(([concern, count]) => ({ concern, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);

      const painPoints: string[] = [];
      const suggestions: string[] = [];

      if (transferRate !== null && transferRate > 15) {
        painPoints.push(`轉人工率偏高 ${transferRate}%（${transferCount}/${active} 位活躍對話），建議檢視常見原因與 SOP。`);
      }
      if (issueTypeDistribution.length > 0) {
        const returnIssues = issueTypeDistribution.find((i) => i.name === issueTypeLabels.return_refund);
        if (returnIssues && active > 0 && (returnIssues.value / active) * 100 > 20) {
          painPoints.push(`退換貨議題較多：${returnIssues.value} 筆，約佔活躍對話 ${Math.round((returnIssues.value / active) * 100)}%。`);
          suggestions.push("可檢視退換貨 SOP 與 AI 引導是否足夠清楚。");
        }
      }
      if (completionRate !== null && completionRate < 30 && active > 3) {
        painPoints.push(`處理完成率偏低 ${completionRate}%（${resolvedCount}/${active}），建議追蹤未結案原因。`);
        suggestions.push("可加強結案追蹤與客服負載分配。");
      }
      const alertTimeouts = (db.prepare(`
        SELECT COUNT(*) as cnt FROM system_alerts WHERE alert_type = 'timeout_escalation' AND created_at >= ? AND created_at <= ?
      `).get(startDate, endDate) as { cnt: number })?.cnt || 0;
      if (alertTimeouts > 0) {
        painPoints.push(`本期間有 ${alertTimeouts} 筆 AI／工具逾時警示，請留意穩定性。`);
        suggestions.push("建議檢查 API 連線與逾時設定。");
      }
      if (customerConcerns.length > 0) {
        const topConcern = customerConcerns[0];
        if (topConcern.count >= 2) {
          painPoints.push(`客戶訊息中「${topConcern.concern}」相關敘述出現 ${topConcern.count} 次以上，可優先關注。`);
        }
      }
      if (!aiHasData && aiMsgs === 0) {
        suggestions.push("本期間幾乎無 AI 回覆紀錄；若已啟用 AI，請確認 Webhook 與開關設定。");
      }
      if (orderQueryHasData && orderQuerySuccessRate !== null && orderQuerySuccessRate < 50) {
        suggestions.push(`查單成功率僅 ${orderQuerySuccessRate}%，建議檢查訂單 API 與顧客輸入引導。`);
      }
      if (allTransferReasons.length > 0) {
        const topReason = allTransferReasons[0];
        suggestions.push(`轉人工主因常見為「${topReason.reason}」（${topReason.count} 次），可據此優化 AI 劇本。`);
      }
      if (hotProducts.length > 0) {
        suggestions.push(`熱門關鍵字含：${hotProducts.slice(0, 3).map((p) => p.name).join("、")}，可搭配知識庫補強。`);
      }

      return res.json({
        kpi: {
          customerMessages: userMsgs,
          activeContacts: active,
          resolvedCount,
          completionRate,
          transferCount,
          transferRate,
          aiResolutionRate,
          aiHasData,
          orderQuerySuccessRate,
          orderQueryHasData,
          avgMessagesPerContact,
        },
        messageSplit,
        statusDistribution,
        intentDistribution,
        intentUnclassifiedPct: intentUnclassifiedPct,
        aiInsights: { painPoints, suggestions, hotProducts, customerConcerns },
        issueTypeDistribution,
        transferReasons: allTransferReasons,
        platformDistribution,
        topKeywords: topKeywordsAll.slice(0, 15),
        dailyVolume,
      });
    });

    app.get("/api/analytics/health", authMiddleware, managerOrAbove, (req: any, res) => {
      const range = (req.query.range as string) || "today";
      const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;

      const now = new Date();
      let startDate: string;
      let endDate: string = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().substring(0, 19).replace("T", " ");

      if (range === "custom" && req.query.start && req.query.end) {
        startDate = (req.query.start as string) + " 00:00:00";
        endDate = (req.query.end as string) + " 23:59:59";
      } else if (range === "30d") {
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().substring(0, 19).replace("T", " ");
      } else if (range === "7d") {
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 19).replace("T", " ");
      } else {
        startDate = now.toISOString().substring(0, 10) + " 00:00:00";
      }

      const alertStats = storage.getSystemAlertStats(startDate, endDate, brandId);

      const maskedTransferReasons = alertStats.transferReasonTop5.map(r => ({
        reason: maskSensitiveInfo(r.reason),
        count: r.count,
      }));

      const alertTypeLabels: Record<string, string> = {
        webhook_sig_fail: "Webhook 簽章失敗",
        dedupe_hit: "去重命中",
        lock_timeout: "鎖定逾時",
        order_lookup_fail: "查單失敗",
        timeout_escalation: "AI 逾時升級",
        transfer: "轉人工",
      };

      const alertsByTypeLabeled = alertStats.alertsByType.map(a => ({
        type: alertTypeLabels[a.type] || a.type,
        count: a.count,
      }));

      return res.json({
        webhookSigFails: alertStats.webhookSigFails,
        dedupeHits: alertStats.dedupeHits,
        lockTimeouts: alertStats.lockTimeouts,
        orderLookupFails: alertStats.orderLookupFails,
        timeoutEscalations: alertStats.timeoutEscalations,
        totalAlerts: alertStats.totalAlerts,
        transferReasonTop5: maskedTransferReasons,
        alertsByType: alertsByTypeLabeled,
      });
    });
}
