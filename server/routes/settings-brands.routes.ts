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
import { lookupShoplineOrdersByPhoneExact } from "../shopline";
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
import { addAiReplyJob, enqueueDebouncedAiReply, WORKER_HEARTBEAT_KEY, getWorkerHeartbeatStatus, getQueueJobCounts } from "../queue/ai-reply.queue";
import { getRedisClient } from "../redis-client";
import { recordAutoReplyBlocked } from "../auto-reply-blocked";
import { handleLineWebhook } from "../controllers/line-webhook.controller";
import { handleFacebookWebhook, handleFacebookVerify, type FacebookWebhookDeps } from "../controllers/facebook-webhook.controller";
import { applyHandoff, normalizeHandoffReason } from "../services/handoff";
import { assembleEnrichedSystemPrompt } from "../services/prompt-builder";
import { createToolExecutor } from "../services/tool-executor.service";
import {
  createAiReplyService,
  detectHighRisk,
  getEnrichedSystemPrompt,
  getOpenAIModel,
} from "../services/ai-reply.service";
import { getTransferUnavailableSystemMessage as transferUnavailableSystemMessage } from "../transfer-unavailable-message";
import { orderLookupTools, humanHandoffTools, imageTools } from "../openai-tools";
import { resolveOpenAIModel } from "../openai-model";

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

export function registerSettingsBrandsRoutes(app: Express): void {
    app.get("/api/settings", authMiddleware, (req: any, res) => {
      const role = req.session?.userRole;
      if (role === "cs_agent") {
        const publicKeys = ["system_name", "logo_url", "test_mode"];
        const allSettings = storage.getAllSettings();
        return res.json(allSettings.filter((s) => publicKeys.includes(s.key)));
      }
      const allSettings = storage.getAllSettings();
      if (role === "super_admin") return res.json(allSettings);
      const sensitiveKeys = ["openai_api_key", "line_channel_secret", "line_channel_access_token", "superlanding_merchant_no", "superlanding_access_key"];
      const filtered = allSettings.filter((s) => !sensitiveKeys.includes(s.key));
      return res.json(filtered);
    });

    app.put("/api/settings", authMiddleware, (req: any, res) => {
      const { key, value } = req.body;
      if (!key) return res.status(400).json({ message: "key is required" });
      const sensitiveKeys = ["openai_api_key", "line_channel_secret", "line_channel_access_token", "superlanding_merchant_no", "superlanding_access_key"];
      if (sensitiveKeys.includes(key)) {
        if (req.session?.userRole !== "super_admin") return res.status(403).json({ message: "????? super_admin ???API Key ??" });
      } else {
        if (!["super_admin", "marketing_manager"].includes(req.session?.userRole)) return res.status(403).json({ message: "????" });
      }
      storage.setSetting(key, value || "");
      return res.json({ success: true });
    });

    app.post("/api/settings/test-connection", authMiddleware, superAdminOnly, async (req, res) => {
      const { type } = req.body;
      try {
        if (type === "openai") {
          const apiKey = storage.getSetting("openai_api_key");
          if (!apiKey || apiKey.trim() === "") {
            return res.json({ success: false, message: "???? OpenAI API Key" });
          }
          const openai = new OpenAI({ apiKey });
          await openai.chat.completions.create({
            model: getOpenAIModel(),
            messages: [{ role: "user", content: "hi" }],
            max_completion_tokens: 5,
          });
          return res.json({ success: true, message: `OpenAI ???????: ${getOpenAIModel()}?` });
        }

        if (type === "line") {
          const token = storage.getSetting("line_channel_access_token");
          if (!token || token.trim() === "") {
            return res.json({ success: false, message: "???? LINE Channel Access Token" });
          }
          const verifyRes = await fetch("https://api.line.me/v2/bot/info", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (verifyRes.ok) {
            const botInfo = await verifyRes.json();
            return res.json({ success: true, message: `LINE ?????Bot ??: ${botInfo.displayName || botInfo.basicId || "OK"}` });
          }
          const errBody = await verifyRes.text();
          return res.json({ success: false, message: `LINE ???? (${verifyRes.status}): ${errBody}` });
        }

        if (type === "superlanding") {
          const merchantNo = storage.getSetting("superlanding_merchant_no");
          const accessKey = storage.getSetting("superlanding_access_key");
          if (!merchantNo || !accessKey) {
            return res.json({ success: false, message: "??? SuperLanding merchant_no ? access_key" });
          }
          const slUrl = `https://api.super-landing.com/orders.json?merchant_no=${encodeURIComponent(merchantNo)}&access_key=${encodeURIComponent(accessKey)}&per_page=1`;
          try {
            const slRes = await fetch(slUrl, { headers: { Accept: "application/json" } });
            if (slRes.ok) {
              return res.json({ success: true, message: "SuperLanding ????" });
            }
            const errText = await slRes.text().catch(() => "");
            return res.json({ success: false, message: `SuperLanding ???? (HTTP ${slRes.status})?${errText || "??? merchant_no ? access_key ????"}` });
          } catch (fetchErr: any) {
            const detail = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.message || "????";
            return res.json({ success: false, message: `SuperLanding ?????${detail}` });
          }
        }

        return res.json({ success: false, message: `????????: ${type}` });
      } catch (err: any) {
        const msg = err?.message || "????";
        return res.json({ success: false, message: `??????: ${msg}` });
      }
    });


    app.get("/api/brands", authMiddleware, (_req, res) => {
      const brands = storage.getBrands();
      return res.json(brands);
    });

    app.get("/api/brands/:id", authMiddleware, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const brand = storage.getBrand(id);
      if (!brand) return res.status(404).json({ message: "???????" });
      return res.json(brand);
    });

    app.post("/api/brands", authMiddleware, managerOrAbove, async (req, res) => {
      const { name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key } = req.body;
      if (!name || !slug) return res.status(400).json({ message: "??????????" });
      try {
        const brand = await storage.createBrand(name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key);
        return res.json({ success: true, brand });
      } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint")) {
          return res.status(400).json({ message: "???????" });
        }
        return res.status(500).json({ message: "????" });
      }
    });

    app.put("/api/brands/:id", authMiddleware, managerOrAbove, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const {
        name, slug, logo_url, description, system_prompt,
        superlanding_merchant_no, superlanding_access_key, return_form_url,
        shopline_store_domain, shopline_api_token,
      } = req.body;
      const data: Record<string, string> = {};
      if (name !== undefined) data.name = name;
      if (slug !== undefined) data.slug = slug;
      if (logo_url !== undefined) data.logo_url = logo_url;
      if (description !== undefined) data.description = description;
      if (system_prompt !== undefined) data.system_prompt = system_prompt;
      if (superlanding_merchant_no !== undefined) data.superlanding_merchant_no = superlanding_merchant_no;
      if (superlanding_access_key !== undefined) data.superlanding_access_key = superlanding_access_key;
      if (return_form_url !== undefined) data.return_form_url = return_form_url;
      if (shopline_store_domain !== undefined) data.shopline_store_domain = shopline_store_domain;
      if (shopline_api_token !== undefined) data.shopline_api_token = shopline_api_token;
      if (!(await storage.updateBrand(id, data))) return res.status(404).json({ message: "???????" });
      return res.json({ success: true });
    });

    app.delete("/api/brands/:id", authMiddleware, managerOrAbove, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      if (!(await storage.deleteBrand(id))) return res.status(404).json({ message: "???????" });
      return res.json({ success: true });
    });

    app.get("/api/brands/:id/channels", authMiddleware, (req, res) => {
      const brandId = parseIdParam(req.params.id);
      if (brandId === null) return res.status(400).json({ message: "??? ID" });
      const channels = storage.getChannelsByBrand(brandId);
      return res.json(channels);
    });

    app.get("/api/brands/:id/assigned-agents", authMiddleware, (req, res) => {
      const brandId = parseIdParam(req.params.id);
      if (brandId === null) return res.status(400).json({ message: "??? ID" });
      const brand = storage.getBrand(brandId);
      if (!brand) return res.status(404).json({ message: "???????" });
      const agents = storage.getBrandAssignedAgents(brandId);
      return res.json(agents);
    });

    app.get("/api/channels", authMiddleware, (_req, res) => {
      const channels = storage.getChannels();
      return res.json(channels);
    });

    /** 以 LINE API 驗證 access_token 是否有效 */
    async function validateLineAccessToken(token: string): Promise<boolean> {
      const t = (token || "").trim();
      if (!t) return false;
      try {
        const res = await fetch("https://api.line.me/v2/bot/info", {
          headers: { Authorization: `Bearer ${t}` },
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    app.post("/api/brands/:id/channels", authMiddleware, managerOrAbove, async (req, res) => {
      const brandId = parseIdParam(req.params.id);
      if (brandId === null) return res.status(400).json({ message: "??? ID" });
      const { platform, channel_name, bot_id, access_token, channel_secret } = req.body;
      if (!platform || !channel_name) return res.status(400).json({ message: "??????????" });
      if (!["line", "messenger"].includes(platform)) return res.status(400).json({ message: "???? line ? messenger" });
      if (platform === "line" && access_token) {
        const valid = await validateLineAccessToken(String(access_token));
        if (!valid) {
          return res.status(400).json({ message: "LINE Token ????????????" });
        }
      }
      const channel = await storage.createChannel(brandId, platform, channel_name, bot_id, access_token, channel_secret);
      return res.json({ success: true, channel });
    });

    app.put("/api/channels/:id", authMiddleware, managerOrAbove, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const { platform, channel_name, bot_id, access_token, channel_secret, is_active, is_ai_enabled, brand_id } = req.body;
      const data: Record<string, any> = {};
      if (platform !== undefined) data.platform = platform;
      if (channel_name !== undefined) data.channel_name = channel_name;
      if (bot_id !== undefined) data.bot_id = bot_id;
      if (access_token !== undefined) data.access_token = access_token;
      if (channel_secret !== undefined) data.channel_secret = channel_secret;
      if (is_active !== undefined) data.is_active = is_active;
      if (is_ai_enabled !== undefined) data.is_ai_enabled = (is_ai_enabled === true || is_ai_enabled === 1) ? 1 : 0;
      if (brand_id !== undefined) data.brand_id = brand_id;
      if (access_token !== undefined) {
        const existing = storage.getChannel(id);
        const isLine = (platform ?? existing?.platform) === "line";
        const tokenChanged = !existing || (String(access_token || "").trim() !== String(existing.access_token || "").trim());
        if (isLine && access_token && tokenChanged) {
          const valid = await validateLineAccessToken(String(access_token));
          if (!valid) {
            return res.status(400).json({ message: "LINE Token ????????????" });
          }
        }
      }
      if (!(await storage.updateChannel(id, data))) return res.status(404).json({ message: "???????" });
      return res.json({ success: true });
    });

    app.delete("/api/channels/:id", authMiddleware, managerOrAbove, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      if (!(await storage.deleteChannel(id))) return res.status(404).json({ message: "???????" });
      return res.json({ success: true });
    });

    /** 驗證 LINE Channel Access Token，呼叫 LINE API 取得 bot 資訊與 DB 比對 bot_id；Webhook 需填 LINE 後台之 userId */
    app.post("/api/channels/verify-line", authMiddleware, managerOrAbove, async (req, res) => {
      const { access_token, bot_id: formBotId } = req.body || {};
      if (!access_token || typeof access_token !== "string" || !access_token.trim()) {
        return res.json({ success: false, message: "???? Channel Access Token" });
      }
      try {
        const verifyRes = await fetch("https://api.line.me/v2/bot/info", {
          headers: { Authorization: `Bearer ${access_token.trim()}` },
        });
        if (!verifyRes.ok) {
          const errBody = await verifyRes.text();
          return res.json({ success: false, message: `LINE ???? (${verifyRes.status})?Token ???????${errBody.slice(0, 200)}` });
        }
        const botInfo = (await verifyRes.json()) as { userId?: string; displayName?: string; basicId?: string };
        const botUserId = (botInfo.userId || "").trim();
        let message = `LINE ?????Bot: ${botInfo.displayName || botInfo.basicId || "OK"}?userId?? Webhook destination?= ${botUserId || "(?)"}`;
        if (formBotId != null && typeof formBotId === "string") {
          const a = formBotId.trim();
          const b = botUserId;
          const match = a === b || a === (b.startsWith("U") ? b.slice(1) : "U" + b) || b === (a.startsWith("U") ? a.slice(1) : "U" + a);
          if (!match && botUserId) {
            message += `???? Bot ID ? LINE ??? userId ????Webhook ??? Bot ID ???${botUserId}`;
          } else if (match) {
            message += "????? Bot ID ????????????";
          }
        }
        return res.json({ success: true, message, botUserId: botUserId || undefined });
      } catch (err: any) {
        return res.json({ success: false, message: `?????${err.message}` });
      }
    });

    /** 依渠道將聯絡人重新歸屬至指定品牌（LINE 渠道搬家等情境） */
    app.post("/api/admin/contacts/reassign-by-channel", authMiddleware, managerOrAbove, async (req, res) => {
      const channelId = req.body?.channel_id != null ? parseInt(String(req.body.channel_id), 10) : null;
      const brandId = req.body?.brand_id != null ? parseInt(String(req.body.brand_id), 10) : null;
      if (channelId == null || brandId == null || isNaN(channelId) || isNaN(brandId)) {
        return res.status(400).json({ message: "??? channel_id ? brand_id" });
      }
      const channel = storage.getChannel(channelId);
      if (!channel) return res.status(404).json({ message: "???????" });
      const brand = storage.getBrand(brandId);
      if (!brand) return res.status(404).json({ message: "???????" });
      const updated = storage.reassignContactsByChannel(channelId, brandId);
      return res.json({ success: true, updated, message: `?? ${updated} ????????${brand.name}?` });
    });

    app.post("/api/brands/:id/test-superlanding", authMiddleware, managerOrAbove, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const brand = storage.getBrand(id);
      if (!brand) return res.status(404).json({ message: "???????" });
      const merchantNo = brand.superlanding_merchant_no || storage.getSetting("superlanding_merchant_no") || "";
      const accessKey = brand.superlanding_access_key || storage.getSetting("superlanding_access_key") || "";
      if (!merchantNo || !accessKey) {
        return res.json({ success: false, message: "??????????? Merchant No ? Access Key?????????????" });
      }
      try {
        const slUrl = `https://api.super-landing.com/orders.json?merchant_no=${encodeURIComponent(merchantNo)}&access_key=${encodeURIComponent(accessKey)}&per_page=1`;
        const slRes = await fetch(slUrl, { headers: { Accept: "application/json" } });
        if (slRes.ok) {
          const data = await slRes.json();
          const total = data.total_entries || "N/A";
          return res.json({ success: true, message: `?????????? ${total} ???` });
        }
        const errText = await slRes.text().catch(() => "");
        return res.json({ success: false, message: `???????? (HTTP ${slRes.status})?${errText || "??? merchant_no ? access_key ????"}` });
      } catch (fetchErr: any) {
        const detail = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.message || "??????";
        return res.json({ success: false, message: `???????????????${detail}` });
      }
    });

    app.post("/api/brands/:id/test-shopline", authMiddleware, managerOrAbove, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const brand = storage.getBrand(id);
      if (!brand) return res.status(404).json({ message: "???????" });
      const apiToken = (brand.shopline_api_token || "").trim();
      if (!apiToken) {
        return res.json({ success: false, message: "??????? SHOPLINE API Token" });
      }
      // SHOPLINE Open API ???? base?https://open.shopline.io?Token ??????
      const openApiBase = "https://open.shopline.io/v1";
      const testUrl = `${openApiBase}/orders?per_page=1`;
      try {
        const slRes = await fetch(testUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiToken}`,
            "User-Agent": process.env.SHOPLINE_USER_AGENT || "OmniAgentConsole/1.0",
          },
        });
        if (slRes.ok) {
          const data = await slRes.json();
          const items = data.items ?? data.orders ?? data.data ?? [];
          const total = data.pagination?.total ?? data.total ?? (Array.isArray(items) ? items.length : 0);
          return res.json({ success: true, message: `SHOPLINE ??????????? (${total})` });
        }
        const errText = await slRes.text().catch(() => "");
        const errSummary = errText.length > 200 ? errText.slice(0, 200) + "?" : errText;
        return res.json({
          success: false,
          message: `SHOPLINE ???? (HTTP ${slRes.status})?${errSummary || "??? API Token ????????? SHOPLINE ?? OpenAPI ??"}`,
        });
      } catch (fetchErr: any) {
        const detail = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.message || "??????";
        return res.json({ success: false, message: `SHOPLINE ???????????${detail}` });
      }
    });

    app.get("/api/health/status", authMiddleware, async (_req, res) => {
      const results: Record<string, { status: "ok" | "error" | "unconfigured"; message: string }> = {};

      const apiKey = storage.getSetting("openai_api_key");
      if (!apiKey || apiKey.trim() === "") {
        results.openai = { status: "unconfigured", message: "???? API ??" };
      } else {
        try {
          const openai = new OpenAI({ apiKey });
          await openai.chat.completions.create({ model: getOpenAIModel(), messages: [{ role: "user", content: "hi" }], max_completion_tokens: 5 });
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

    app.post("/api/channels/:id/test", authMiddleware, managerOrAbove, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const channel = storage.getChannel(id);
      if (!channel) return res.status(404).json({ message: "???????" });
      if (channel.platform === "line") {
        if (!channel.access_token) return res.json({ success: false, message: "???? Access Token" });
        try {
          const verifyRes = await fetch("https://api.line.me/v2/bot/info", {
            headers: { Authorization: `Bearer ${channel.access_token}` },
          });
          if (verifyRes.ok) {
            const botInfo = await verifyRes.json();
            const botUserId = botInfo.userId || "";
            if (botUserId && !channel.bot_id) {
              await storage.updateChannel(id, { bot_id: botUserId });
            }
            return res.json({ success: true, message: `LINE ?????Bot: ${botInfo.displayName || botInfo.basicId || "OK"}`, botUserId });
          }
          const errBody = await verifyRes.text();
          return res.json({ success: false, message: `LINE ???? (${verifyRes.status}): ${errBody}` });
        } catch (err: any) {
          return res.json({ success: false, message: `????: ${err.message}` });
        }
      }
      if (channel.platform === "messenger") {
        if (!channel.access_token) return res.json({ success: false, message: "???? Page Access Token" });
        try {
          const fbRes = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${encodeURIComponent(channel.access_token)}`);
          if (fbRes.ok) {
            const pageInfo = await fbRes.json();
            const pageId = pageInfo.id || "";
            if (pageId && !channel.bot_id) {
              await storage.updateChannel(id, { bot_id: pageId });
            }
            return res.json({ success: true, message: `Facebook ???????: ${pageInfo.name || "OK"} (ID: ${pageId})`, botId: pageId });
          }
          const errBody = await fbRes.text();
          let userMessage = `Facebook ???? (${fbRes.status}): ${errBody}`;
          try {
            const errJson = JSON.parse(errBody) as { error?: { code?: number; message?: string } };
            if (errJson?.error?.code === 100 && /permission|pages_read_engagement|Page Public|review/i.test(errJson.error.message || "")) {
              userMessage = "Facebook ?????????? Token ??? Facebook App ??????????? pages_read_engagement?????? App ????? Facebook ????? ? ?????????????????????????????? App ??????????????????https://developers.facebook.com/docs/apps/review";
            }
          } catch (_e) { /* ? JSON ????? */ }
          return res.json({ success: false, message: userMessage });
        } catch (err: any) {
          return res.json({ success: false, message: `????: ${err.message}` });
        }
      }
      return res.json({ success: false, message: `???? ${channel.platform} ????` });
    });

    /** 訂閱 FB 粉絲專頁 feed：需 Webhook 與 Page Access Token，權限需含 pages_manage_metadata */
    app.post("/api/channels/:id/subscribe-feed", authMiddleware, managerOrAbove, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const channel = storage.getChannel(id);
      if (!channel) return res.status(404).json({ message: "???????" });
      if (channel.platform !== "messenger") return res.status(400).json({ message: "??? Facebook Messenger ??" });
      const pageId = (channel.bot_id || "").trim();
      const token = (channel.access_token || "").trim();
      if (!pageId || !token) return res.status(400).json({ message: "???? Bot ID (Page ID) ? Page Access Token" });
      try {
        const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=feed,messages&access_token=${encodeURIComponent(token)}`;
        const subRes = await fetch(url, { method: "POST" });
        const bodyText = await subRes.text();
        if (subRes.ok) {
          const data = JSON.parse(bodyText || "{}") as { success?: boolean };
          if (data.success !== false) {
            return res.json({ success: true, message: "??????? feed?????????????????????????????????????" });
          }
        }
        const errMsg = bodyText.slice(0, 400);
        console.log("[FB] subscribe-feed failed:", subRes.status, errMsg);
        return res.json({ success: false, message: `???? (${subRes.status})?${errMsg || subRes.statusText}` });
      } catch (e: any) {
        console.error("[FB] subscribe-feed error:", e?.message);
        return res.status(500).json({ message: e?.message || "????" });
      }
    });

    app.get("/api/knowledge-files", authMiddleware, (_req, res) => {
      return res.json(storage.getKnowledgeFiles());
    });

    app.post("/api/knowledge-files", authMiddleware, managerOrAbove, upload.single("file"), async (req, res) => {
      if (!req.file) return res.status(400).json({ message: "????????????????????.txt, .csv, .pdf, .docx, .xlsx, .md???????????????" });
      const decodedFilename = fixMulterFilename(req.file.originalname);
      console.log("[???] ???????:", decodedFilename);
      const ext = path.extname(decodedFilename).toLowerCase();
      if (isImageFile(decodedFilename)) {
        const filePath = path.join(uploadDir, req.file.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(400).json({ message: "????????????????????????????????" });
      }
      const brandId = req.body.brand_id ? parseInt(req.body.brand_id) : undefined;
      let content: string | undefined;
      try {
        const filePath = path.join(uploadDir, req.file.filename);
        content = await parseFileContent(filePath, decodedFilename);
        if (content) content = stripBOM(content);
        if (content && content.length > 500000) {
          content = content.substring(0, 500000) + "\n\n[????????????]";
        }
      } catch (err) {
        console.error(`[???] ?????? ${decodedFilename}:`, err);
        content = `[??????: ${decodedFilename}]`;
      }
      const file = storage.createKnowledgeFile(req.file.filename, decodedFilename, req.file.size, brandId, content || undefined);
      return res.json(file);
    });

    app.delete("/api/knowledge-files/:id", authMiddleware, managerOrAbove, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const files = storage.getKnowledgeFiles();
      const file = files.find((f) => f.id === id);
      if (file) {
        const filePath = path.join(uploadDir, file.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      if (!storage.deleteKnowledgeFile(id)) return res.status(404).json({ message: "???????" });
      return res.json({ success: true });
    });

    app.get("/api/image-assets", authMiddleware, (req, res) => {
      const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
      return res.json(storage.getImageAssets(brandId));
    });

    app.post("/api/image-assets", authMiddleware, managerOrAbove, imageAssetUpload.single("file"), (req, res) => {
      if (!req.file) return res.status(400).json({ message: "??????????????? .jpg, .jpeg, .png, .gif, .webp" });
      const decodedFilename = fixMulterFilename(req.file.originalname);
      console.log("[????] ???????:", decodedFilename);
      const brandId = req.body.brand_id ? parseInt(req.body.brand_id) : undefined;
      const displayName = req.body.display_name ? fixMulterFilename(req.body.display_name) : decodedFilename;
      const description = req.body.description || "";
      const keywords = req.body.keywords || "";
      const asset = storage.createImageAsset(req.file.filename, decodedFilename, displayName, description, keywords, req.file.size, req.file.mimetype, brandId);
      return res.json(asset);
    });

    app.put("/api/image-assets/:id", authMiddleware, managerOrAbove, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const { display_name, description, keywords } = req.body;
      const data: Record<string, string> = {};
      if (display_name !== undefined) data.display_name = display_name;
      if (description !== undefined) data.description = description;
      if (keywords !== undefined) data.keywords = keywords;
      if (!storage.updateImageAsset(id, data)) return res.status(404).json({ message: "???????" });
      return res.json({ success: true });
    });

    app.delete("/api/image-assets/:id", authMiddleware, managerOrAbove, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const asset = storage.getImageAsset(id);
      if (asset) {
        const filePath = path.join(imageAssetsDir, asset.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      if (!storage.deleteImageAsset(id)) return res.status(404).json({ message: "???????" });
      return res.json({ success: true });
    });

    app.get("/api/image-assets/file/:filename", (req, res) => {
      const safeFilename = path.basename(req.params.filename || "");
      const filePath = path.join(imageAssetsDir, safeFilename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ message: "???????" });
      res.sendFile(filePath);
    });

    app.get("/api/settings/tag-shortcuts", authMiddleware, (req, res) => {
      const list = storage.getTagShortcuts();
      return res.json(list);
    });

    app.put("/api/settings/tag-shortcuts", authMiddleware, managerOrAbove, (req: any, res) => {
      const body = req.body;
      const list = Array.isArray(body) ? body : (body?.tags ?? body?.list ?? []);
      const tags = list.map((t: any, i: number) => ({ name: String(t?.name ?? t).trim(), order: typeof t?.order === "number" ? t.order : i })).filter((t: { name: string; order: number }) => t.name);
      storage.setTagShortcuts(tags);
      return res.json(storage.getTagShortcuts());
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

    app.get("/api/settings/schedule", authMiddleware, (req, res) => {
      const schedule = storage.getGlobalSchedule();
      return res.json(schedule);
    });

    app.put("/api/settings/schedule", authMiddleware, superAdminOnly, (req: any, res) => {
      const { work_start_time, work_end_time, lunch_start_time, lunch_end_time } = req.body || {};
      if (work_start_time != null) storage.setSetting("work_start_time", String(work_start_time));
      if (work_end_time != null) storage.setSetting("work_end_time", String(work_end_time));
      if (lunch_start_time != null) storage.setSetting("lunch_start_time", String(lunch_start_time));
      if (lunch_end_time != null) storage.setSetting("lunch_end_time", String(lunch_end_time));
      return res.json(storage.getGlobalSchedule());
    });

    app.get("/api/settings/assignment-rules", authMiddleware, (req, res) => {
      return res.json({
        human_first_reply_sla_minutes: storage.getSlaMinutes(),
        assignment_auto_enabled: storage.getAssignmentAutoEnabled(),
        assignment_timeout_reassign_enabled: storage.getAssignmentTimeoutReassignEnabled(),
      });
    });

    app.put("/api/settings/assignment-rules", authMiddleware, superAdminOnly, (req: any, res) => {
      const { human_first_reply_sla_minutes, assignment_auto_enabled, assignment_timeout_reassign_enabled } = req.body || {};
      if (human_first_reply_sla_minutes != null) {
        const n = Math.min(120, Math.max(1, parseInt(String(human_first_reply_sla_minutes), 10) || 10));
        storage.setSetting("human_first_reply_sla_minutes", String(n));
      }
      if (assignment_auto_enabled !== undefined) storage.setSetting("assignment_auto_enabled", assignment_auto_enabled ? "1" : "0");
      if (assignment_timeout_reassign_enabled !== undefined) storage.setSetting("assignment_timeout_reassign_enabled", assignment_timeout_reassign_enabled ? "1" : "0");
      return res.json({
        human_first_reply_sla_minutes: storage.getSlaMinutes(),
        assignment_auto_enabled: storage.getAssignmentAutoEnabled(),
        assignment_timeout_reassign_enabled: storage.getAssignmentTimeoutReassignEnabled(),
      });
    });

    app.get("/api/marketing-rules", authMiddleware, (_req, res) => {
      return res.json(storage.getMarketingRules());
    });

    app.post("/api/marketing-rules", authMiddleware, managerOrAbove, (req, res) => {
      const { keyword, pitch, url } = req.body;
      if (!keyword) return res.status(400).json({ message: "??????" });
      const rule = storage.createMarketingRule(keyword, pitch || "", url || "");
      return res.json({ success: true, rule });
    });

    app.put("/api/marketing-rules/:id", authMiddleware, managerOrAbove, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      const { keyword, pitch, url } = req.body;
      if (!keyword) return res.status(400).json({ message: "??????" });
      if (!storage.updateMarketingRule(id, keyword, pitch || "", url || "")) {
        return res.status(404).json({ message: "???????" });
      }
      return res.json({ success: true });
    });

    app.delete("/api/marketing-rules/:id", authMiddleware, managerOrAbove, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "??? ID" });
      if (!storage.deleteMarketingRule(id)) return res.status(404).json({ message: "???????" });
      return res.json({ success: true });
    });
}
