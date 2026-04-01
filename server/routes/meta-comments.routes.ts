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

export function registerMetaCommentsRoutes(app: Express): void {
    app.get("/api/meta-comments", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const page_id = req.query.page_id ? String(req.query.page_id) : undefined;
      const post_id = req.query.post_id ? String(req.query.post_id) : undefined;
      const status = (req.query.status as metaCommentsStorage.MetaCommentStatusFilter) || "all";
      const source = (req.query.source as "all" | "real" | "simulated") || "all";
      const archive_delay_minutes = req.query.archive_delay_minutes != null ? parseInt(String(req.query.archive_delay_minutes)) : 5;
      const list = metaCommentsStorage.getMetaComments({ brand_id, page_id, post_id, status, source, archive_delay_minutes });
      const enriched = list.map((c) => {
        let brandName: string | null = null;
        if (c.brand_id != null) brandName = storage.getBrand(c.brand_id)?.name ?? null;
        if (brandName == null && c.page_id) {
          const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(c.page_id);
          if (pageSettings?.brand_id != null) brandName = storage.getBrand(pageSettings.brand_id)?.name ?? null;
        }
        const mainStatus = c.main_status || computeMainStatus(c);
        const blocked_reason = c.blocked_reason ?? undefined;
        return { ...c, brand_name: brandName ?? null, main_status: mainStatus, blocked_reason };
      });
      res.setHeader("Content-Type", "application/json");
      return res.json(enriched);
    });
    app.get("/api/meta-comments/summary", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const summary = metaCommentsStorage.getMetaCommentsSummary({ brand_id: brand_id ?? null });
      res.setHeader("Content-Type", "application/json");
      return res.json(summary);
    });
    app.get("/api/meta-comments/health", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const health = metaCommentsStorage.getMetaCommentsHealth({ brand_id: brand_id ?? null });
      res.setHeader("Content-Type", "application/json");
      return res.json(health);
    });
    app.get("/api/meta-comments/spot-check", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const limit = req.query.limit != null ? parseInt(String(req.query.limit)) : 20;
      const rows = metaCommentsStorage.getMetaCommentsRandomCompleted({ brand_id: brand_id ?? null, limit });
      const enriched = rows.map((c) => {
        let brandName: string | null = null;
        if (c.brand_id != null) brandName = storage.getBrand(c.brand_id)?.name ?? null;
        if (brandName == null && c.page_id) {
          const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(c.page_id);
          if (pageSettings?.brand_id != null) brandName = storage.getBrand(pageSettings.brand_id)?.name ?? null;
        }
        const mainStatus = c.main_status || computeMainStatus(c);
        return { ...c, brand_name: brandName ?? null, main_status: mainStatus };
      });
      res.setHeader("Content-Type", "application/json");
      return res.json(enriched);
    });
    app.get("/api/meta-comments/gray-spot-check", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const limit = req.query.limit != null ? parseInt(String(req.query.limit)) : 20;
      const rows = metaCommentsStorage.getMetaCommentsGraySpotCheck({ brand_id: brand_id ?? null, limit });
      const enriched = rows.map((c) => {
        let brandName: string | null = null;
        if (c.brand_id != null) brandName = storage.getBrand(c.brand_id)?.name ?? null;
        if (brandName == null && c.page_id) {
          const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(c.page_id);
          if (pageSettings?.brand_id != null) brandName = storage.getBrand(pageSettings.brand_id)?.name ?? null;
        }
        const mainStatus = c.main_status || computeMainStatus(c);
        return { ...c, brand_name: brandName ?? null, main_status: mainStatus };
      });
      res.setHeader("Content-Type", "application/json");
      return res.json(enriched);
    });
    app.get("/api/meta-comment-risk-rules", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const bucket = (req.query.bucket as "whitelist" | "direct_hide" | "hide_and_route" | "route_only" | "gray_area") || undefined;
      const page_id = req.query.page_id != null && req.query.page_id !== "" ? String(req.query.page_id) : undefined;
      const enabled = req.query.enabled === "1" ? 1 : req.query.enabled === "0" ? 0 : undefined;
      const q = req.query.q != null && String(req.query.q).trim() !== "" ? String(req.query.q).trim() : undefined;
      const list = riskRules.getRiskRules({ brand_id: brand_id ?? null, bucket: bucket ?? null, page_id: page_id ?? null, enabled: enabled ?? null, q: q ?? null });
      res.setHeader("Content-Type", "application/json");
      return res.json(list);
    });
    app.get("/api/meta-comment-risk-rules/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const row = riskRules.getRiskRule(id);
      if (!row) return res.status(404).json({ message: "???????" });
      return res.json(row);
    });
    app.post("/api/meta-comment-risk-rules", authMiddleware, (req: any, res) => {
      const body = req.body || {};
      const row = riskRules.createRiskRule({
        rule_name: body.rule_name ?? "",
        rule_bucket: body.rule_bucket,
        keyword_pattern: body.keyword_pattern ?? "",
        match_type: body.match_type ?? "contains",
        priority: body.priority ?? 0,
        enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1,
        brand_id: body.brand_id ?? null,
        page_id: body.page_id ?? null,
        action_reply: body.action_reply ? 1 : 0,
        action_hide: body.action_hide ? 1 : 0,
        action_route_line: body.action_route_line ? 1 : 0,
        route_line_type: body.route_line_type ?? null,
        action_mark_to_human: body.action_mark_to_human ? 1 : 0,
        action_use_template_id: body.action_use_template_id ?? null,
        notes: body.notes ?? null,
      });
      res.setHeader("Content-Type", "application/json");
      return res.json(row);
    });
    app.put("/api/meta-comment-risk-rules/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const body = req.body || {};
      riskRules.updateRiskRule(id, {
        rule_name: body.rule_name,
        rule_bucket: body.rule_bucket,
        keyword_pattern: body.keyword_pattern,
        match_type: body.match_type,
        priority: body.priority,
        enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
        brand_id: body.brand_id,
        page_id: body.page_id,
        action_reply: body.action_reply !== undefined ? (body.action_reply ? 1 : 0) : undefined,
        action_hide: body.action_hide !== undefined ? (body.action_hide ? 1 : 0) : undefined,
        action_route_line: body.action_route_line !== undefined ? (body.action_route_line ? 1 : 0) : undefined,
        route_line_type: body.route_line_type,
        action_mark_to_human: body.action_mark_to_human !== undefined ? (body.action_mark_to_human ? 1 : 0) : undefined,
        action_use_template_id: body.action_use_template_id,
        notes: body.notes,
      });
      return res.json({ success: true });
    });
    app.delete("/api/meta-comment-risk-rules/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const ok = riskRules.deleteRiskRule(id);
      if (!ok) return res.status(404).json({ message: "???????" });
      return res.json({ success: true });
    });
    app.post("/api/meta-comments/test-rules", authMiddleware, (req: any, res) => {
      const body = req.body || {};
      const message = (body.message ?? "").trim();
      const brand_id = body.brand_id != null ? parseInt(String(body.brand_id)) : undefined;
      const page_id = body.page_id ?? null;
      const { matches, final: result, reason, decisionSummary } = riskRules.evaluateRiskRulesWithCandidates(message, brand_id ?? null, page_id);
      const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(page_id || "");
      let targetLineName = "";
      if (result && result.action_route_line && result.route_line_type && pageSettings) {
        targetLineName = result.route_line_type === "after_sale" ? (pageSettings.line_after_sale || "?? LINE") : (pageSettings.line_general || "?? LINE");
      }
      res.setHeader("Content-Type", "application/json");
      return res.json({
        message,
        matches,
        final: result,
        reason,
        decisionSummary: decisionSummary ?? "",
        matched: !!result,
        matched_rule_id: result?.matched_rule_id ?? null,
        matched_rule_bucket: result?.matched_rule_bucket ?? null,
        matched_keyword: result?.matched_keyword ?? null,
        rule_name: result?.rule_name ?? null,
        action_reply: !!result?.action_reply,
        action_hide: !!result?.action_hide,
        action_route_line: !!result?.action_route_line,
        route_line_type: result?.route_line_type ?? null,
        target_line_display: targetLineName || (result?.route_line_type ?? ""),
        action_mark_to_human: !!result?.action_mark_to_human,
      });
    });
    // ??????????????????? /:id ????
    app.get("/api/meta-comments/assignable-agents", authMiddleware, (req: any, res) => {
      const members = storage.getTeamMembers().filter((m: any) => m.role === "cs_agent" || m.role === "super_admin" || m.role === "marketing_manager");
      const list = members.map((m: any) => {
        const u = storage.getUserById(m.id);
        return {
          id: m.id,
          display_name: m.display_name || u?.display_name || m.username,
          avatar_url: (u as any)?.avatar_url ?? null,
        };
      });
      res.setHeader("Content-Type", "application/json");
      return res.json(list);
    });
    app.get("/api/meta-comments/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const row = metaCommentsStorage.getMetaComment(id);
      if (!row) return res.status(404).json({ message: "???????" });
      let brandName: string | null = null;
      if (row.brand_id != null) brandName = storage.getBrand(row.brand_id)?.name ?? null;
      if (brandName == null && row.page_id) {
        const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(row.page_id);
        if (pageSettings?.brand_id != null) brandName = storage.getBrand(pageSettings.brand_id)?.name ?? null;
      }
      const mainStatus = row.main_status || computeMainStatus(row);
      const blocked_reason = row.blocked_reason ?? undefined;
      return res.json({ ...row, brand_name: brandName ?? null, main_status: mainStatus, blocked_reason });
    });
    app.post("/api/meta-comments/:id/mark-gray-reviewed", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const row = metaCommentsStorage.getMetaComment(id);
      if (!row) return res.status(404).json({ message: "???????" });
      const current = row.main_status || computeMainStatus(row);
      if (current !== "gray_area") return res.status(400).json({ message: "????????????" });
      metaCommentsStorage.updateMetaComment(id, { main_status: "completed" });
      return res.json({ success: true, main_status: "completed" });
    });
    // ?? Webhook????????? Meta ?? payload ????????
    app.post("/api/meta-comments/simulate-webhook", authMiddleware, (req: any, res) => {
      res.setHeader("Content-Type", "application/json");
      const body = req.body || {};
      const value = body.entry?.[0]?.changes?.[0]?.value ?? body;
      const commentId = value.comment_id || value.id || `sim_webhook_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const from = value.from ?? {};
      const commenterName = typeof from.name === "string" ? from.name : (body.commenter_name || "????");
      const commenterId = from.id ?? body.commenter_id ?? null;
      const message = value.message ?? body.message ?? "";
      const postId = value.post_id ?? body.post_id ?? "post_sim";
      const pageId = value.page_id ?? body.page_id ?? "page_sim";
      try {
        const resolved = resolveCommentMetadata({
          brand_id: body.brand_id ?? null,
          page_id: pageId,
          post_id: postId,
          post_name: body.post_name ?? "????",
          message: message || "(???)",
        });
        const row = metaCommentsStorage.createMetaComment({
          brand_id: body.brand_id ?? null,
          page_id: pageId,
          page_name: body.page_name ?? "????",
          post_id: postId,
          post_name: body.post_name ?? "????",
          comment_id: commentId,
          commenter_id: commenterId,
          commenter_name: commenterName,
          message: message || "(???)",
          is_simulated: 1,
          ...resolved,
        });
        console.log("[meta-comments] simulate-webhook ???? id=%s", row.id);
        setImmediate(() => runAutoExecution(row.id).catch((e: any) => console.error("[meta-comments] runAutoExecution error:", e?.message)));
        return res.json(row);
      } catch (e: any) {
        console.error("[meta-comments] simulate-webhook ??:", e?.message);
        if (e.message?.includes("UNIQUE")) return res.status(400).json({ message: "? ID ???" });
        return res.status(500).json({ message: e?.message || "????" });
      }
    });

    // ????????????????????????????????
    app.post("/api/meta-comments/seed-test-cases", authMiddleware, (req: any, res) => {
      res.setHeader("Content-Type", "application/json");
      const body = req.body || {};
      const brandId = body.brand_id ?? null;
      const pageId = body.page_id || "page_demo";
      const pageName = body.page_name || "????";
      const postId = body.post_id || "post_001";
      const postName = body.post_name || "????";
      const cases = [
        { name: "??A", message: "???????????????", label: "??????" },
        { name: "??B", message: "????", label: "????" },
        { name: "??C", message: "??????", label: "???" },
        { name: "??D", message: "+1 ??", label: "????" },
        { name: "??E", message: "????????????????????", label: "??" },
        { name: "??F", message: "????", label: "??" },
      ];
      const created: MetaComment[] = [];
      const ts = Date.now();
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const commentId = `sim_seed_${ts}_${i}_${Math.random().toString(36).slice(2)}`;
        try {
          const isSensitive = ["??E", "??F"].includes(c.name) || ["??", "??"].some((l) => c.label.includes(l));
          const resolved = resolveCommentMetadata({
            brand_id: brandId,
            page_id: pageId,
            post_id: postId,
            post_name: postName,
            message: c.message,
            is_sensitive_or_complaint: isSensitive,
          });
          const row = metaCommentsStorage.createMetaComment({
            brand_id: brandId,
            page_id: pageId,
            page_name: pageName,
            post_id: postId,
            post_name: postName,
            comment_id: commentId,
            commenter_name: c.name,
            message: c.message,
            is_simulated: 1,
            ...resolved,
          });
          created.push(row);
        } catch (_) {}
      }
      console.log("[meta-comments] seed-test-cases ?? %s ?", created.length);
      setImmediate(() => {
        created.forEach((r) => runAutoExecution(r.id).catch((e: any) => console.error("[meta-comments] runAutoExecution error:", e?.message)));
      });
      return res.json({ created: created.length, ids: created.map((r) => r.id), comments: created });
    });

    // ??? mapping???????????????????????????
    app.post("/api/meta-comments/test-mapping", authMiddleware, (req: any, res) => {
      res.setHeader("Content-Type", "application/json");
      const mappingId = req.body?.mapping_id != null ? parseInt(String(req.body.mapping_id)) : NaN;
      if (Number.isNaN(mappingId)) return res.status(400).json({ message: "??? mapping_id" });
      const mappings = metaCommentsStorage.getMetaPostMappings();
      const mapping = mappings.find((m) => m.id === mappingId);
      if (!mapping) return res.status(404).json({ message: "?????? mapping" });
      const commentId = `sim_mapping_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      try {
        const resolved = resolveCommentMetadata({
          brand_id: mapping.brand_id,
          page_id: mapping.page_id || "page_demo",
          post_id: mapping.post_id,
          post_name: mapping.post_name || "????",
          message: "???????",
        });
        const row = metaCommentsStorage.createMetaComment({
          brand_id: mapping.brand_id,
          page_id: mapping.page_id || "page_demo",
          page_name: mapping.page_name || "????",
          post_id: mapping.post_id,
          post_name: mapping.post_name || "????",
          comment_id: commentId,
          commenter_name: "????",
          message: "???????",
          is_simulated: 1,
          ...resolved,
        });
        console.log("[meta-comments] test-mapping ???? id=%s for mapping id=%s", row.id, mappingId);
        return res.json(row);
      } catch (e: any) {
        return res.status(500).json({ message: e?.message || "????" });
      }
    });

    app.post("/api/meta-comments", authMiddleware, (req: any, res) => {
      const body = req.body || {};
      const isSimulated = body.is_simulated ? 1 : 0;
      const commentId = body.comment_id || (isSimulated ? `sim_${Date.now()}_${Math.random().toString(36).slice(2)}` : `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      try {
        const resolved = resolveCommentMetadata({
          brand_id: body.brand_id ?? null,
          page_id: body.page_id || "page_sim",
          post_id: body.post_id || "post_sim",
          post_name: body.post_name,
          message: body.message || "",
          is_sensitive_or_complaint: body.priority === "urgent" || ["complaint", "refund_after_sale"].includes(body.ai_intent || ""),
        });
        const row = metaCommentsStorage.createMetaComment({
          brand_id: body.brand_id,
          page_id: body.page_id || "page_sim",
          page_name: body.page_name,
          post_id: body.post_id || "post_sim",
          post_name: body.post_name,
          comment_id: commentId,
          commenter_id: body.commenter_id,
          commenter_name: body.commenter_name || "??",
          message: body.message || "",
          ai_intent: body.ai_intent,
          issue_type: body.issue_type,
          priority: body.priority || "normal",
          ai_suggest_hide: body.ai_suggest_hide ? 1 : 0,
          ai_suggest_human: body.ai_suggest_human ? 1 : 0,
          reply_first: body.reply_first,
          reply_second: body.reply_second,
          is_simulated: isSimulated,
          ...resolved,
        });
        return res.json(row);
      } catch (e: any) {
        if (e.message?.includes("UNIQUE")) return res.status(400).json({ message: "? ID ???" });
        return res.status(500).json({ message: e?.message || "????" });
      }
    });
    app.put("/api/meta-comments/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const row = metaCommentsStorage.getMetaComment(id);
      if (!row) return res.status(404).json({ message: "???????" });
      const body = req.body || {};
      metaCommentsStorage.updateMetaComment(id, {
        replied_at: body.replied_at !== undefined ? body.replied_at : undefined,
        is_hidden: body.is_hidden !== undefined ? (body.is_hidden ? 1 : 0) : undefined,
        is_dm_sent: body.is_dm_sent !== undefined ? (body.is_dm_sent ? 1 : 0) : undefined,
        is_human_handled: body.is_human_handled !== undefined ? (body.is_human_handled ? 1 : 0) : undefined,
        contact_id: body.contact_id !== undefined ? body.contact_id : undefined,
        reply_first: body.reply_first !== undefined ? body.reply_first : undefined,
        reply_second: body.reply_second !== undefined ? body.reply_second : undefined,
        issue_type: body.issue_type,
        priority: body.priority,
        tags: body.tags,
        ai_intent: body.ai_intent !== undefined ? body.ai_intent : undefined,
        applied_template_id: body.applied_template_id !== undefined ? body.applied_template_id : undefined,
        reply_link_source: body.reply_link_source !== undefined ? body.reply_link_source : undefined,
        assigned_agent_id: body.assigned_agent_id !== undefined ? body.assigned_agent_id : undefined,
        assigned_agent_name: body.assigned_agent_name !== undefined ? body.assigned_agent_name : undefined,
        assigned_agent_avatar_url: body.assigned_agent_avatar_url !== undefined ? body.assigned_agent_avatar_url : undefined,
        assignment_method: body.assignment_method !== undefined ? body.assignment_method : undefined,
        assigned_at: body.assigned_at !== undefined ? body.assigned_at : undefined,
        main_status: body.main_status !== undefined ? body.main_status : undefined,
      });
      const updated = metaCommentsStorage.getMetaComment(id)!;
      if (!updated.main_status && body.main_status == null) {
        metaCommentsStorage.updateMetaComment(id, { main_status: computeMainStatus(updated) });
      }
      return res.json(metaCommentsStorage.getMetaComment(id));
    });
    // ???????
    app.post("/api/meta-comments/:id/assign", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const comment = metaCommentsStorage.getMetaComment(id);
      if (!comment) return res.status(404).json({ message: "???????" });
      const { agent_id, agent_name, agent_avatar_url } = req.body || {};
      if (agent_id == null) return res.status(400).json({ message: "??????" });
      const now = new Date().toISOString();
      metaCommentsStorage.updateMetaComment(id, {
        assigned_agent_id: Number(agent_id),
        assigned_agent_name: agent_name ?? String(agent_id),
        assigned_agent_avatar_url: agent_avatar_url ?? null,
        assignment_method: "manual",
        assigned_at: now,
      });
      return res.json(metaCommentsStorage.getMetaComment(id));
    });
    // ?????
    app.post("/api/meta-comments/:id/unassign", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const comment = metaCommentsStorage.getMetaComment(id);
      if (!comment) return res.status(404).json({ message: "???????" });
      metaCommentsStorage.updateMetaComment(id, {
        assigned_agent_id: null,
        assigned_agent_name: null,
        assigned_agent_avatar_url: null,
        assignment_method: null,
        assigned_at: null,
      });
      return res.json(metaCommentsStorage.getMetaComment(id));
    });
    app.post("/api/meta-comments/:id/suggest-reply", authMiddleware, async (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const comment = metaCommentsStorage.getMetaComment(id);
      if (!comment) return res.status(404).json({ message: "???????" });
      const openaiKey = storage.getSetting("openai_api_key");
      if (!openaiKey) return res.status(400).json({ message: "???? OpenAI API Key" });
      const model = resolveOpenAIModel();
      const INTENTS = "product_inquiry, price_inquiry, where_to_buy, ingredient_effect, activity_engage, dm_guide, complaint, refund_after_sale, spam_competitor";

      try {
        const openai = new OpenAI({ apiKey: openaiKey });
        const msg = comment.message;
        let appliedRuleId: number | null = null;
        let appliedTemplateId: number | null = null;
        let useTemplateForReply: MetaCommentTemplate | null = null;

        // ---------- Step 0a: ????????????????????????? ? ????????????
        const safeConfirm = checkSafeConfirmByRule(msg);
        if (safeConfirm.matched) {
          const categoryByType: Record<string, string> = {
            fraud_impersonation: "fraud_impersonation",
            external_platform: "external_platform_order",
            safe_confirm_order: "safe_confirm_order",
          };
          const tplCategory = categoryByType[safeConfirm.type];
          const tpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, tplCategory);
          const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(comment.page_id || "");
          const rawLine = (pageSettings?.line_after_sale ?? "").trim();
          const lineUrl = rawLine || FALLBACK_AFTER_SALE_LINE_LABEL;
          if (!rawLine && comment.page_id) {
            console.warn("[SafeAfterSale] ?? LINE ?????????", { page_id: comment.page_id, comment_id: id });
          }
          const replacePlaceholder = (s: string) => (s || "").replace(/\{after_sale_line_url\}/g, lineUrl);
          const first = replacePlaceholder(tpl?.reply_first ?? "").trim();
          const second = (tpl?.reply_second && replacePlaceholder(tpl.reply_second).trim()) || null;
          metaCommentsStorage.updateMetaComment(id, {
            ai_intent: safeConfirm.type === "fraud_impersonation" ? "fraud_impersonation" : "external_or_unknown_order",
            priority: "urgent",
            ai_suggest_hide: safeConfirm.suggest_hide ? 1 : 0,
            ai_suggest_human: safeConfirm.suggest_human ? 1 : 0,
            reply_first: first || null,
            reply_second: second,
            applied_rule_id: null,
            applied_template_id: tpl?.id ?? null,
            applied_mapping_id: null,
            reply_link_source: "none",
            classifier_source: "rule",
            matched_rule_keyword: safeConfirm.keyword,
            reply_flow_type: "comfort_line",
          });
          const updated = metaCommentsStorage.getMetaComment(id)!;
          return res.json({ ...updated, classifier_source: "rule" as const, matched_rule_keyword: safeConfirm.keyword });
        }

        // ---------- Step 0: Deterministic rule-based guardrail???/??/??/??/?????? ? ??+? LINE???? AI?
        const guardrail = checkHighRiskByRule(msg);
        if (guardrail.matched) {
          console.log("[meta-comments] suggest-reply guardrail hit: id=%s keyword=%s intent=%s", id, guardrail.keyword, guardrail.intent);
          const lineAfterSaleTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_after_sale");
          const comfortFirst = (lineAfterSaleTpl?.reply_comfort || lineAfterSaleTpl?.reply_dm_guide || COMFORT_MESSAGE).trim();
          metaCommentsStorage.updateMetaComment(id, {
            ai_intent: guardrail.intent,
            priority: "urgent",
            ai_suggest_hide: guardrail.suggest_hide ? 1 : 0,
            ai_suggest_human: 1,
            reply_first: comfortFirst || COMFORT_MESSAGE,
            reply_second: null,
            applied_rule_id: appliedRuleId,
            applied_template_id: lineAfterSaleTpl?.id ?? null,
            applied_mapping_id: null,
            reply_link_source: "none",
            classifier_source: "rule",
            matched_rule_keyword: guardrail.keyword,
            reply_flow_type: "comfort_line",
          });
          const updated = metaCommentsStorage.getMetaComment(id)!;
          return res.json({ ...updated, classifier_source: "rule" as const, matched_rule_keyword: guardrail.keyword });
        }

        // ---------- Step 0b: Deterministic???? LINE????????/??/???/???/????/???????? ????+? LINE???? AI
        const lineRedirectRule = checkLineRedirectByRule(msg);
        if (lineRedirectRule.matched) {
          console.log("[meta-comments] suggest-reply line_redirect rule hit: id=%s keyword=%s", id, lineRedirectRule.keyword);
          const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
          const lineSecond = (lineGeneralTpl?.reply_dm_guide || "???????????????????? LINE ????? ??").trim();
          const shortPrompt = "??????????????????????????????????? JSON?{\"reply_first\":\"...\"}";
          const shortRes = await openai.chat.completions.create({
            model,
            messages: [
              { role: "system", content: shortPrompt },
              { role: "user", content: `????${msg}?` },
            ],
            response_format: { type: "json_object" },
          });
          const shortText = shortRes.choices[0]?.message?.content || "{}";
          const shortParsed = JSON.parse(shortText) as { reply_first?: string };
          const reply_first_line = (shortParsed.reply_first || "???????").trim();
          metaCommentsStorage.updateMetaComment(id, {
            ai_intent: "dm_guide",
            priority: "normal",
            ai_suggest_hide: 0,
            ai_suggest_human: 1,
            reply_first: reply_first_line,
            reply_second: lineSecond,
            applied_rule_id: appliedRuleId,
            applied_template_id: lineGeneralTpl?.id ?? null,
            applied_mapping_id: null,
            reply_link_source: "none",
            classifier_source: "rule",
            matched_rule_keyword: lineRedirectRule.keyword,
            reply_flow_type: "line_redirect",
          });
          const updated = metaCommentsStorage.getMetaComment(id)!;
          return res.json({ ...updated, classifier_source: "rule" as const, matched_rule_keyword: lineRedirectRule.keyword });
        }

        // ---------- Step 1: ??????????????? priority ??????????????
        const allRules = metaCommentsStorage.getMetaCommentRules(comment.brand_id ?? undefined);
        const enabledRules = allRules.filter((r) => r.enabled !== 0).sort((a, b) => b.priority - a.priority);
        for (const r of enabledRules) {
          if (!r.keyword_pattern || !msg.includes(r.keyword_pattern)) continue;
          appliedRuleId = r.id;
          if (r.rule_type === "to_human") {
            metaCommentsStorage.updateMetaComment(id, {
              is_human_handled: 1,
              ai_intent: comment.ai_intent || "complaint",
              priority: "urgent",
              ai_suggest_human: 1,
              applied_rule_id: r.id,
              applied_template_id: null,
              applied_mapping_id: null,
              reply_first: "??????????????????????????????",
              reply_second: null,
              reply_link_source: "none",
            });
            const updated = metaCommentsStorage.getMetaComment(id);
            return res.json(updated);
          }
          if (r.rule_type === "hide") {
            metaCommentsStorage.updateMetaComment(id, {
              is_hidden: 1,
              applied_rule_id: r.id,
              applied_template_id: null,
              applied_mapping_id: null,
              reply_first: null,
              reply_second: null,
              reply_link_source: "none",
            });
            const updated = metaCommentsStorage.getMetaComment(id);
            return res.json(updated);
          }
          if (r.rule_type === "use_template" && r.template_id) {
            const templates = metaCommentsStorage.getMetaCommentTemplates(comment.brand_id ?? undefined);
            const t = templates.find((x) => x.id === r.template_id);
            if (t) {
              useTemplateForReply = t;
              appliedTemplateId = t.id;
            }
          }
          break; // ??????????
        }

        // ---------- Step 2: AI ???????????/??/???/??/??? LINE/????/??/???
        const classifyPrompt = `??????????????? JSON????????
  ???????? exactly ????${INTENTS}
  ?????
  - ?????????????????? price_inquiry?
  - ??????????????? where_to_buy?
  - ?????????????????? ingredient_effect?
  - ?+1?????????????????? activity_engage?
  - ????????????????????????????????????????????????????????? ?? dm_guide?suggest_human ? true?????? LINE ?????
  - ?????????????????????????????????? complaint ? refund_after_sale?is_high_risk=true?
  - ??????????? ? refund_after_sale?is_high_risk=true?
  ????????????dm_guide ????? LINE ??????
  ?????{"intent":"????", "is_high_risk": true?false, "suggest_hide": true?false, "suggest_human": true?false}`;
        const classifyRes = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: classifyPrompt },
            { role: "user", content: `????${msg}?` },
          ],
          response_format: { type: "json_object" },
        });
        const classifyText = classifyRes.choices[0]?.message?.content || "{}";
        const cls = JSON.parse(classifyText) as { intent?: string; is_high_risk?: boolean; suggest_hide?: boolean; suggest_human?: boolean };
        let isHighRisk = !!cls.is_high_risk;
        const suggestHide = !!cls.suggest_hide;
        let intent = cls.intent && INTENTS.includes(cls.intent) ? cls.intent : "product_inquiry";
        let suggestHuman = !!cls.suggest_human;
        if (msg.includes("??") && intent === "product_inquiry") isHighRisk = false;
        if (!isHighRisk && (msg.includes("??") || msg.includes("??") || msg.includes("???") || msg.includes("????") || msg.includes("???") || msg.includes("????"))) {
          intent = "dm_guide";
          suggestHuman = true;
        }
        const priority = isHighRisk ? "urgent" : (comment.priority || "normal");
        metaCommentsStorage.updateMetaComment(id, {
          ai_intent: intent,
          priority,
          ai_suggest_hide: suggestHide ? 1 : 0,
          ai_suggest_human: suggestHuman ? 1 : 0,
          classifier_source: "ai",
          matched_rule_keyword: null,
        });

        // ---------- Step 3: ??? ? ????+? LINE????????? reply_flow_type=comfort_line
        if (isHighRisk) {
          const comfortTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_after_sale");
          const fallbackComfort = comfortTpl?.reply_comfort || comfortTpl?.reply_dm_guide || "??????????????????????????????????";
          const comfortPrompt = "?????????????/??/????????????????????????????????? JSON?{\"reply_comfort\":\"...\"}";
          const comfortRes = await openai.chat.completions.create({
            model,
            messages: [
              { role: "system", content: comfortPrompt },
              { role: "user", content: `????${msg}?` },
            ],
            response_format: { type: "json_object" },
          });
          const comfortText = comfortRes.choices[0]?.message?.content || "{}";
          const comfortParsed = JSON.parse(comfortText) as { reply_comfort?: string };
          const reply_comfort = (comfortParsed.reply_comfort || fallbackComfort).trim();
          metaCommentsStorage.updateMetaComment(id, {
            reply_first: reply_comfort || fallbackComfort,
            reply_second: null,
            applied_rule_id: appliedRuleId,
            applied_template_id: appliedTemplateId,
            applied_mapping_id: null,
            reply_link_source: "none",
            classifier_source: "ai",
            matched_rule_keyword: null,
            reply_flow_type: "comfort_line",
          });
          const updated = metaCommentsStorage.getMetaComment(id)!;
          return res.json({ ...updated, classifier_source: "ai" as const, matched_rule_keyword: null });
        }

        // ---------- Step 3b: ??? LINE?dm_guide ? suggest_human?? ???? + ???? LINE ??
        const shouldRedirectLine = intent === "dm_guide" || suggestHuman;
        if (shouldRedirectLine) {
          const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
          const lineSecond = (lineGeneralTpl?.reply_dm_guide || "???????????????????? LINE ????? ??").trim();
          const shortPrompt = "??????????????????????????????????? JSON?{\"reply_first\":\"...\"}";
          const shortRes = await openai.chat.completions.create({
            model,
            messages: [
              { role: "system", content: shortPrompt },
              { role: "user", content: `????${msg}?` },
            ],
            response_format: { type: "json_object" },
          });
          const shortText = shortRes.choices[0]?.message?.content || "{}";
          const shortParsed = JSON.parse(shortText) as { reply_first?: string };
          const reply_first_line = (shortParsed.reply_first || "???????").trim();
          metaCommentsStorage.updateMetaComment(id, {
            reply_first: reply_first_line,
            reply_second: lineSecond,
            applied_rule_id: appliedRuleId,
            applied_template_id: lineGeneralTpl?.id ?? appliedTemplateId,
            applied_mapping_id: null,
            reply_link_source: "none",
            classifier_source: "ai",
            matched_rule_keyword: null,
            reply_flow_type: "line_redirect",
          });
          const updated = metaCommentsStorage.getMetaComment(id)!;
          return res.json({ ...updated, classifier_source: "ai" as const, matched_rule_keyword: null });
        }

        // ---------- Step 4: ?? mapping?? auto_comment_enabled=1???? fallback?? mapping ??????reply_link_source='none'
        const mapping = metaCommentsStorage.getMappingForComment(comment.brand_id, comment.page_id, comment.post_id);
        const productUrl = mapping ? (mapping.primary_url || mapping.fallback_url || "") : "";
        const linkSource = mapping ? "post_mapping" : "none";
        const toneHint = mapping?.tone_hint || "?????";
        const preferredFlow = (mapping as { preferred_flow?: string } | null)?.preferred_flow;

        // ---------- Step 4b: ????????? LINE???????? ?????+? LINE
        if (preferredFlow === "line_redirect" || preferredFlow === "support_only") {
          const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
          const lineSecond = (lineGeneralTpl?.reply_dm_guide || "???????????????????? LINE ????? ??").trim();
          const shortPrompt = "??????????????????????????????????? JSON?{\"reply_first\":\"...\"}";
          const shortRes = await openai.chat.completions.create({
            model,
            messages: [
              { role: "system", content: shortPrompt },
              { role: "user", content: `????${msg}?` },
            ],
            response_format: { type: "json_object" },
          });
          const shortText = shortRes.choices[0]?.message?.content || "{}";
          const shortParsed = JSON.parse(shortText) as { reply_first?: string };
          const reply_first_line = (shortParsed.reply_first || "???????").trim();
          metaCommentsStorage.updateMetaComment(id, {
            reply_first: reply_first_line,
            reply_second: lineSecond,
            applied_rule_id: appliedRuleId,
            applied_template_id: lineGeneralTpl?.id ?? appliedTemplateId,
            applied_mapping_id: mapping?.id ?? null,
            reply_link_source: "none",
            classifier_source: "ai",
            matched_rule_keyword: null,
            reply_flow_type: "line_redirect",
          });
          const updated = metaCommentsStorage.getMetaComment(id)!;
          return res.json({ ...updated, classifier_source: "ai" as const, matched_rule_keyword: null });
        }

        // ---------- Step 5: ????????? use_template ?????? AI??? AI ????
        let reply_first: string;
        let reply_second: string;
        if (useTemplateForReply) {
          reply_first = useTemplateForReply.reply_first || "";
          reply_second = (useTemplateForReply.reply_second || "").replace(/\{primary_url\}/g, productUrl || "").trim();
          if (productUrl && !reply_second.includes(productUrl)) reply_second = reply_second ? reply_second + " " + productUrl : productUrl;
        } else {
          const dualPrompt = `?????????????????????????????????????????????${toneHint}?????????????
  ???????????????????????????????????????????????????`;
          const userContent = productUrl
            ? `????${msg}?\n??? JSON?{"reply_first":"?????", "reply_second":"??????????????${productUrl}"}`
            : `????${msg}?\n??? JSON?{"reply_first":"?????", "reply_second":"???????????????????????"}`;
          const dualRes = await openai.chat.completions.create({
            model,
            messages: [{ role: "system", content: dualPrompt }, { role: "user", content: userContent }],
            response_format: { type: "json_object" },
          });
          const dualText = dualRes.choices[0]?.message?.content || "{}";
          const dualParsed = JSON.parse(dualText) as { reply_first?: string; reply_second?: string };
          reply_first = dualParsed.reply_first || "";
          reply_second = dualParsed.reply_second || "";
          if (productUrl && reply_second && !reply_second.includes(productUrl)) reply_second = reply_second.trim() + " " + productUrl;
        }

        const replyFlowType = productUrl ? "product_link" : "public_only";
        metaCommentsStorage.updateMetaComment(id, {
          reply_first: reply_first || null,
          reply_second: reply_second || null,
          applied_rule_id: appliedRuleId,
          applied_template_id: appliedTemplateId,
          applied_mapping_id: mapping?.id ?? null,
          reply_link_source: linkSource,
          classifier_source: "ai",
          matched_rule_keyword: null,
          reply_flow_type: replyFlowType,
        });
        const updated = metaCommentsStorage.getMetaComment(id)!;
        return res.json({ ...updated, classifier_source: "ai" as const, matched_rule_keyword: null });
      } catch (e: any) {
        return res.status(500).json({ message: e?.message || "AI ????" });
      }
    });

    app.get("/api/meta-comment-templates", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const list = metaCommentsStorage.getMetaCommentTemplates(brand_id);
      return res.json(list);
    });
    app.post("/api/meta-comment-templates", authMiddleware, (req: any, res) => {
      const body = req.body || {};
      const row = metaCommentsStorage.createMetaCommentTemplate({
        brand_id: body.brand_id,
        category: body.category || "product_inquiry",
        name: body.name || "???",
        reply_first: body.reply_first,
        reply_second: body.reply_second,
        reply_comfort: body.reply_comfort,
        reply_dm_guide: body.reply_dm_guide,
        tone_hint: body.tone_hint,
      });
      return res.json(row);
    });
    app.put("/api/meta-comment-templates/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const body = req.body || {};
      metaCommentsStorage.updateMetaCommentTemplate(id, body);
      return res.json(metaCommentsStorage.getMetaCommentTemplates().find((t) => t.id === id));
    });
    app.delete("/api/meta-comment-templates/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const ok = metaCommentsStorage.deleteMetaCommentTemplate(id);
      return res.json({ success: ok });
    });

    app.get("/api/meta-pages", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const list = metaCommentsStorage.getMetaPagesForDropdown(brand_id ?? undefined);
      return res.json(list);
    });
    app.get("/api/meta-pages/:pageId/posts", authMiddleware, (req: any, res) => {
      const pageId = String(req.params.pageId || "");
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const list = metaCommentsStorage.getMetaPostsByPage(pageId, brand_id ?? undefined);
      return res.json(list);
    });

    /** Meta 批次：以 Meta 使用者 Access Token 取得可用的粉絲專頁列表 */
    app.post("/api/meta/batch/available-pages", authMiddleware, superAdminOnly, async (req: any, res) => {
      const { user_access_token } = req.body || {};
      if (!user_access_token || typeof user_access_token !== "string") {
        return res.status(400).json({ message: "??? user_access_token" });
      }
      try {
        const url = `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(user_access_token)}`;
        const fbRes = await fetch(url);
        if (!fbRes.ok) {
          const errBody = await fbRes.text();
          return res.status(400).json({ message: "Meta API ??", detail: errBody.slice(0, 200) });
        }
        const data = (await fbRes.json()) as { data?: { id: string; name: string; access_token: string }[] };
        const pages = (data.data || []).map((p) => ({
          page_id: p.id,
          page_name: p.name || p.id,
          access_token: p.access_token,
        }));
        return res.json({ pages });
      } catch (e: any) {
        return res.status(500).json({ message: "???????", detail: e?.message });
      }
    });

    /** Meta 批次匯入：建立 channel 與 meta_page_settings，供 AI 留言回覆使用 */
    app.post("/api/meta/batch/import", authMiddleware, superAdminOnly, async (req: any, res) => {
      const { brand_id: brandId, pages: pagesInput } = req.body || {};
      const bid = brandId != null ? parseInt(String(brandId), 10) : NaN;
      if (!Number.isInteger(bid) || bid <= 0) {
        return res.status(400).json({ message: "?????? brand_id" });
      }
      const brand = storage.getBrand(bid);
      if (!brand) return res.status(404).json({ message: "???????" });
      if (!Array.isArray(pagesInput) || pagesInput.length === 0) {
        return res.status(400).json({ message: "??? pages ????????" });
      }
      const results: {
        page_id: string;
        page_name: string;
        channel_id?: number;
        settings_id?: number;
        error?: string;
        message?: string;
        ai_enabled?: number;
        page_settings_created?: boolean;
        next_steps?: string[];
      }[] = [];
      for (const p of pagesInput) {
        const page_id = p?.page_id != null ? String(p.page_id) : "";
        const page_name = p?.page_name != null ? String(p.page_name) : page_id || "???";
        const access_token = p?.access_token != null ? String(p.access_token) : "";
        if (!page_id || !access_token) {
          results.push({ page_id: page_id || "?", page_name, error: "?? page_id ? access_token" });
          continue;
        }
        const existing = metaCommentsStorage.getMetaPageSettingsByPageId(page_id);
        if (existing) {
          results.push({ page_id, page_name, error: "? page ????" });
          continue;
        }
        try {
          const channel = await storage.createChannel(bid, "messenger", page_name, page_id, access_token, "");
          if (channel.is_ai_enabled !== 0) await storage.updateChannel(channel.id, { is_ai_enabled: 0 });
          const settings = metaCommentsStorage.createMetaPageSettings({
            page_id,
            page_name,
            brand_id: bid,
            auto_reply_enabled: 0,
            auto_hide_sensitive: 0,
            auto_route_line_enabled: 0,
          });
          results.push({
            page_id,
            page_name,
            channel_id: channel.id,
            settings_id: settings.id,
            message: "Messenger ???????????AI ????????????????????????",
            ai_enabled: 0,
            page_settings_created: true,
            next_steps: [
              "????????????????? AI?",
              "?????? / ?????????????????????????",
            ],
          });
        } catch (err: any) {
          results.push({ page_id, page_name, error: err?.message || "????" });
        }
      }
      return res.json({ results });
    });

    app.get("/api/meta-products", authMiddleware, (req: any, res) => {
      const q = req.query.q ? String(req.query.q) : undefined;
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const list = metaCommentsStorage.searchMetaProducts(q, brand_id ?? undefined);
      return res.json(list);
    });
    app.get("/api/meta-post-mappings", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const q = (req.query.q as string) || "";
      let list = metaCommentsStorage.getMetaPostMappings(brand_id ?? undefined);
      if (q.trim()) {
        const lower = q.trim().toLowerCase();
        list = list.filter(
          (m) =>
            (m.page_name || "").toLowerCase().includes(lower) ||
            (m.post_name || "").toLowerCase().includes(lower) ||
            (m.post_id || "").toLowerCase().includes(lower) ||
            (m.product_name || "").toLowerCase().includes(lower)
        );
      }
      return res.json(list);
    });
    app.post("/api/meta-post-mappings", authMiddleware, (req: any, res) => {
      const body = req.body || {};
      if (!body.brand_id) return res.status(400).json({ message: "brand_id ??" });
      const pageId = body.page_id ?? null;
      const postId = (body.post_id || "").trim();
      if (!postId) return res.status(400).json({ message: "?? ID ??" });
      const enabled = body.auto_comment_enabled !== 0 ? 1 : 0;
      if (enabled && metaCommentsStorage.hasDuplicateEnabledMapping(body.brand_id, pageId, postId)) {
        return res.status(400).json({ message: "???????????????????????" });
      }
      const row = metaCommentsStorage.createMetaPostMapping({
        brand_id: body.brand_id,
        page_id: pageId,
        page_name: body.page_name,
        post_id: postId,
        post_name: body.post_name,
        product_name: body.product_name,
        primary_url: body.primary_url,
        fallback_url: body.fallback_url,
        tone_hint: body.tone_hint,
        auto_comment_enabled: enabled,
        preferred_flow: body.preferred_flow ?? null,
      });
      return res.json(row);
    });
    app.put("/api/meta-post-mappings/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const body = req.body || {};
      const pageId = body.page_id !== undefined ? body.page_id : undefined;
      const postId = body.post_id !== undefined ? (body.post_id || "").trim() : undefined;
      const enabled = body.auto_comment_enabled !== undefined ? (body.auto_comment_enabled !== 0 ? 1 : 0) : undefined;
      const existing = metaCommentsStorage.getMetaPostMappings().find((m) => m.id === id);
      if (existing && (pageId !== undefined || postId !== undefined || enabled !== undefined)) {
        const finalPageId = pageId !== undefined ? pageId : existing.page_id;
        const finalPostId = postId !== undefined ? postId : existing.post_id;
        const finalEnabled = enabled !== undefined ? enabled : existing.auto_comment_enabled;
        if (finalEnabled && metaCommentsStorage.hasDuplicateEnabledMapping(existing.brand_id, finalPageId, finalPostId, id)) {
          return res.status(400).json({ message: "?????????????????????" });
        }
      }
      metaCommentsStorage.updateMetaPostMapping(id, body);
      const list = metaCommentsStorage.getMetaPostMappings();
      return res.json(list.find((m) => m.id === id));
    });
    app.delete("/api/meta-post-mappings/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const ok = metaCommentsStorage.deleteMetaPostMapping(id);
      return res.json({ success: ok });
    });

    app.get("/api/meta-comment-rules", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const list = metaCommentsStorage.getMetaCommentRules(brand_id);
      return res.json(list);
    });
    app.post("/api/meta-comment-rules", authMiddleware, (req: any, res) => {
      const body = req.body || {};
      const row = metaCommentsStorage.createMetaCommentRule({
        brand_id: body.brand_id,
        page_id: body.page_id,
        post_id: body.post_id,
        priority: body.priority ?? 0,
        rule_type: body.rule_type || "use_template",
        keyword_pattern: body.keyword_pattern || "",
        template_id: body.template_id,
        tag_value: body.tag_value,
        enabled: body.enabled !== 0 ? 1 : 0,
      });
      return res.json(row);
    });
    app.put("/api/meta-comment-rules/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const existing = metaCommentsStorage.getMetaCommentRule(id);
      if (!existing) return res.status(404).json({ message: "???????" });
      const body = req.body || {};
      metaCommentsStorage.updateMetaCommentRule(id, {
        brand_id: body.brand_id !== undefined ? body.brand_id : undefined,
        page_id: body.page_id !== undefined ? body.page_id : undefined,
        post_id: body.post_id !== undefined ? body.post_id : undefined,
        priority: body.priority !== undefined ? body.priority : undefined,
        rule_type: body.rule_type,
        keyword_pattern: body.keyword_pattern,
        template_id: body.template_id !== undefined ? body.template_id : undefined,
        tag_value: body.tag_value !== undefined ? body.tag_value : undefined,
        enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
      });
      const updated = metaCommentsStorage.getMetaCommentRule(id);
      return res.json(updated);
    });
    app.delete("/api/meta-comment-rules/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const ok = metaCommentsStorage.deleteMetaCommentRule(id);
      return res.json({ success: ok });
    });

    app.post("/api/meta-comments/:id/resolve", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const comment = metaCommentsStorage.getMetaComment(id);
      if (!comment) return res.status(404).json({ message: "???????" });
      const resolved = resolveCommentMetadata({
        brand_id: comment.brand_id,
        page_id: comment.page_id,
        post_id: comment.post_id,
        post_name: comment.post_name,
        post_title_from_graph: (comment as any).post_display_name && (comment as any).detected_post_title_source === "graph_api" ? (comment as any).post_display_name : null,
        message: comment.message,
        is_sensitive_or_complaint: comment.priority === "urgent" || ["complaint", "refund_after_sale"].includes(comment.ai_intent || ""),
      });
      metaCommentsStorage.updateMetaComment(id, {
        post_display_name: resolved.post_display_name,
        detected_post_title_source: resolved.detected_post_title_source,
        detected_product_name: resolved.detected_product_name,
        detected_product_source: resolved.detected_product_source,
        target_line_type: resolved.target_line_type,
        target_line_value: resolved.target_line_value,
      });
      return res.json(metaCommentsStorage.getMetaComment(id));
    });

    app.post("/api/meta-comments/:id/reply", authMiddleware, async (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const comment = metaCommentsStorage.getMetaComment(id);
      if (!comment) return res.status(404).json({ message: "???????" });
      const message = (req.body?.message as string)?.trim();
      if (!message) return res.status(400).json({ message: "??? message??????" });
      const channel = storage.getChannelByBotId(comment.page_id);
      if (!channel?.access_token) {
        metaCommentsStorage.updateMetaComment(id, {
          reply_error: "?????? Page access token",
          platform_error: "??????? channel",
        });
        metaCommentsStorage.insertMetaCommentAction({ comment_id: id, action_type: "reply", success: 0, error_message: "?? Page token", executor: "user" });
        return res.status(400).json({ message: "??????? Page access token???????" });
      }
      const result = await replyToComment({
        commentId: comment.comment_id,
        message,
        pageAccessToken: channel.access_token,
      });
      const now = new Date().toISOString();
      if (result.success) {
        metaCommentsStorage.updateMetaComment(id, {
          replied_at: now,
          reply_error: null,
          platform_error: null,
        });
        metaCommentsStorage.insertMetaCommentAction({
          comment_id: id,
          action_type: "reply",
          success: 1,
          platform_response: result.platform_response ?? null,
          executor: "user",
        });
        const updated = metaCommentsStorage.getMetaComment(id)!;
        metaCommentsStorage.updateMetaComment(id, { main_status: computeMainStatus(updated) });
        return res.json(metaCommentsStorage.getMetaComment(id));
      }
      const errMsg = [result.error, result.platform_code && `(code: ${result.platform_code})`].filter(Boolean).join(" ");
      metaCommentsStorage.updateMetaComment(id, {
        reply_error: result.error ?? "????",
        platform_error: result.platform_response ?? errMsg,
        main_status: "failed",
      });
      metaCommentsStorage.insertMetaCommentAction({
        comment_id: id,
        action_type: "reply",
        success: 0,
        error_message: result.error ?? undefined,
        platform_response: result.platform_response ?? undefined,
        executor: "user",
      });
      return res.status(502).json({
        message: "???????",
        error: result.error,
        platform_code: result.platform_code,
      });
    });

    app.post("/api/meta-comments/:id/hide", authMiddleware, async (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const comment = metaCommentsStorage.getMetaComment(id);
      if (!comment) return res.status(404).json({ message: "???????" });
      const channel = storage.getChannelByBotId(comment.page_id);
      if (!channel?.access_token) {
        const errMsg = "?????? Page access token";
        metaCommentsStorage.updateMetaComment(id, { hide_error: errMsg, platform_error: "??????? channel" });
        metaCommentsStorage.insertMetaCommentAction({ comment_id: id, action_type: "hide", success: 0, error_message: errMsg, executor: "user" });
        return res.status(400).json({ message: "??????? Page access token???????" });
      }
      const result = await hideComment({
        commentId: comment.comment_id,
        pageAccessToken: channel.access_token,
      });
      const now = new Date().toISOString();
      if (result.success) {
        metaCommentsStorage.updateMetaComment(id, {
          is_hidden: 1,
          auto_hidden_at: now,
          hide_error: null,
        });
        metaCommentsStorage.insertMetaCommentAction({
          comment_id: id,
          action_type: "hide",
          success: 1,
          platform_response: result.platform_response ?? null,
          executor: "user",
        });
        const updated = metaCommentsStorage.getMetaComment(id)!;
        metaCommentsStorage.updateMetaComment(id, { main_status: computeMainStatus(updated) });
        return res.json(metaCommentsStorage.getMetaComment(id));
      }
      const errMsg = [result.error, result.platform_code && `(code: ${result.platform_code})`].filter(Boolean).join(" ");
      metaCommentsStorage.updateMetaComment(id, { hide_error: result.error ?? "????", platform_error: errMsg, main_status: "failed" });
      metaCommentsStorage.insertMetaCommentAction({
        comment_id: id,
        action_type: "hide",
        success: 0,
        error_message: result.error ?? undefined,
        platform_response: result.platform_response ?? undefined,
        executor: "user",
      });
      return res.status(502).json({
        message: "???????",
        error: result.error,
        platform_code: result.platform_code,
      });
    });

    app.get("/api/meta-page-settings", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const list = metaCommentsStorage.getMetaPageSettingsList(brand_id);
      return res.json(list);
    });
    app.get("/api/meta-page-settings/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const row = metaCommentsStorage.getMetaPageSettings(id);
      if (!row) return res.status(404).json({ message: "?????? mapping" });
      return res.json(row);
    });
    app.get("/api/meta-page-settings/by-page/:pageId", authMiddleware, (req: any, res) => {
      const pageId = String(req.params.pageId || "");
      if (!pageId) return res.status(400).json({ message: "??? page_id" });
      const row = metaCommentsStorage.getMetaPageSettingsByPageId(pageId);
      if (!row) return res.status(404).json({ message: "???????" });
      return res.json(row);
    });
    app.post("/api/meta-page-settings", authMiddleware, (req: any, res) => {
      const body = req.body || {};
      if (!body.page_id?.trim()) return res.status(400).json({ message: "??? page_id" });
      if (body.brand_id == null) return res.status(400).json({ message: "??? brand_id" });
      try {
        const row = metaCommentsStorage.createMetaPageSettings({
          page_id: body.page_id.trim(),
          page_name: body.page_name?.trim() || null,
          brand_id: Number(body.brand_id),
          line_general: body.line_general?.trim() || null,
          line_after_sale: body.line_after_sale?.trim() || null,
          auto_hide_sensitive: body.auto_hide_sensitive ? 1 : 0,
          auto_reply_enabled: body.auto_reply_enabled ? 1 : 0,
          auto_route_line_enabled: body.auto_route_line_enabled ? 1 : 0,
          default_reply_template_id: body.default_reply_template_id != null ? Number(body.default_reply_template_id) : null,
          default_sensitive_template_id: body.default_sensitive_template_id != null ? Number(body.default_sensitive_template_id) : null,
          default_flow: body.default_flow?.trim() || null,
          default_product_name: body.default_product_name?.trim() || null,
        });
        return res.json(row);
      } catch (e: any) {
        if (e.message?.includes("UNIQUE")) return res.status(400).json({ message: "? page_id ?????" });
        return res.status(500).json({ message: e?.message || "????" });
      }
    });
    app.put("/api/meta-page-settings/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const existing = metaCommentsStorage.getMetaPageSettings(id);
      if (!existing) return res.status(404).json({ message: "?????? mapping" });
      const body = req.body || {};
      metaCommentsStorage.updateMetaPageSettings(id, {
        page_name: body.page_name !== undefined ? body.page_name : undefined,
        brand_id: body.brand_id !== undefined ? Number(body.brand_id) : undefined,
        line_general: body.line_general !== undefined ? body.line_general : undefined,
        line_after_sale: body.line_after_sale !== undefined ? body.line_after_sale : undefined,
        auto_hide_sensitive: body.auto_hide_sensitive !== undefined ? (body.auto_hide_sensitive ? 1 : 0) : undefined,
        auto_reply_enabled: body.auto_reply_enabled !== undefined ? (body.auto_reply_enabled ? 1 : 0) : undefined,
        auto_route_line_enabled: body.auto_route_line_enabled !== undefined ? (body.auto_route_line_enabled ? 1 : 0) : undefined,
        default_reply_template_id: body.default_reply_template_id !== undefined ? (body.default_reply_template_id == null ? null : Number(body.default_reply_template_id)) : undefined,
        default_sensitive_template_id: body.default_sensitive_template_id !== undefined ? (body.default_sensitive_template_id == null ? null : Number(body.default_sensitive_template_id)) : undefined,
        default_flow: body.default_flow !== undefined ? body.default_flow : undefined,
        default_product_name: body.default_product_name !== undefined ? body.default_product_name : undefined,
      });
      return res.json(metaCommentsStorage.getMetaPageSettings(id));
    });
    app.delete("/api/meta-page-settings/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const ok = metaCommentsStorage.deleteMetaPageSettings(id);
      return res.json({ success: ok });
    });

    app.get("/api/meta-product-keywords", authMiddleware, (req: any, res) => {
      const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
      const list = metaCommentsStorage.getMetaProductKeywords(brand_id);
      return res.json(list);
    });
    app.post("/api/meta-product-keywords", authMiddleware, (req: any, res) => {
      const body = req.body || {};
      if (!body.keyword?.trim()) return res.status(400).json({ message: "??? keyword" });
      if (!body.product_name?.trim()) return res.status(400).json({ message: "??? product_name" });
      if (!["post", "comment"].includes(body.match_scope)) return res.status(400).json({ message: "match_scope ?? post ? comment" });
      const row = metaCommentsStorage.createMetaProductKeyword({
        brand_id: body.brand_id != null ? Number(body.brand_id) : null,
        keyword: body.keyword.trim(),
        product_name: body.product_name.trim(),
        match_scope: body.match_scope,
      });
      return res.json(row);
    });
    app.delete("/api/meta-product-keywords/:id", authMiddleware, (req: any, res) => {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
      const ok = metaCommentsStorage.deleteMetaProductKeyword(id);
      return res.json({ success: ok });
    });
}
