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
import { isRatingEligible, isAutomatedRatingFlexAllowedForContact } from "../rating-eligibility";
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
import { evaluateContactOverdue, evaluateContactUrgency } from "../services/contact-classification";

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

export function registerContactsOrdersRoutes(app: Express): void {
    /** AI 建議用：依關鍵字建議 issue_type / status / priority（下方為 Unicode 關鍵字） */
    const RETURN_REFUND_KW = ["\u9000", "\u63db", "\u9000\u6b3e", "\u9000\u8ca8"];
    const COMPLAINT_KW = ["\u5ba2\u8a34", "\u62b1\u6028", "\u6295\u8a34", "\u7533\u8a34"];
    const ORDER_MODIFY_KW = ["\u8a02\u55ae", "\u4fee\u6539", "\u6539\u55ae", "\u51fa\u8ca8", "\u5ef6\u907a", "\u53d6\u6d88"];
    const ORDER_INQUIRY_KW = ["\u8a02\u55ae", "\u67e5\u8a62", "\u51fa\u8ca8", "\u7269\u6d41"];
    const PRODUCT_CONSULT_KW = ["\u5546\u54c1", "\u5c3a\u5bf8", "\u898f\u683c", "\u6210\u5206", "\u8b0e\u8a62"];
    const URGENT_TAG_KW = ["\u7dca\u6025", "\u52a0\u6025", "\u6025\u4ef6", "\u512a\u5148", "\u76e1\u5feb"];
    const PRIORITY_HIGH_KW = ["\u9ad8", "\u7dca\u6025", "\u52a0\u6025", "\u6025", "\u512a\u5148"];
    function suggestAiFromMessages(contactId: number): { issue_type?: string; status?: string; priority?: string; tags?: string[] } {
      const messages = storage.getMessages(contactId, { limit: 20 });
      const text = messages.filter((m) => m.sender_type === "user").map((m) => m.content || "").join(" ");
      const suggestions: { issue_type?: string; status?: string; priority?: string; tags?: string[] } = {};
      const has = (kws: string[]) => kws.some((k) => text.includes(k));
      if (has(RETURN_REFUND_KW)) { suggestions.issue_type = "return_refund"; (suggestions.tags = suggestions.tags || []).push("\u9000\u63db"); }
      else if (has(COMPLAINT_KW)) { suggestions.issue_type = "complaint"; (suggestions.tags = suggestions.tags || []).push("\u5ba2\u8a34"); }
      else if (has(ORDER_MODIFY_KW)) { suggestions.issue_type = "order_modify"; (suggestions.tags = suggestions.tags || []).push("\u8a02\u55ae\u4fee\u6539"); }
      else if (has(ORDER_INQUIRY_KW)) { suggestions.issue_type = "order_inquiry"; }
      else if (has(PRODUCT_CONSULT_KW)) { suggestions.issue_type = "product_consult"; (suggestions.tags = suggestions.tags || []).push("\u5546\u54c1\u8b0e\u8a62"); }
      if (has(URGENT_TAG_KW)) (suggestions.tags = suggestions.tags || []).push("\u7dca\u6025");
      if (has(PRIORITY_HIGH_KW) || suggestions.issue_type === "complaint" || suggestions.issue_type === "return_refund") suggestions.priority = "\u9ad8";
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.sender_type === "user") suggestions.status = "\u5f85\u56de\u8986";
      else if (lastMsg?.sender_type === "admin" || lastMsg?.sender_type === "ai") suggestions.status = "\u5df2\u56de\u8986";
      return suggestions;
    }

    app.get("/api/contacts", authMiddleware, (req: any, res) => {
      const routeStart = Date.now();
      const now = new Date();
      const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
      const assignedToMe = req.query.assigned_to_me === "1" || req.query.assigned_to_me === "true";
      const needReplyFirst = req.query.need_reply_first === "1" || req.query.need_reply_first === "true";
      const userId = req.session?.userId;
      const assignedToUserId = assignedToMe && userId ? userId : undefined;
      const agentIdForFlags = userId ?? undefined;
      const limitParam = req.query.limit != null ? parseInt(String(req.query.limit), 10) : undefined;
      const offsetParam = req.query.offset != null ? parseInt(String(req.query.offset), 10) : undefined;
      const limit = (limitParam != null && limitParam > 0 && limitParam <= 500) ? limitParam : 100;
      const offset = (offsetParam != null && offsetParam >= 0) ? offsetParam : 0 as number;
      let contacts = storage.getContacts(brandId, assignedToUserId, agentIdForFlags, limit, offset);
      const afterGet = Date.now();
      if (needReplyFirst) {
        contacts = [...contacts].sort((a, b) => {
          const aNeeds = (a as any).last_message_sender_type === "user" ? 0 : 1;
          const bNeeds = (b as any).last_message_sender_type === "user" ? 0 : 1;
          if (aNeeds !== bNeeds) return aNeeds - bNeeds;
          const aAt = a.last_message_at || "";
          const bAt = b.last_message_at || "";
          return bAt.localeCompare(aAt);
        });
      }
      const withFlags = (contacts as any[]).map((c) => {
        if (!c || typeof c !== "object") return c;
        try {
          return {
            ...c,
            is_urgent: evaluateContactUrgency({ contact: c, now }).isUrgent,
            is_overdue: evaluateContactOverdue({ contact: c, now }),
          };
        } catch (err) {
          return { ...c, is_urgent: false, is_overdue: false };
        }
      });
      const totalMs = Date.now() - routeStart;
      if (totalMs > 2000) {
        console.warn(`[api/contacts] slow: total=${totalMs}ms getContacts=${afterGet - routeStart}ms serialize=${Date.now() - afterGet}ms n=${withFlags.length}`);
      }
      return res.json(withFlags);
    });

    app.get("/api/contacts/:id", authMiddleware, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const contact = storage.getContact(id) as any;
      if (!contact) return res.status(404).json({ message: "找不到聯絡人" });
      // GET 單一聯絡人：資料來自 DB；即時更新另由 SSE 推送
      // AI 建議欄位主要由 Webhook／背景流程寫入，此處不保證為最新
      if (!contact.ai_suggestions && (contact as any).ai_suggestions === undefined) contact.ai_suggestions = null;
      return res.json(contact);
    });

    app.put("/api/contacts/:id/human", authMiddleware, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      if (req.body.needs_human) {
        const c = storage.getContact(id);
        applyHandoff({ contactId: id, reason: "explicit_human_request", source: "api_put_human", brandId: c?.brand_id ?? undefined });
      } else {
        storage.updateContactHumanFlag(id, 0);
      }
      return res.json({ success: true });
    });

    app.put("/api/contacts/:id/status", authMiddleware, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const { status } = req.body;
      const validStatuses = ["pending", "processing", "resolved", "ai_handling", "awaiting_human", "high_risk", "closed", "new_case", "pending_info", "pending_order_id", "assigned", "waiting_customer", "resolved_observe", "reopened"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      const contact = storage.getContact(id);
      if (status === "closed" && contact?.assigned_agent_id) {
        assignment.closeCase(id, contact.assigned_agent_id);
      } else {
        storage.updateContactStatus(id, status);
      }
      broadcastSSE("contacts_updated", { contact_id: id });

      if (status === "resolved" || status === "closed") {
        storage.updateContactConversationFields(id, { customer_goal_locked: null });
        const contactForRating = storage.getContact(id);
        if (
          contactForRating &&
          isRatingEligible({ contact: contactForRating, state: null }) &&
          isAutomatedRatingFlexAllowedForContact(contactForRating, storage)
        ) {
          let ratingSent = false;
          if (contactForRating.needs_human === 1 && contactForRating.cs_rating == null) {
            if (contactForRating.platform === "line") {
              const token = getLineTokenForContact(contactForRating);
              if (token) {
                try {
                  await sendRatingFlexMessage(contactForRating, "human");
                  storage.createMessage(id, contactForRating.platform, "system", "(系統) 已發送真人客服滿意度評價邀請給客戶");
                  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
                  storage.updateContactConversationFields(id, { rating_invited_at: now });
                  ratingSent = true;
                } catch (err) {
                  console.error("Auto rating (human) send failed:", err);
                }
              }
            }
          }
          if (!ratingSent && contactForRating.ai_rating == null) {
            if (contactForRating.platform === "line") {
              const token = getLineTokenForContact(contactForRating);
              if (token) {
                try {
                  await sendRatingFlexMessage(contactForRating, "ai");
                  storage.createMessage(id, contactForRating.platform, "system", "(系統) 已發送 AI 客服滿意度評價邀請給客戶");
                  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
                  storage.updateContactConversationFields(id, { rating_invited_at: now });
                } catch (err) {
                  console.error("Auto rating (ai) send failed:", err);
                }
              }
            }
          }
        }
      }

      return res.json({ success: true });
    });

    app.put("/api/contacts/:id/issue-type", authMiddleware, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const { issue_type } = req.body;
      const validTypes = ["order_inquiry", "product_consult", "return_refund", "complaint", "order_modify", "general", "other"];
      if (issue_type && !validTypes.includes(issue_type)) {
        return res.status(400).json({ message: "Invalid issue type" });
      }
      storage.updateContactIssueType(id, issue_type || null);
      broadcastSSE("contacts_updated", { contact_id: id });
      return res.json({ success: true });
    });

    app.put("/api/contacts/:id/case-priority", authMiddleware, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const v = req.body?.case_priority;
      const priority = v === undefined || v === null || v === "" ? null : Number(v);
      if (priority !== null && (Number.isNaN(priority) || priority < 1 || priority > 5)) {
        return res.status(400).json({ message: "case_priority 須為 1 至 5 的整數或 null" });
      }
      storage.updateContactCasePriority(id, priority);
      broadcastSSE("contacts_updated", { contact_id: id });
      return res.json({ success: true });
    });

    app.get("/api/contacts/:id/ai-logs", authMiddleware, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const logs = storage.getAiLogs(id);
      return res.json(logs);
    });

    app.post("/api/contacts/:id/transfer-human", authMiddleware, (req, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const { reason } = req.body;
      const contact = storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "找不到聯絡人" });
      const transferReason = (reason || "客戶要求真人客服") as string;
      applyHandoff({ contactId, reason: "explicit_human_request", source: "api_transfer_human", brandId: contact.brand_id ?? undefined });
      const assignedAgentId = assignment.assignCase(contactId);
      if (assignedAgentId == null && assignment.isAllAgentsUnavailable()) {
        storage.updateContactNeedsAssignment(contactId, 1);
        const tags = JSON.parse(contact.tags || "[]");
        if (!tags.includes("待指派")) storage.updateContactTags(contactId, [...tags, "待指派"]);
        const reason = assignment.getUnavailableReason();
        storage.createMessage(contactId, contact.platform, "system", transferUnavailableSystemMessage(storage, reason));
      }
      const muteUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      storage.setAiMutedUntil(contactId, muteUntil);
      broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
      broadcastSSE("new_message", { contact_id: contactId });
      console.log(`[Transfer] contact ${contactId} 轉真人：${transferReason}${assignedAgentId != null ? `，已指派 ${assignedAgentId}` : "，尚無可用專員"}`);
      return res.json({ success: true, status: assignedAgentId != null ? "assigned" : "awaiting_human", reason: transferReason, assigned_agent_id: assignedAgentId ?? undefined, all_busy: assignedAgentId == null && assignment.isAllAgentsUnavailable() });
    });

    app.post("/api/contacts/:id/restore-ai", authMiddleware, (req, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const contact = storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "找不到聯絡人" });
      storage.updateContactStatus(contactId, "ai_handling");
      storage.updateContactHumanFlag(contactId, 0);
      storage.clearAiMuted(contactId);
      storage.resetConsecutiveTimeouts(contactId);
      /** 重置為 AI 可處理狀態：清空 product_scope_locked、customer_goal_locked、human_reason 等，讓 AI 重新判斷 */
      storage.updateContactConversationFields(contactId, {
        product_scope_locked: null,
        customer_goal_locked: null,
        human_reason: null,
        return_stage: 0,
        resolution_status: "open",
        waiting_for_customer: null,
      });
      const tags = JSON.parse(contact.tags || "[]") as string[];
      const withoutPending = tags.filter((t) => t !== "待指派");
      if (withoutPending.length !== tags.length) storage.updateContactTags(contactId, withoutPending);
      const prevAgentId = contact.assigned_agent_id;
      storage.updateContactAssignment(contactId, null, undefined, undefined, 0);
      if (prevAgentId != null) assignment.syncAgentOpenCases(prevAgentId);
      broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
      console.log(`[Restore AI] contact ${contactId} 已恢復為 AI 處理（已清除真人相關狀態）`);
      return res.json({ success: true, status: "ai_handling" });
    });

    app.post("/api/contacts/:id/send-rating", authMiddleware, async (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const ratingType = (req.body?.type === "ai" ? "ai" : "human") as "human" | "ai";
      const contact = storage.getContact(id);
      if (!contact) return res.status(404).json({ message: "找不到聯絡人" });
      if (contact.platform !== "line") {
        return res.status(400).json({ message: "此功能僅支援 LINE 平台" });
      }
      // 手動重新發送前：若已有評分則先清除，讓客戶可再次填寫
      if (ratingType === "ai" && contact.ai_rating != null) {
        storage.clearContactAiRating(id);
      }
      if (ratingType === "human" && contact.cs_rating != null) {
        storage.clearContactCsRating(id);
      }
      const token = getLineTokenForContact(contact);
      if (!token) {
        return res.status(400).json({ message: "缺少 LINE Channel Access Token" });
      }
      try {
        await sendRatingFlexMessage(contact, ratingType);
        const typeLabel = ratingType === "ai" ? "AI 客服" : "真人客服";
        storage.createMessage(id, contact.platform, "system", `(系統) 已發送${typeLabel}滿意度評價邀請給客戶`);
        broadcastSSE("contacts_updated", { contact_id: id });
        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ message: "發送評價邀請失敗" });
      }
    });

    app.put("/api/contacts/:id/tags", authMiddleware, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const { tags } = req.body;
      if (!Array.isArray(tags)) return res.status(400).json({ message: "tags must be an array" });
      storage.updateContactTags(id, tags);
      return res.json({ success: true });
    });

    app.put("/api/contacts/:id/agent-flag", authMiddleware, (req: any, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ message: "請先登入" });
      const { flag } = req.body || {};
      const v = flag === "later" || flag === "tracking" ? flag : null;
      if (flag !== undefined && flag !== null && v === null) return res.status(400).json({ message: "flag 須為 'later'、'tracking' 或 null" });
      storage.setAgentContactFlag(userId, id, v);
      return res.json({ success: true, flag: v });
    });

    app.put("/api/contacts/:id/pinned", authMiddleware, (req, res) => {
      const id = parseIdParam(req.params.id);
      if (id === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const { is_pinned } = req.body;
      storage.updateContactPinned(id, is_pinned ? 1 : 0);
      return res.json({ success: true });
    });

    app.get("/api/messages/search", authMiddleware, (req, res) => {
      const q = (req.query.q as string || "").trim();
      if (!q || q.length < 2) return res.json([]);
      return res.json(storage.searchMessages(q));
    });

    app.get("/api/contacts/:id/messages", authMiddleware, (req, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const sinceId = parseInt(req.query.since_id as string) || 0;
      if (sinceId > 0) return res.json(storage.getMessagesSince(contactId, sinceId));
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 80, 1), 500);
      const beforeId = parseInt(req.query.before_id as string) || undefined;
      return res.json(storage.getMessages(contactId, { limit, beforeId: beforeId && beforeId > 0 ? beforeId : undefined }));
    });

    app.post("/api/contacts/:id/messages", authMiddleware, (req, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const { content, message_type, image_url } = req.body;
      if (!content && !image_url) return res.status(400).json({ message: "content or image_url is required" });
      const contact = storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "找不到聯絡人" });
      const msgType = message_type || "text";
      const message = storage.createMessage(contactId, contact.platform, "admin", content || "", msgType, image_url || null);
      storage.updateContactLastHumanReply(contactId);
      broadcastSSE("new_message", { contact_id: contactId, message, brand_id: contact.brand_id });
      broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
      applyHandoff({ contactId, reason: "explicit_human_request", source: "api_admin_message", brandId: contact.brand_id ?? undefined });

      const muteUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      storage.setAiMutedUntil(contactId, muteUntil);
      console.log(`[Hard Mute] 專員發言後暫停 AI contact ${contactId}，靜音至 ${muteUntil}`);

      if (contact.platform === "line") {
        const token = getLineTokenForContact(contact);
        if (token) {
          if (image_url) {
            const protocol = req.headers["x-forwarded-proto"] || req.protocol;
            const host = req.headers["x-forwarded-host"] || req.headers.host;
            const fullImageUrl = image_url.startsWith("http") ? image_url : `${protocol}://${host}${image_url}`;
            fetch("https://api.line.me/v2/bot/message/push", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
              body: JSON.stringify({
                to: contact.platform_user_id,
                messages: [{ type: "image", originalContentUrl: fullImageUrl, previewImageUrl: fullImageUrl }],
              }),
            }).catch((err: unknown) => console.error("LINE image push failed:", err));
          } else if (content) {
            pushLineMessage(contact.platform_user_id, [{ type: "text", text: content }], token).catch((err: unknown) =>
              console.error("LINE text push failed:", err)
            );
          }
        }
      } else if (contact.platform === "messenger") {
        const fbToken = contact.channel_id ? storage.getChannel(contact.channel_id)?.access_token : null;
        if (fbToken && content) {
          sendFBMessage(fbToken, contact.platform_user_id, content).catch((err: unknown) =>
            console.error("FB text push failed:", err)
          );
        }
      }

      return res.json(message);
    });

    app.post("/api/chat-upload", authMiddleware, chatUpload.single("file"), (req, res) => {
      if (!req.file) return res.status(400).json({ message: "請上傳 JPG、PNG、GIF 或 WebP，且檔案須小於 10MB" });
      const fileUrl = `/uploads/${req.file.filename}`;
      return res.json({ url: fileUrl, filename: fixMulterFilename(req.file.originalname), size: req.file.size });
    });

    app.get("/api/contacts/:id/orders", authMiddleware, async (req, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const contact = storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "找不到聯絡人" });
      const config = getSuperLandingConfig(contact.brand_id || undefined);
      if (!config.merchantNo || !config.accessKey) {
        return res.json({ orders: [], error: "not_configured", message: "尚未設定 SuperLanding API 憑證" });
      }
      try {
        const orders = await fetchOrders(config, { per_page: "50" });
        return res.json({ orders });
      } catch (err: any) {
        const errorMap: Record<string, string> = {
          missing_credentials: "未設定 API 憑證",
          invalid_credentials: "API 憑證錯誤，請檢查 merchant_no 與 access_key",
          connection_failed: "無法連線至 SuperLanding API",
        };
        console.error("[訂單] 取得訂單列表失敗:", err.message);
        return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `查詢失敗：${err.message}` });
      }
    });

    app.post("/api/contacts/:id/link-order", authMiddleware, (req: any, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const orderId = (req.body?.order_id as string)?.trim();
      if (!orderId) return res.status(400).json({ message: "請提供 order_id" });
      const contact = storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "找不到聯絡人" });
      try {
        db.prepare(
          "INSERT OR IGNORE INTO contact_order_links (contact_id, global_order_id, source) VALUES (?, ?, 'manual')"
        ).run(contactId, orderId.toUpperCase());
        return res.json({ ok: true });
      } catch (e: any) {
        console.error("[link-order]", e);
        return res.status(500).json({ message: e?.message || "連結訂單失敗" });
      }
    });

    app.get("/api/contacts/:id/linked-orders", authMiddleware, (req, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const contact = storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "找不到聯絡人" });
      const rows = db.prepare("SELECT global_order_id FROM contact_order_links WHERE contact_id = ? ORDER BY created_at DESC")
        .all(contactId) as { global_order_id: string }[];
      return res.json({ order_ids: rows.map((r) => r.global_order_id) });
    });

    app.get("/api/contacts/:id/active-order", authMiddleware, (req, res) => {
      const contactId = parseIdParam(req.params.id);
      if (contactId === null) return res.status(400).json({ message: "無效的聯絡人 ID" });
      const contact = storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "找不到聯絡人" });
      const ctx = storage.getActiveOrderContext(contactId);
      return res.json(ctx ? { active_order: ctx } : { active_order: null });
    });

    app.get("/api/orders/linked-contacts", authMiddleware, (req, res) => {
      const raw = (req.query.order_ids as string) || "";
      const orderIds = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (orderIds.length === 0) return res.json({});
      const placeholders = orderIds.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT global_order_id, contact_id FROM contact_order_links WHERE global_order_id IN (${placeholders})`
      ).all(...orderIds) as { global_order_id: string; contact_id: number }[];
      const map: Record<string, number> = {};
      for (const r of rows) {
        if (map[r.global_order_id] == null) map[r.global_order_id] = r.contact_id;
      }
      const result: Record<string, number | null> = {};
      for (const id of orderIds) result[id] = map[id] ?? null;
      return res.json(result);
    });

    app.get("/api/orders/lookup", authMiddleware, async (req, res) => {
      const { q, brand_id } = req.query;
      const query = (q as string || "").trim().toUpperCase();
      if (!query) return res.status(400).json({ message: "請提供訂單編號" });
      const brandId = brand_id ? parseInt(brand_id as string) : undefined;
      const config = getSuperLandingConfig(brandId);
      try {
        console.log("[訂單查詢] unifiedLookupById:", query, brandId != null ? `(brand_id=${brandId})` : "(全品牌)");
        const result = await unifiedLookupById(config, query, brandId, undefined, false);
        if (!result.found || result.orders.length === 0) {
          return res.json({ orders: [], message: "查無符合的訂單" });
        }
        return res.json({ orders: result.orders });
      } catch (err: any) {
        const errorMap: Record<string, string> = {
          missing_credentials: "未設定 API 憑證",
          invalid_credentials: "API 憑證錯誤，請檢查 merchant_no 與 access_key",
          connection_failed: "無法連線至 SuperLanding API",
        };
        console.error("[訂單查詢] 失敗:", err.message);
        return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `查詢失敗：${err.message}` });
      }
    });

    app.get("/api/orders/search", authMiddleware, async (req, res) => {
      const { q, begin_date, end_date, brand_id } = req.query;
      const query = (q as string || "").trim();
      const beginDate = (begin_date as string || "").trim();
      const endDate = (end_date as string || "").trim();

      if (!query) return res.status(400).json({ message: "請輸入 Email、電話或其他查詢條件" });
      if (!beginDate || !endDate) return res.status(400).json({ message: "請同時提供 begin_date 與 end_date" });

      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(beginDate) || !dateRegex.test(endDate)) {
        return res.status(400).json({ message: "日期格式須為 YYYY-MM-DD" });
      }

      const begin = new Date(beginDate + "T00:00:00");
      const end = new Date(endDate + "T00:00:00");
      if (isNaN(begin.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ message: "日期無效" });
      }
      const diffDays = Math.round((end.getTime() - begin.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays < 0) return res.status(400).json({ message: "結束日期須晚於或等於開始日期" });
      if (diffDays >= 31) return res.status(400).json({ message: "查詢區間不得超過 31 天" });

      const config = getSuperLandingConfig(brand_id ? parseInt(brand_id as string) : undefined);
      if (!config.merchantNo || !config.accessKey) {
        return res.json({ orders: [], error: "not_configured", message: "尚未設定 SuperLanding API 憑證" });
      }

      try {
        console.log(`[訂單搜尋] 條件: q="${query}" ${beginDate}~${endDate}`);
        const result = await lookupOrdersByDateAndFilter(config, query, beginDate, endDate);
        if (result.orders.length === 0) {
          return res.json({ orders: [], totalFetched: result.totalFetched, message: `於 ${beginDate} ~ ${endDate} 區間內以「${query}」查無訂單（已掃描 ${result.totalFetched} 筆）` });
        }
        return res.json({ orders: result.orders, totalFetched: result.totalFetched, truncated: result.truncated });
      } catch (err: any) {
        const errorMap: Record<string, string> = {
          missing_credentials: "未設定 API 憑證",
          invalid_credentials: "API 憑證錯誤，請檢查 merchant_no 與 access_key",
          connection_failed: "無法連線至 SuperLanding API",
        };
        console.error("[訂單搜尋] 失敗:", err.message);
        return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `查詢失敗：${err.message}` });
      }
    });

    app.get("/api/orders/pages", authMiddleware, async (req, res) => {
      const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
      const config = getSuperLandingConfig(brandId);
      if (!config.merchantNo || !config.accessKey) {
        return res.json({ pages: [], error: "not_configured", message: "尚未設定 SuperLanding API 憑證" });
      }
      try {
        const forceRefresh = req.query.refresh === "1";
        const pages = forceRefresh
          ? await refreshPagesCache(config)
          : await ensurePagesCacheLoaded(config);
        return res.json({ pages, cached: !forceRefresh, cacheAge: Math.round(getCachedPagesAge() / 1000) });
      } catch (err: any) {
        const errorMap: Record<string, string> = {
          missing_credentials: "未設定 API 憑證",
          invalid_credentials: "API 憑證錯誤",
          connection_failed: "無法連線至 SuperLanding API",
        };
        return res.json({ pages: [], error: err.message, message: errorMap[err.message] || `查詢失敗：${err.message}` });
      }
    });

    app.get("/api/orders/by-product", authMiddleware, async (req, res) => {
      const { page_id, phone, brand_id } = req.query;
      const pageId = (page_id as string || "").trim();
      const phoneNum = (phone as string || "").trim();

      if (!pageId) return res.status(400).json({ message: "請提供 page_id" });
      if (!phoneNum) return res.status(400).json({ message: "請提供電話號碼" });

      const config = getSuperLandingConfig(brand_id ? parseInt(brand_id as string) : undefined);
      if (!config.merchantNo || !config.accessKey) {
        return res.json({ orders: [], error: "not_configured", message: "尚未設定 SuperLanding API 憑證" });
      }

      try {
        console.log(`[訂單-銷售頁] 查詢: page_id=${pageId} phone=${phoneNum}`);
        const result = await lookupOrdersByPageAndPhone(config, pageId, phoneNum);
        if (result.orders.length === 0) {
          return res.json({ orders: [], totalFetched: result.totalFetched, message: `此銷售頁與電話 ${phoneNum} 無符合訂單（已掃描 ${result.totalFetched} 筆）` });
        }
        return res.json({ orders: result.orders, totalFetched: result.totalFetched, truncated: result.truncated });
      } catch (err: any) {
        const errorMap: Record<string, string> = {
          missing_credentials: "未設定 API 憑證",
          invalid_credentials: "API 憑證錯誤，請檢查 merchant_no 與 access_key",
          connection_failed: "無法連線至 SuperLanding API",
        };
        console.error("[訂單-銷售頁] 失敗:", err.message);
        return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `查詢失敗：${err.message}` });
      }
    });
}
