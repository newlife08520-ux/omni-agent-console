/**
 * Phase 3：規則命中後自動執行 — 接上 reply / hide / 導 LINE / 標記，並防重複執行。
 * 僅在留言建立後（Webhook 或模擬）呼叫一次；以 tryClaimAutoExecution 做 idempotency。
 */
import type { MetaComment, MetaCommentRule, MetaCommentTemplate, MetaPageSettings } from "@shared/schema";
import type { MetaCommentMainStatus } from "@shared/schema";
import * as metaCommentsStorage from "./meta-comments-storage";
import { resolveCommentMetadata } from "./meta-comment-resolver";
import { checkHighRiskByRule, checkLineRedirectByRule, checkSafeConfirmByRule, COMFORT_MESSAGE } from "./meta-comment-guardrail";
import { FALLBACK_AFTER_SALE_LINE_LABEL } from "./safe-after-sale-classifier";
import { evaluateRiskRules } from "./meta-comment-risk-rules";
import { replyToComment, hideComment } from "./meta-facebook-comment-api";
import { storage } from "./storage";
import { recordAutoReplyBlocked } from "./auto-reply-blocked";

const EXECUTOR_AUTO = "auto";

function getPageSettings(pageId: string): MetaPageSettings | undefined {
  return metaCommentsStorage.getMetaPageSettingsByPageId(pageId);
}

function getChannelToken(pageId: string): string | null {
  const ch = storage.getChannelByBotId(pageId);
  return ch?.access_token ?? null;
}

/** 規則優先：先風險規則五桶，再 guardrail，再 line_redirect，再一般規則。回傳要寫入的更新與是否為敏感/客訴。 */
function classifyByRulesOnly(comment: MetaComment): {
  updates: Partial<{
    ai_intent: string;
    priority: string;
    ai_suggest_hide: number;
    ai_suggest_human: number;
    reply_first: string | null;
    reply_second: string | null;
    applied_rule_id: number | null;
    applied_template_id: number | null;
    reply_link_source: string | null;
    classifier_source: "rule";
    matched_rule_keyword: string | null;
    reply_flow_type: string | null;
    is_hidden: number;
    is_human_handled: number;
    matched_risk_rule_id: number | null;
    matched_rule_bucket: string | null;
    main_status: string | null;
  }>;
  isSensitive: boolean;
  ruleHide: boolean;
  ruleToHuman: boolean;
  hasReplyContent: boolean;
} {
  const msg = (comment.message || "").trim();
  const updates: Record<string, unknown> = {};
  let isSensitive = false;
  let ruleHide = false;
  let ruleToHuman = false;
  let hasReplyContent = false;

  // 0) 留言風險與導流規則（五桶）：hide_and_route → direct_hide → route_only → gray_area → whitelist
  const risk = evaluateRiskRules(msg, comment.brand_id ?? null, comment.page_id ?? null);
  if (risk) {
    updates.matched_risk_rule_id = risk.matched_rule_id;
    updates.matched_rule_bucket = risk.matched_rule_bucket;
    updates.classifier_source = "rule";
    updates.matched_rule_keyword = risk.matched_keyword;

    if (risk.matched_rule_bucket === "hide_and_route") {
      const lineAfterSaleTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_after_sale");
      const comfortFirst = (lineAfterSaleTpl?.reply_comfort || lineAfterSaleTpl?.reply_dm_guide || COMFORT_MESSAGE).trim();
      Object.assign(updates, {
        ai_intent: "refund_after_sale",
        priority: "urgent",
        ai_suggest_hide: 1,
        ai_suggest_human: risk.action_mark_to_human ? 1 : 0,
        reply_first: risk.action_reply ? comfortFirst : null,
        reply_second: null,
        reply_link_source: "risk_rule",
        reply_flow_type: "comfort_line",
      });
      isSensitive = true;
      hasReplyContent = !!(risk.action_reply && comfortFirst);
      return { updates: updates as any, isSensitive, ruleHide: false, ruleToHuman: !!risk.action_mark_to_human, hasReplyContent };
    }
    if (risk.matched_rule_bucket === "direct_hide") {
      ruleHide = true;
      return { updates: updates as any, isSensitive: false, ruleHide, ruleToHuman: false, hasReplyContent: false };
    }
    if (risk.matched_rule_bucket === "route_only") {
      const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
      const lineSecond = (lineGeneralTpl?.reply_dm_guide || "這題比較適合由客服一對一幫你確認，我們把 LINE 放這邊給你 🤍").trim();
      Object.assign(updates, {
        ai_intent: "dm_guide",
        priority: "normal",
        ai_suggest_hide: 0,
        ai_suggest_human: 0,
        reply_first: risk.action_reply ? "感謝您的留言～" : null,
        reply_second: risk.action_reply ? lineSecond : null,
        reply_link_source: "risk_rule",
        reply_flow_type: "line_redirect",
      });
      hasReplyContent = !!risk.action_reply;
      return { updates: updates as any, isSensitive: false, ruleHide: false, ruleToHuman: false, hasReplyContent };
    }
    if (risk.matched_rule_bucket === "gray_area") {
      updates.main_status = "gray_area";
      return { updates: updates as any, isSensitive: false, ruleHide: false, ruleToHuman: false, hasReplyContent: false };
    }
    // whitelist: 僅寫入 matched_*，繼續走下方 guardrail / 一般規則
  }

  // 0b) 安全確認分流：平台／詐騙／待確認來源 → 不先承認責任，用對應模板（先於一般 guardrail）
  const safeConfirm = checkSafeConfirmByRule(msg);
  if (safeConfirm.matched) {
    const categoryByType: Record<"fraud_impersonation" | "external_platform" | "safe_confirm_order", string> = {
      fraud_impersonation: "fraud_impersonation",
      external_platform: "external_platform_order",
      safe_confirm_order: "safe_confirm_order",
    };
    const tplCategory = categoryByType[safeConfirm.type];
    const tpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, tplCategory);
    const pageSettings = comment.page_id ? getPageSettings(comment.page_id) : undefined;
    const rawLine = (pageSettings?.line_after_sale ?? "").trim();
    const lineUrl = rawLine || FALLBACK_AFTER_SALE_LINE_LABEL;
    if (!rawLine && comment.page_id) {
      console.warn("[SafeAfterSale] 售後 LINE 未設定（待補資料）", { page_id: comment.page_id, brand_id: comment.brand_id });
    }
    const replacePlaceholder = (s: string) => (s || "").replace(/\{after_sale_line_url\}/g, lineUrl);
    const first = replacePlaceholder(tpl?.reply_first ?? "").trim();
    const second = (tpl?.reply_second && replacePlaceholder(tpl.reply_second).trim()) || null;
    Object.assign(updates, {
      ai_intent: safeConfirm.type === "fraud_impersonation" ? "fraud_impersonation" : "external_or_unknown_order",
      priority: "urgent",
      ai_suggest_hide: safeConfirm.suggest_hide ? 1 : 0,
      ai_suggest_human: safeConfirm.suggest_human ? 1 : 0,
      reply_first: first || null,
      reply_second: second,
      applied_rule_id: null,
      applied_template_id: tpl?.id ?? null,
      reply_link_source: "none",
      classifier_source: "rule",
      matched_rule_keyword: safeConfirm.keyword,
      reply_flow_type: "comfort_line",
    });
    isSensitive = true;
    hasReplyContent = !!(first || second);
    return { updates: updates as any, isSensitive, ruleHide: false, ruleToHuman: safeConfirm.suggest_human, hasReplyContent };
  }

  // 1) Guardrail：客訴/退款關鍵字（未命中風險規則時）→ 敏感，安撫+導 LINE
  const guardrail = checkHighRiskByRule(msg);
  if (guardrail.matched) {
    const lineAfterSaleTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_after_sale");
    const comfortFirst = (lineAfterSaleTpl?.reply_comfort || lineAfterSaleTpl?.reply_dm_guide || COMFORT_MESSAGE).trim();
    Object.assign(updates, {
      ai_intent: guardrail.intent,
      priority: "urgent",
      ai_suggest_hide: guardrail.suggest_hide ? 1 : 0,
      ai_suggest_human: 1,
      reply_first: comfortFirst || COMFORT_MESSAGE,
      reply_second: null,
      applied_rule_id: null,
      applied_template_id: lineAfterSaleTpl?.id ?? null,
      reply_link_source: "none",
      classifier_source: "rule",
      matched_rule_keyword: guardrail.keyword,
      reply_flow_type: "comfort_line",
    });
    isSensitive = true;
    hasReplyContent = !!((updates.reply_first as string)?.trim());
    return { updates: updates as any, isSensitive, ruleHide: false, ruleToHuman: false, hasReplyContent };
  }

  // 2) Line redirect 關鍵字 → 簡答+導 LINE（非敏感）
  const lineRedirect = checkLineRedirectByRule(msg);
  if (lineRedirect.matched) {
    const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
    const lineSecond = (lineGeneralTpl?.reply_dm_guide || "這題比較適合由客服一對一幫你確認，我們把 LINE 放這邊給你 🤍").trim();
    Object.assign(updates, {
      ai_intent: "dm_guide",
      priority: "normal",
      ai_suggest_hide: 0,
      ai_suggest_human: 1,
      reply_first: "感謝您的留言～",
      reply_second: lineSecond,
      applied_rule_id: null,
      applied_template_id: lineGeneralTpl?.id ?? null,
      reply_link_source: "none",
      classifier_source: "rule",
      matched_rule_keyword: lineRedirect.keyword,
      reply_flow_type: "line_redirect",
    });
    hasReplyContent = true;
    return { updates: updates as any, isSensitive: false, ruleHide: false, ruleToHuman: false, hasReplyContent };
  }

  // 3) 一般規則（hide / to_human / use_template）
  const allRules = metaCommentsStorage.getMetaCommentRules(comment.brand_id ?? undefined);
  const enabledRules = (allRules as MetaCommentRule[]).filter((r) => r.enabled !== 0).sort((a, b) => b.priority - a.priority);
  for (const r of enabledRules) {
    if (!r.keyword_pattern || !msg.includes(r.keyword_pattern)) continue;
    if (r.rule_type === "to_human") {
      Object.assign(updates, {
        is_human_handled: 1,
        ai_intent: comment.ai_intent || "complaint",
        priority: "urgent",
        ai_suggest_human: 1,
        applied_rule_id: r.id,
        applied_template_id: null,
        reply_first: "感謝您的留言，我們已轉專人為您處理，請私訊我們以利後續聯繫。",
        reply_second: null,
        reply_link_source: "none",
        classifier_source: "rule",
        matched_rule_keyword: r.keyword_pattern,
      });
      ruleToHuman = true;
      hasReplyContent = !!((updates.reply_first as string)?.trim());
      return { updates: updates as any, isSensitive: false, ruleHide: false, ruleToHuman, hasReplyContent };
    }
    if (r.rule_type === "hide") {
      Object.assign(updates, {
        applied_rule_id: r.id,
        applied_template_id: null,
        reply_first: null,
        reply_second: null,
        reply_link_source: "none",
        classifier_source: "rule",
        matched_rule_keyword: r.keyword_pattern,
      });
      ruleHide = true;
      return { updates: updates as any, isSensitive: false, ruleHide, ruleToHuman: false, hasReplyContent: false };
    }
    if (r.rule_type === "use_template" && r.template_id) {
      const templates = metaCommentsStorage.getMetaCommentTemplates(comment.brand_id ?? undefined);
      const t = templates.find((x) => x.id === r.template_id) as MetaCommentTemplate | undefined;
      if (t) {
        Object.assign(updates, {
          applied_rule_id: r.id,
          applied_template_id: t.id,
          reply_first: t.reply_first || null,
          reply_second: t.reply_second || null,
          reply_link_source: "manual_template",
          classifier_source: "rule",
          matched_rule_keyword: r.keyword_pattern,
          reply_flow_type: "product_link",
        });
        hasReplyContent = !!((t.reply_first || t.reply_second || "").trim());
      }
    }
    break;
  }

  return { updates: updates as any, isSensitive: false, ruleHide, ruleToHuman, hasReplyContent };
}

/** 依目前留言狀態與執行結果計算主狀態 */
export function computeMainStatus(c: {
  replied_at?: string | null;
  is_hidden?: number;
  is_human_handled?: number;
  reply_error?: string | null;
  hide_error?: string | null;
  reply_first?: string | null;
  reply_second?: string | null;
  target_line_type?: string | null;
  target_line_value?: string | null;
  reply_flow_type?: string | null;
  /** 敏感件未隱藏成功時，不得算 auto_replied，保留在例外列表 */
  ai_suggest_hide?: number | null;
  matched_rule_bucket?: string | null;
}): MetaCommentMainStatus {
  const hasError = !!(c.reply_error?.trim() || c.hide_error?.trim());
  const replyOk = !!c.replied_at;
  const hideOk = c.is_hidden === 1;
  const sensitiveShouldHide = c.ai_suggest_hide === 1 || c.matched_rule_bucket === "hide_and_route";

  if (hasError) {
    if (replyOk || hideOk) return "partial_success";
    return "failed";
  }
  if (c.is_hidden === 1) {
    const hadReply = !!((c.reply_first ?? c.reply_second)?.trim());
    return hadReply ? "hidden" : "hidden_completed";
  }
  if (c.is_human_handled === 1 && replyOk) return "human_replied";
  if (replyOk) {
    if (sensitiveShouldHide && !hideOk) return "routed_line";
    return "auto_replied";
  }
  if (c.is_human_handled === 1) return "to_human";
  if ((c.target_line_type && c.target_line_value) || c.reply_flow_type === "line_redirect" || c.reply_flow_type === "comfort_line") return "routed_line";
  if ((c.reply_first ?? c.reply_second)?.trim()) return "pending_send";
  return "unhandled";
}

/** 執行公開回覆並寫回 DB */
async function executeReply(commentId: number, message: string, pageId: string): Promise<{ success: boolean; error?: string }> {
  const token = getChannelToken(pageId);
  if (!token) {
    metaCommentsStorage.updateMetaComment(commentId, {
      reply_error: "缺少該粉專的 Page access token",
      platform_error: "未設定或未匹配 channel",
      main_status: "failed",
    });
    metaCommentsStorage.insertMetaCommentAction({ comment_id: commentId, action_type: "reply", success: 0, error_message: "缺少 Page token", executor: EXECUTOR_AUTO });
    return { success: false, error: "缺少 Page access token" };
  }
  const comment = metaCommentsStorage.getMetaComment(commentId);
  if (!comment || comment.replied_at) return { success: false, error: "已回覆過或留言不存在" };

  const result = await replyToComment({
    commentId: comment.comment_id,
    message,
    pageAccessToken: token,
  });
  const now = new Date().toISOString();
  if (result.success) {
    metaCommentsStorage.updateMetaComment(commentId, {
      replied_at: now,
      reply_error: null,
      platform_error: null,
      auto_replied_at: now,
    });
    metaCommentsStorage.insertMetaCommentAction({
      comment_id: commentId,
      action_type: "reply",
      success: 1,
      platform_response: result.platform_response ?? null,
      executor: EXECUTOR_AUTO,
    });
    return { success: true };
  }
  const errMsg = [result.error, result.platform_code && `(code: ${result.platform_code})`].filter(Boolean).join(" ");
  metaCommentsStorage.updateMetaComment(commentId, {
    reply_error: result.error ?? "未知錯誤",
    platform_error: result.platform_response ?? errMsg,
  });
  metaCommentsStorage.insertMetaCommentAction({
    comment_id: commentId,
    action_type: "reply",
    success: 0,
    error_message: result.error ?? undefined,
    platform_response: result.platform_response ?? undefined,
    executor: EXECUTOR_AUTO,
  });
  return { success: false, error: result.error };
}

/** 執行隱藏並寫回 DB */
async function executeHide(commentId: number, pageId: string): Promise<{ success: boolean; error?: string }> {
  const token = getChannelToken(pageId);
  if (!token) {
    metaCommentsStorage.updateMetaComment(commentId, {
      hide_error: "缺少該粉專的 Page access token",
      platform_error: "未設定或未匹配 channel",
      main_status: "failed",
    });
    metaCommentsStorage.insertMetaCommentAction({ comment_id: commentId, action_type: "hide", success: 0, error_message: "缺少 Page token", executor: EXECUTOR_AUTO });
    return { success: false, error: "缺少 Page access token" };
  }
  const comment = metaCommentsStorage.getMetaComment(commentId);
  if (!comment || comment.is_hidden === 1) return { success: false, error: "已隱藏過或留言不存在" };

  const result = await hideComment({
    commentId: comment.comment_id,
    pageAccessToken: token,
  });
  const now = new Date().toISOString();
  if (result.success) {
    metaCommentsStorage.updateMetaComment(commentId, {
      is_hidden: 1,
      auto_hidden_at: now,
      hide_error: null,
    });
    metaCommentsStorage.insertMetaCommentAction({
      comment_id: commentId,
      action_type: "hide",
      success: 1,
      platform_response: result.platform_response ?? null,
      executor: EXECUTOR_AUTO,
    });
    return { success: true };
  }
  const errMsg = [result.error, result.platform_code && `(code: ${result.platform_code})`].filter(Boolean).join(" ");
  metaCommentsStorage.updateMetaComment(commentId, { hide_error: result.error ?? "未知錯誤", platform_error: errMsg });
  metaCommentsStorage.insertMetaCommentAction({
    comment_id: commentId,
    action_type: "hide",
    success: 0,
    error_message: result.error ?? undefined,
    platform_response: result.platform_response ?? undefined,
    executor: EXECUTOR_AUTO,
  });
  return { success: false, error: result.error };
}

/**
 * Phase 3 主入口：規則命中後自動執行。
 * 防重複：僅在 auto_execution_run_at 為空時嘗試佔用，佔到才執行平台動作。
 */
export async function runAutoExecution(commentId: number): Promise<void> {
  const comment = metaCommentsStorage.getMetaComment(commentId);
  if (!comment) return;
  if (comment.auto_execution_run_at) {
    return; // 已跑過，不再執行
  }

  const pageSettings = getPageSettings(comment.page_id);
  const msg = (comment.message || "").trim();

  // 1) 規則分類（僅規則，不呼叫 AI）
  const { updates, isSensitive, ruleHide, ruleToHuman, hasReplyContent } = classifyByRulesOnly(comment);
  if (Object.keys(updates).length > 0) {
    metaCommentsStorage.updateMetaComment(commentId, updates);
  }

  // 2) 解析 metadata（商品、導向 LINE）；敏感用 after_sale
  const isSensitiveOrComplaint = isSensitive || ruleToHuman || (comment.priority === "urgent") || ["complaint", "refund_after_sale"].includes(comment.ai_intent || "");
  const resolved = resolveCommentMetadata({
    brand_id: comment.brand_id ?? null,
    page_id: comment.page_id,
    post_id: comment.post_id,
    post_name: comment.post_name ?? null,
    message: msg,
    is_sensitive_or_complaint: isSensitiveOrComplaint,
  });
  metaCommentsStorage.updateMetaComment(commentId, {
    detected_product_name: resolved.detected_product_name,
    detected_product_source: resolved.detected_product_source,
    detected_post_title_source: resolved.detected_post_title_source,
    post_display_name: resolved.post_display_name,
    target_line_type: resolved.target_line_type,
    target_line_value: resolved.target_line_value,
    auto_routed_at: resolved.target_line_value ? new Date().toISOString() : null,
  });

  const afterResolve = metaCommentsStorage.getMetaComment(commentId)!;
  if (afterResolve.main_status === "gray_area") {
    metaCommentsStorage.updateMetaComment(commentId, {
      auto_execution_run_at: new Date().toISOString(),
    });
    return;
  }

  // 若無粉專設定，不 claim 執行、不寫 auto_execution_run_at，讓補好設定後可重跑
  if (!pageSettings) {
    metaCommentsStorage.updateMetaComment(commentId, {
      main_status: "pending_config",
      blocked_reason: "no_page_settings",
    });
    recordAutoReplyBlocked(storage, {
      reason: "blocked:no_page_settings",
      commentId,
      pageId: comment.page_id,
      brandId: comment.brand_id ?? undefined,
    });
    return;
  }

  // 確認 page 對應 channel token 可用後才 claim，避免標記已執行卻無法送平台
  const channelToken = getChannelToken(comment.page_id);
  if (!channelToken) {
    metaCommentsStorage.updateMetaComment(commentId, {
      main_status: "pending_config",
      blocked_reason: "no_channel_token",
    });
    recordAutoReplyBlocked(storage, {
      reason: "blocked:no_channel_token",
      commentId,
      pageId: comment.page_id,
      brandId: comment.brand_id ?? undefined,
    });
    return;
  }

  const autoReplyEnabled = pageSettings.auto_reply_enabled === 1;
  const autoHideSensitive = pageSettings.auto_hide_sensitive === 1;

  // 3) 佔用：僅在可執行平台動作時寫入 auto_execution_run_at，之後不再重跑
  const claimed = metaCommentsStorage.tryClaimAutoExecution(commentId);
  if (!claimed) return;

  let replyOk = false;
  let hideOk = false;
  const c = metaCommentsStorage.getMetaComment(commentId)!;
  const replyFirst = (c.reply_first ?? "").trim();
  const replySecond = (c.reply_second ?? "").trim();
  const replyMessage = [replyFirst, replySecond].filter(Boolean).join("\n\n");

  // 4) 敏感 / 客訴 SOP：可先公開安撫再隱藏（若開關允許）
  if (isSensitiveOrComplaint && autoHideSensitive) {
    if (autoReplyEnabled && replyMessage && !c.replied_at) {
      const replyResult = await executeReply(commentId, replyMessage, comment.page_id);
      replyOk = replyResult.success;
    }
    const afterReply = metaCommentsStorage.getMetaComment(commentId)!;
    if (afterReply.is_hidden !== 1) {
      const hideResult = await executeHide(commentId, comment.page_id);
      hideOk = hideResult.success;
    } else {
      hideOk = true;
    }
    const final = metaCommentsStorage.getMetaComment(commentId)!;
    metaCommentsStorage.updateMetaComment(commentId, {
      priority: "urgent",
      is_human_handled: 1,
      main_status: computeMainStatus(final),
    });
    return;
  }

  // 5) 規則 hide：只隱藏
  if (ruleHide && autoHideSensitive) {
    await executeHide(commentId, comment.page_id);
    metaCommentsStorage.updateMetaComment(commentId, {
      main_status: computeMainStatus(metaCommentsStorage.getMetaComment(commentId)!),
    });
    return;
  }

  // 6) 一般規則（use_template / line_redirect）：自動回覆
  if (autoReplyEnabled && replyMessage && !c.replied_at) {
    await executeReply(commentId, replyMessage, comment.page_id);
  }

  metaCommentsStorage.updateMetaComment(commentId, {
    main_status: computeMainStatus(metaCommentsStorage.getMetaComment(commentId)!),
  });
}
