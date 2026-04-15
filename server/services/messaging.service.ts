import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import crypto from "crypto";
import { storage } from "../storage";
import { uploadDir } from "../middlewares/upload.middleware";

/** Phase 106.2：集中擋空訊息；呼叫端可判斷 skipped（不 throw） */
export type MessagingOutboundSkipped = { skipped: true; reason: "empty_text" | "empty_messages" };

/** Phase 106.21：已成功送達 LINE／Messenger，可安全寫入客戶可見的 AI 訊息 */
export type MessagingDeliveredOk = { delivered: true };
/** Phase 106.21：未送達（已寫 system_alerts／log，gentle 不 throw） */
export type MessagingDeliveredFail = {
  delivered: false;
  reason: "missing_token" | "invalid_args" | "api_error" | "network";
  httpStatus?: number;
};
export type MessagingOutboundResult = MessagingOutboundSkipped | MessagingDeliveredOk | MessagingDeliveredFail;

export function isMessagingDelivered(r: MessagingOutboundResult): r is MessagingDeliveredOk {
  return (r as MessagingDeliveredOk).delivered === true;
}

/** Phase 106.20：最近一次 LINE /v2/bot/info 健康檢查結果（記憶體，重啟清空） */
export type LineTokenHealthEntry = {
  ok: boolean;
  checkedAt: string;
  httpStatus?: number;
  error?: string;
};

const lastLineTokenHealthByChannel = new Map<number, LineTokenHealthEntry>();

export function getLineTokenHealthForReadiness(brandId: number): {
  line_channels: { channel_id: number; ok: boolean | null; checked_at: string | null; http_status?: number; error?: string }[];
} {
  const channels = storage.getChannelsByBrand(brandId).filter((c) => c.platform === "line" && c.is_active === 1);
  return {
    line_channels: channels.map((c) => {
      const s = lastLineTokenHealthByChannel.get(c.id);
      return {
        channel_id: c.id,
        ok: s != null ? s.ok : null,
        checked_at: s?.checkedAt ?? null,
        http_status: s?.httpStatus,
        error: s?.error,
      };
    }),
  };
}

function resolveLineChannelByAccessToken(token: string | null | undefined): { id: number; brand_id: number } | null {
  const t = String(token ?? "").trim();
  if (!t) return null;
  const ch = storage.getChannels().find((c) => c.platform === "line" && String(c.access_token ?? "").trim() === t);
  return ch ? { id: ch.id, brand_id: ch.brand_id } : null;
}

function resolveMessengerChannelByAccessToken(token: string | null | undefined): { id: number; brand_id: number } | null {
  const t = String(token ?? "").trim();
  if (!t) return null;
  const ch = storage.getChannels().find((c) => c.platform === "messenger" && String(c.access_token ?? "").trim() === t);
  return ch ? { id: ch.id, brand_id: ch.brand_id } : null;
}

function safeAlert(data: { alert_type: string; details: string; brand_id?: number; contact_id?: number }): void {
  try {
    storage.createSystemAlert(data);
  } catch {
    /* ignore */
  }
}

type LineSendMeta = {
  api: "push" | "reply";
  channelId: number | null;
  brandId: number | null;
  destLabel: string;
};

async function fetchLineMessagingWithRetry(url: string, body: object, token: string): Promise<Response> {
  const doFetch = () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  let res = await doFetch();
  if (res.status >= 500 && res.status < 600) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await doFetch();
  }
  return res;
}

/**
 * Phase 106.20.1：寫入告警與 log 後 **不 throw**，避免 webhook／AI 管線整段中斷（LINE 仍應回 200）。
 * 呼叫端若需判斷成敗，請改看 DB system_alerts 或後續導入回傳型別。
 */
async function processLineSendFailure(status: number, errText: string, meta: LineSendMeta): Promise<void> {
  const { channelId, brandId, api, destLabel } = meta;
  const snippet = errText.slice(0, 500);
  console.error(`[LINE] ${api} failed status=${status} dest=${destLabel} channel_id=${channelId ?? "?"} body:`, snippet);

  if (status === 401 || status === 403) {
    console.error(`[URGENT] LINE token invalid/forbidden — disabling channel AI channel_id=${channelId} status=${status}`);
    if (channelId != null) {
      await storage.updateChannel(channelId, { is_ai_enabled: 0 });
      safeAlert({
        alert_type: "line_channel_ai_auto_disabled",
        details: JSON.stringify({
          priority: "high",
          channel_id: channelId,
          brand_id: brandId,
          status,
          api,
          reason: "token_invalid_or_forbidden",
          body: snippet,
          timestamp: new Date().toISOString(),
        }),
        brand_id: brandId ?? undefined,
      });
    }
    safeAlert({
      alert_type: "line_token_invalid",
      details: JSON.stringify({
        priority: "high",
        channel_id: channelId,
        brand_id: brandId,
        status,
        api,
        destLabel,
        body: snippet,
        timestamp: new Date().toISOString(),
      }),
      brand_id: brandId ?? undefined,
    });
    console.warn(`[106.20.1 gentle] LINE ${api} HTTP ${status} — alerts written, not throwing`);
    return;
  }

  if (status === 429) {
    safeAlert({
      alert_type: "line_quota_exceeded",
      details: JSON.stringify({
        channel_id: channelId,
        brand_id: brandId,
        status,
        api,
        destLabel,
        body: snippet,
        timestamp: new Date().toISOString(),
      }),
      brand_id: brandId ?? undefined,
    });
    console.warn(`[106.20.1 gentle] LINE ${api} HTTP 429 — alerts written, not throwing`);
    return;
  }

  if (status >= 500 && status < 600) {
    safeAlert({
      alert_type: "line_push_5xx",
      details: JSON.stringify({
        channel_id: channelId,
        brand_id: brandId,
        status,
        api,
        destLabel,
        body: snippet,
        timestamp: new Date().toISOString(),
      }),
      brand_id: brandId ?? undefined,
    });
    console.warn(`[106.20.1 gentle] LINE ${api} HTTP ${status} (after retry) — alerts written, not throwing`);
    return;
  }

  safeAlert({
    alert_type: "line_push_4xx",
    details: JSON.stringify({
      channel_id: channelId,
      brand_id: brandId,
      status,
      api,
      destLabel,
      body: snippet,
      timestamp: new Date().toISOString(),
    }),
    brand_id: brandId ?? undefined,
  });
  console.warn(`[106.20.1 gentle] LINE ${api} HTTP ${status} — alerts written, not throwing`);
}

type FbSendMeta = { channelId: number | null; brandId: number | null; recipientId: string };

async function fetchFbMessageWithRetry(pageAccessToken: string, recipientId: string, text: string): Promise<Response> {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`;
  const body = JSON.stringify({
    recipient: { id: recipientId },
    message: { text },
  });
  const doFetch = () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  let res = await doFetch();
  if (res.status >= 500 && res.status < 600) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await doFetch();
  }
  return res;
}

/** Phase 106.20.1：同 LINE，告警後不 throw，避免上層管線崩潰。 */
async function processFbSendFailure(status: number, errText: string, meta: FbSendMeta): Promise<void> {
  const snippet = errText.slice(0, 500);
  const { channelId, brandId, recipientId } = meta;
  console.error(`[FB] send failed status=${status} recipient=${recipientId} channel_id=${channelId ?? "?"} body:`, snippet);

  if (status === 401 || status === 403) {
    console.error(`[URGENT] FB page token invalid/forbidden — disabling channel AI channel_id=${channelId} status=${status}`);
    if (channelId != null) {
      await storage.updateChannel(channelId, { is_ai_enabled: 0 });
      safeAlert({
        alert_type: "fb_channel_ai_auto_disabled",
        details: JSON.stringify({
          priority: "high",
          channel_id: channelId,
          brand_id: brandId,
          status,
          reason: "token_invalid_or_forbidden",
          body: snippet,
          timestamp: new Date().toISOString(),
        }),
        brand_id: brandId ?? undefined,
      });
    }
  }

  safeAlert({
    alert_type: "fb_send_failed",
    details: JSON.stringify({
      priority: status === 401 || status === 403 ? "high" : "normal",
      channel_id: channelId,
      brand_id: brandId,
      status,
      recipientId,
      body: snippet,
      timestamp: new Date().toISOString(),
    }),
    brand_id: brandId ?? undefined,
  });
  console.warn(`[106.20.1 gentle] FB send HTTP ${status} — alerts written, not throwing`);
}

/**
 * Phase 106.20：每個 active LINE 渠道呼叫 /v2/bot/info；失敗寫入 system_alerts。
 */
export async function runLineTokenHealthChecks(): Promise<void> {
  const channels = storage
    .getChannels()
    .filter((c) => c.platform === "line" && c.is_active === 1 && String(c.access_token ?? "").trim());
  const nowIso = new Date().toISOString();
  for (const ch of channels) {
    const token = String(ch.access_token).trim();
    try {
      const res = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const errText = await res.text().catch(() => "");
      if (res.ok) {
        lastLineTokenHealthByChannel.set(ch.id, { ok: true, checkedAt: nowIso, httpStatus: res.status });
        continue;
      }
      lastLineTokenHealthByChannel.set(ch.id, {
        ok: false,
        checkedAt: nowIso,
        httpStatus: res.status,
        error: errText.slice(0, 200),
      });
      safeAlert({
        alert_type: "line_token_health_check_failed",
        details: JSON.stringify({
          channel_id: ch.id,
          brand_id: ch.brand_id,
          status: res.status,
          body: errText.slice(0, 300),
          timestamp: nowIso,
        }),
        brand_id: ch.brand_id,
      });
      if (res.status === 401 || res.status === 403) {
        console.error(`[URGENT] LINE health check token dead channel_id=${ch.id} status=${res.status}`);
        await storage.updateChannel(ch.id, { is_ai_enabled: 0 });
        safeAlert({
          alert_type: "line_channel_ai_auto_disabled",
          details: JSON.stringify({
            priority: "high",
            source: "health_check",
            channel_id: ch.id,
            brand_id: ch.brand_id,
            status: res.status,
            timestamp: nowIso,
          }),
          brand_id: ch.brand_id,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastLineTokenHealthByChannel.set(ch.id, { ok: false, checkedAt: nowIso, error: msg });
      safeAlert({
        alert_type: "line_token_health_check_failed",
        details: JSON.stringify({
          channel_id: ch.id,
          brand_id: ch.brand_id,
          error: msg,
          timestamp: nowIso,
        }),
        brand_id: ch.brand_id,
      });
    }
  }
}

function sliceCallerStack(): string {
  return new Error().stack?.split("\n").slice(2, 8).join("\n") || "unknown";
}

function recordEmptyOutboundAlert(alert_type: string, payload: Record<string, unknown>): void {
  try {
    storage.createSystemAlert({
      alert_type,
      details: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
    });
  } catch {
    /* alert 失敗不影響主流程 */
  }
}

/**
 * LINE push/reply：擋下會觸發 API 400 的狀況（messages 為空、或任一 type=text 的 text 為空／僅空白）。
 * 非 text 類型（flex、image 等）不檢查。
 */
function lineMessagesBlockedReason(messages: object[] | null | undefined): "empty_messages" | "empty_text" | null {
  if (!messages || messages.length === 0) return "empty_messages";
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown>;
    if (m && m.type === "text") {
      const t = m.text;
      if (typeof t !== "string" || !t.trim()) return "empty_text";
    }
  }
  return null;
}

export function buildRatingFlexMessage(contactId: number, ratingType: "human" | "ai" = "human"): object {
  const actionPrefix = ratingType === "ai" ? "rate_ai" : "rate";
  const starButtons = [1, 2, 3, 4, 5].map((score) => ({
    type: "button",
    action: {
      type: "postback",
      label: `${score} 分`,
      data: `action=${actionPrefix}&ticket_id=${contactId}&score=${score}`,
      displayText: `已送出 ${score} 分，謝謝您！`,
    },
    style: "link",
    height: "md",
    flex: 1,
  }));

  const headerText = ratingType === "ai" ? "請為本次 AI 客服評分" : "請為本次真人客服評分";
  const bodyText =
    ratingType === "ai"
      ? "您的回饋能幫助我們把 AI 回覆調整得更好，謝謝您撥冗。"
      : "您的回饋能幫助我們改善真人客服品質，謝謝您撥冗。";
  const headerColor = ratingType === "ai" ? "#6366F1" : "#1DB446";
  const bgColor = ratingType === "ai" ? "#F5F3FF" : "#F7FFF7";

  return {
    type: "flex",
    altText:
      ratingType === "ai"
        ? "請為本次 AI 客服評分，點選 1～5 分"
        : "請為本次真人客服評分，點選 1～5 分",
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: headerText, weight: "bold", size: "lg", color: headerColor, align: "center" },
          { type: "text", text: "約十秒即可完成", size: "xs", color: "#888888", align: "center", margin: "4px" },
        ],
        paddingAll: "16px",
        backgroundColor: bgColor,
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: bodyText, size: "sm", color: "#333333", wrap: true, align: "center" },
          { type: "separator", margin: "lg" },
          { type: "text", text: "1 分代表最不滿意，5 分代表最滿意", size: "xs", color: "#666666", align: "center", margin: "sm" },
          { type: "text", text: "請點選下方 1～5 分按鈕完成評分", size: "xs", color: "#1DB446", align: "center", margin: "4px", weight: "bold" },
          { type: "text", text: "僅作為內部服務改善，不會公開顯示", size: "xs", color: "#AAAAAA", align: "center", margin: "4px" },
        ],
        paddingAll: "16px",
      },
      footer: {
        type: "box",
        layout: "horizontal",
        contents: starButtons,
        spacing: "sm",
        paddingAll: "12px",
      },
    },
  };
}

export function getLineTokenForContact(contact: { channel_id?: number | null; brand_id?: number | null }): string | null {
  if (contact.channel_id) {
    const channel = storage.getChannel(contact.channel_id);
    if (channel?.platform === "line" && channel?.access_token) return channel.access_token;
  }
  if (contact.brand_id) {
    const channels = storage.getChannelsByBrand(contact.brand_id);
    const lineChannel = channels.find(c => c.platform === "line" && c.access_token);
    if (lineChannel?.access_token) return lineChannel.access_token;
  }
  return null;
}

export function getFbTokenForContact(contact: { channel_id?: number | null; brand_id?: number | null }): string | null {
  if (contact.channel_id) {
    const channel = storage.getChannel(contact.channel_id);
    if (channel?.platform === "messenger" && channel?.access_token) return channel.access_token;
  }
  if (contact.brand_id) {
    const channels = storage.getChannelsByBrand(contact.brand_id);
    const fbChannel = channels.find(c => c.platform === "messenger" && c.access_token);
    if (fbChannel?.access_token) return fbChannel.access_token;
  }
  return null;
}

export async function replyToLine(
  replyToken: string,
  messages: object[],
  token?: string | null
): Promise<MessagingOutboundResult> {
  const resolvedToken = token ?? null;
  if (!resolvedToken?.trim()) {
    console.error("[LINE] replyToLine missing token");
    safeAlert({
      alert_type: "line_outbound_missing_token",
      details: JSON.stringify({ api: "reply", reason: "missing_channel_token", timestamp: new Date().toISOString() }),
    });
    console.warn("[106.20.1 gentle] replyToLine skipped — no token");
    return { delivered: false, reason: "missing_token" };
  }
  if (!replyToken?.trim()) {
    console.error("[LINE] replyToLine missing replyToken");
    safeAlert({
      alert_type: "line_outbound_invalid_args",
      details: JSON.stringify({ api: "reply", reason: "missing_reply_token", timestamp: new Date().toISOString() }),
    });
    console.warn("[106.20.1 gentle] replyToLine skipped — no replyToken");
    return { delivered: false, reason: "invalid_args" };
  }
  const blockReason = lineMessagesBlockedReason(messages);
  if (blockReason) {
    const stack = sliceCallerStack();
    console.warn("[LINE reply] BLOCKED empty or invalid messages", {
      replyTokenPrefix: replyToken.slice(0, 8),
      reason: blockReason,
      messageCount: messages?.length ?? 0,
      callerStack: stack,
    });
    recordEmptyOutboundAlert("line_reply_empty_blocked", {
      api: "reply",
      reason: blockReason,
      callerStack: stack,
    });
    return { skipped: true, reason: blockReason === "empty_messages" ? "empty_messages" : "empty_text" };
  }
  const ctx = resolveLineChannelByAccessToken(resolvedToken);
  const meta: LineSendMeta = {
    api: "reply",
    channelId: ctx?.id ?? null,
    brandId: ctx?.brand_id ?? null,
    destLabel: `replyToken:${replyToken.slice(0, 12)}…`,
  };
  try {
    const res = await fetchLineMessagingWithRetry(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages },
      resolvedToken
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      await processLineSendFailure(res.status, errText, meta);
      return { delivered: false, reason: "api_error", httpStatus: res.status };
    }
    return { delivered: true };
  } catch (err: unknown) {
    const e = err as { message?: string; cause?: unknown };
    console.error("[LINE] replyToLine network error error.message:", e?.message, "error.cause:", e?.cause);
    safeAlert({
      alert_type: "line_push_network_error",
      details: JSON.stringify({
        api: "reply",
        channel_id: meta.channelId,
        brand_id: meta.brandId,
        destLabel: meta.destLabel,
        error: String(e?.message ?? err),
        timestamp: new Date().toISOString(),
      }),
      brand_id: meta.brandId ?? undefined,
    });
    console.warn("[106.20.1 gentle] replyToLine network error — alert written, not throwing");
    return { delivered: false, reason: "network" };
  }
}

export async function pushLineMessage(
  userId: string,
  messages: object[],
  token?: string | null
): Promise<MessagingOutboundResult> {
  const resolvedToken = token ?? null;
  if (!resolvedToken?.trim()) {
    console.error("[LINE] pushLineMessage missing token");
    safeAlert({
      alert_type: "line_outbound_missing_token",
      details: JSON.stringify({
        api: "push",
        reason: "missing_channel_token",
        userIdPrefix: userId?.slice?.(0, 12),
        timestamp: new Date().toISOString(),
      }),
    });
    console.warn("[106.20.1 gentle] pushLineMessage skipped — no token");
    return { delivered: false, reason: "missing_token" };
  }
  const blockReason = lineMessagesBlockedReason(messages);
  if (blockReason) {
    const stack = sliceCallerStack();
    console.warn("[LINE push] BLOCKED empty message", {
      to: userId,
      reason: blockReason,
      messageCount: messages?.length ?? 0,
      callerStack: stack,
    });
    recordEmptyOutboundAlert("line_push_empty_blocked", {
      to: userId,
      reason: blockReason,
      callerStack: stack,
    });
    return { skipped: true, reason: blockReason === "empty_messages" ? "empty_messages" : "empty_text" };
  }
  const ctx = resolveLineChannelByAccessToken(resolvedToken);
  const meta: LineSendMeta = {
    api: "push",
    channelId: ctx?.id ?? null,
    brandId: ctx?.brand_id ?? null,
    destLabel: `to:${userId.slice(0, 12)}…`,
  };
  try {
    const res = await fetchLineMessagingWithRetry(
      "https://api.line.me/v2/bot/message/push",
      { to: userId, messages },
      resolvedToken
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      await processLineSendFailure(res.status, errText, meta);
      return { delivered: false, reason: "api_error", httpStatus: res.status };
    }
    return { delivered: true };
  } catch (err: unknown) {
    const e = err as { message?: string; cause?: unknown };
    console.error("[LINE] pushLineMessage network error error.message:", e?.message, "error.cause:", e?.cause);
    safeAlert({
      alert_type: "line_push_network_error",
      details: JSON.stringify({
        api: "push",
        channel_id: meta.channelId,
        brand_id: meta.brandId,
        destLabel: meta.destLabel,
        error: String(e?.message ?? err),
        timestamp: new Date().toISOString(),
      }),
      brand_id: meta.brandId ?? undefined,
    });
    console.warn("[106.20.1 gentle] pushLineMessage network error — alert written, not throwing");
    return { delivered: false, reason: "network" };
  }
}

export async function sendFBMessage(
  pageAccessToken: string,
  recipientId: string,
  text: string
): Promise<MessagingOutboundResult> {
  if (text == null || typeof text !== "string" || !text.trim()) {
    const stack = sliceCallerStack();
    console.warn("[FB send] BLOCKED empty message", {
      recipientId,
      textLength: text?.length ?? 0,
      textType: typeof text,
      callerStack: stack,
    });
    recordEmptyOutboundAlert("fb_message_empty_blocked", {
      recipientId,
      callerStack: stack,
    });
    return { skipped: true, reason: "empty_text" };
  }
  if (!String(pageAccessToken ?? "").trim()) {
    console.error("[FB] sendFBMessage missing page access token");
    return { delivered: false, reason: "missing_token" };
  }
  const ctx = resolveMessengerChannelByAccessToken(pageAccessToken);
  const fbMeta: FbSendMeta = {
    channelId: ctx?.id ?? null,
    brandId: ctx?.brand_id ?? null,
    recipientId,
  };
  try {
    const res = await fetchFbMessageWithRetry(pageAccessToken, recipientId, text);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      await processFbSendFailure(res.status, errText, fbMeta);
      return { delivered: false, reason: "api_error", httpStatus: res.status };
    }
    return { delivered: true };
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("[FB] sendFBMessage network error:", e?.message);
    safeAlert({
      alert_type: "fb_send_failed",
      details: JSON.stringify({
        channel_id: fbMeta.channelId,
        brand_id: fbMeta.brandId,
        recipientId,
        error: String(e?.message ?? err),
        timestamp: new Date().toISOString(),
      }),
      brand_id: fbMeta.brandId ?? undefined,
    });
    console.warn("[106.20.1 gentle] sendFBMessage network error — alert written, not throwing");
    return { delivered: false, reason: "network" };
  }
}

export async function sendRatingFlexMessage(
  contact: { id: number; platform_user_id: string; channel_id?: number | null },
  ratingType: "human" | "ai" = "human"
): Promise<boolean> {
  const token = getLineTokenForContact(contact);
  if (!token) return false;
  const flexMsg = buildRatingFlexMessage(contact.id, ratingType);
  const r = await pushLineMessage(contact.platform_user_id, [flexMsg], token);
  if (!isMessagingDelivered(r)) {
    console.warn("[106.21] sendRatingFlexMessage push not delivered contact=", contact.id);
    return false;
  }
  return true;
}

export async function downloadLineContent(
  messageId: string,
  fallbackExt: string,
  channelAccessToken?: string | null,
  channelIdForLog?: number | null
): Promise<string | null> {
  const token = channelAccessToken ?? null;
  if (!token || (typeof token === "string" && token.trim() === "")) {
    const hint = channelIdForLog == null
      ? "?? destination ??????????????? Token??????? [WEBHOOK] NO MATCH ??? channel_id????bot_id????????????? Bot ID ??? destination ?? Token?"
      : "???? ??????????? channel_id=" + channelIdForLog + " ??? Channel Access Token?";
    console.error("[downloadLineContent] Token ???access_token ????????? Get Content ?? ? messageId:", messageId, "channelId:", channelIdForLog ?? "unknown", "?", hint);
    return null;
  }
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
        headers: { "Authorization": `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error("[LINE API Error] Channel ID:", channelIdForLog ?? "unknown", "Status:", resp.status, errText);
        console.error(`[downloadLineContent] Attempt ${attempt}/${maxRetries} failed: HTTP ${resp.status} - ${errText} (msgId: ${messageId})`);
        if (resp.status === 404 || resp.status === 401 || resp.status === 403) break;
        if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
        return null;
      }
      const contentType = resp.headers.get("content-type") || "";
      const mimeExtMap: Record<string, string> = {
        "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
        "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
      };
      const ext = mimeExtMap[contentType] || fallbackExt;
      const filename = `line-${Date.now()}-${crypto.randomUUID()}${ext}`;
      const filePath = path.join(uploadDir, filename);
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
        console.log("[downloadLineContent] ???????:", uploadDir);
      }
      try {
        const body = resp.body;
        if (!body) {
          console.error("[downloadLineContent] No response body stream");
          return null;
        }
        const nodeIn = Readable.fromWeb(body as import("stream/web").ReadableStream);
        await pipeline(nodeIn, fs.createWriteStream(filePath));
      } catch (writeErr: any) {
        console.error("[downloadLineContent] ?????? ? path:", filePath, "error.message:", writeErr?.message, "error.code:", writeErr?.code, "channelId:", channelIdForLog ?? "unknown");
        if (writeErr?.stack) console.error("[downloadLineContent] writeFileSync stack:", writeErr.stack);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_u) {
          /* ignore */
        }
        return null;
      }
      let writtenSize = 0;
      try {
        writtenSize = fs.statSync(filePath).size;
      } catch (_s) {
        /* ignore */
      }
      console.log(`[downloadLineContent] Success: ${filename} (${writtenSize} bytes, attempt ${attempt})`);
      return `/uploads/${filename}`;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const cause = err?.cause != null ? (err.cause?.message ?? String(err.cause)) : "";
      const stack = err?.stack ?? "";
      console.error("[downloadLineContent] Attempt", attempt, "/", maxRetries, "catch ? messageId:", messageId, "error.message:", msg, "error.name:", err?.name, "error.cause:", cause, "channelId:", channelIdForLog ?? "unknown");
      if (stack) console.error("[downloadLineContent] catch stack:", stack);
      if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
      return null;
    }
  }
  return null;
}

export async function downloadExternalImage(imageUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.error(`[downloadExternalImage] Failed: HTTP ${resp.status} for ${imageUrl}`);
      return null;
    }
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const contentType = resp.headers.get("content-type") || "image/jpeg";
    const extMap: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };
    const ext = extMap[contentType] || ".jpg";
    const filename = `fb-${Date.now()}-${crypto.randomUUID()}${ext}`;
    const filePath = path.join(uploadDir, filename);
    const body = resp.body;
    if (!body) {
      console.error("[downloadExternalImage] No response body stream");
      return null;
    }
    const nodeIn = Readable.fromWeb(body as import("stream/web").ReadableStream);
    await pipeline(nodeIn, fs.createWriteStream(filePath));
    let writtenSize = 0;
    try {
      writtenSize = fs.statSync(filePath).size;
    } catch (_s) {
      /* ignore */
    }
    console.log(`[downloadExternalImage] Success: ${filename} (${writtenSize} bytes)`);
    return `/uploads/${filename}`;
  } catch (err: any) {
    console.error("[downloadExternalImage] Error:", err.name === "AbortError" ? "Request timed out (15s)" : err.message);
    return null;
  }
}
