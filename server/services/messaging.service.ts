import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import crypto from "crypto";
import { storage } from "../storage";
import { uploadDir } from "../middlewares/upload.middleware";

/** Phase 106.2：集中擋空訊息；呼叫端可判斷 skipped（不 throw） */
export type MessagingOutboundSkipped = { skipped: true; reason: "empty_text" | "empty_messages" };

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
      label: `${score} ??`,
      data: `action=${actionPrefix}&ticket_id=${contactId}&score=${score}`,
      displayText: `${"?".repeat(score)}`,
    },
    style: "link",
    height: "md",
    flex: 1,
  }));

  const headerText = ratingType === "ai" ? "???? AI ???" : "???????";
  const bodyText = ratingType === "ai"
    ? "???? AI ???????"
    : "????????????????????????";
  const headerColor = ratingType === "ai" ? "#6366F1" : "#1DB446";
  const bgColor = ratingType === "ai" ? "#F5F3FF" : "#F7FFF7";

  return {
    type: "flex",
    altText: ratingType === "ai" ? "AI ??????????? 1?5 ???" : "????????????? 1?5 ???",
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: headerText, weight: "bold", size: "lg", color: headerColor, align: "center" },
          { type: "text", text: "??????????", size: "xs", color: "#888888", align: "center", margin: "4px" },
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
          { type: "text", text: "1 ? ??????5 ? ????", size: "xs", color: "#666666", align: "center", margin: "sm" },
          { type: "text", text: "?????1 ??????? 5 ??????", size: "xs", color: "#1DB446", align: "center", margin: "4px", weight: "bold" },
          { type: "text", text: "???????????????????", size: "xs", color: "#AAAAAA", align: "center", margin: "4px" },
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
): Promise<void | MessagingOutboundSkipped> {
  const resolvedToken = token ?? null;
  if (!resolvedToken || !replyToken) {
    console.error("[LINE] replyToLine ???Token ? replyToken ??");
    return;
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
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resolvedToken}` },
      body: JSON.stringify({ replyToken, messages }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[LINE] reply ?? ? Status:", res.status, "body:", errText);
    }
  } catch (err: unknown) {
    const e = err as { message?: string; cause?: unknown };
    console.error("[LINE] replyToLine ?? ? error.message:", e?.message, "error.cause:", e?.cause);
  }
}

export async function pushLineMessage(
  userId: string,
  messages: object[],
  token?: string | null
): Promise<void | MessagingOutboundSkipped> {
  const resolvedToken = token ?? null;
  if (!resolvedToken) {
    console.error("[LINE] pushLineMessage ???Token ??");
    return;
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
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resolvedToken}` },
      body: JSON.stringify({ to: userId, messages }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[LINE] push ?? ? Status:", res.status, "body:", errText);
    }
  } catch (err: unknown) {
    const e = err as { message?: string; cause?: unknown };
    console.error("[LINE] pushLineMessage ?? ? error.message:", e?.message, "error.cause:", e?.cause);
  }
}

export async function sendFBMessage(
  pageAccessToken: string,
  recipientId: string,
  text: string
): Promise<void | MessagingOutboundSkipped> {
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
  const res = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("[FB] send message failed:", res.status, errText);
    throw new Error(`FB API ${res.status}: ${errText.slice(0, 200)}`);
  }
}

export async function sendRatingFlexMessage(
  contact: { id: number; platform_user_id: string; channel_id?: number | null },
  ratingType: "human" | "ai" = "human"
): Promise<void> {
  const token = getLineTokenForContact(contact);
  if (!token) return;
  try {
    const flexMsg = buildRatingFlexMessage(contact.id, ratingType);
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ to: contact.platform_user_id, messages: [flexMsg] }),
    });
  } catch (err) {
    console.error("LINE rating flex message push failed:", err);
  }
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
