---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包（含 106.1–106.17 與 debug endpoint）
檔案用途: 【檔案 7】LINE／Facebook Webhook、佇列、Worker、`/internal/run-ai-reply` 節錄
說明：專案無 `messenger-webhook.controller.ts`，Messenger 為 `facebook-webhook.controller.ts`。
---

## server/controllers/line-webhook.controller.ts

```typescript
/**
 * LINE Webhook 控制器
 * 負責驗簽、渠道匹配、事件去重與分派（文字／圖片／影片／貼圖／postback），商業邏輯與原 routes 一致。
 */
import type { Request, Response } from "express";
import crypto from "crypto";
import type { Contact } from "@shared/schema";
import type { IStorage } from "../storage";
import { recordAutoReplyBlocked } from "../auto-reply-blocked";
import { shouldEscalateImageSupplement } from "../safe-after-sale-classifier";
import { applyHandoff } from "../services/handoff";
import { resolveOpenAIModel } from "../openai-model";
import { acquireLineWebhookEvent } from "../webhook-idempotency";
import type { MessagingOutboundSkipped } from "../services/messaging.service";

const GHOST_REPLY_TOKEN = "00000000000000000000000000000000";
const GHOST_USER_ID = "Udeadbeefdeadbeefdeadbeefdeadbeef";

/** 由 routes 注入的依賴，controller 不直接 import 全域 singleton */
export interface LineWebhookDeps {
  storage: IStorage;
  broadcastSSE: (eventType: string, data: any) => void;
  pushLineMessage: (
    userId: string,
    messages: object[],
    token?: string | null
  ) => Promise<void | MessagingOutboundSkipped>;
  replyToLine: (
    replyToken: string,
    messages: object[],
    token?: string | null
  ) => Promise<void | MessagingOutboundSkipped>;
  downloadLineContent: (
    messageId: string,
    fallbackExt: string,
    channelAccessToken?: string | null,
    channelIdForLog?: number | null
  ) => Promise<string | null>;
  addAiReplyJob: (data: {
    contactId: number;
    message: string;
    channelToken: string | null;
    matchedBrandId?: number;
    platform?: string;
  }) => Promise<unknown>;
  enqueueDebouncedAiReply: (
    platform: string,
    contactId: number,
    message: string,
    inboundEventId: string,
    channelToken: string | null,
    matchedBrandId?: number
  ) => Promise<void>;
  autoReplyWithAI: (
    contact: Contact,
    userMessage: string,
    channelToken?: string | null,
    brandId?: number,
    platform?: string
  ) => Promise<void>;
  handleImageVisionFirst: (
    imageFilePath: string,
    contactId: number
  ) => Promise<{ reply: string; usedFallback: boolean; intent?: string; confidence?: string }>;
  getHandoffReplyForCustomer: (opening: string, unavailableReason?: string) => string;
  HANDOFF_MANDATORY_OPENING: string;
  getUnavailableReason: () => string | undefined;
}

/**
 * 處理 LINE Webhook POST：驗簽 → 事件入列／寫入完成後回 200；處理失敗回 500 讓 LINE 重試。
 * 商業邏輯與原 routes.ts 內 app.post("/api/webhook/line") 完全一致。
 */
export async function handleLineWebhook(req: Request, res: Response, deps: LineWebhookDeps): Promise<void> {
  const {
    storage,
    broadcastSSE,
    pushLineMessage,
    replyToLine,
    downloadLineContent,
    addAiReplyJob,
    enqueueDebouncedAiReply,
    autoReplyWithAI,
    handleImageVisionFirst,
    getHandoffReplyForCustomer,
    HANDOFF_MANDATORY_OPENING,
    getUnavailableReason,
  } = deps;

  try {
    console.log("===== [LINE WEBHOOK START] =====");
    console.log("[WEBHOOK] destination:", req.body?.destination);
    console.log("[WEBHOOK] events count:", req.body?.events?.length || 0);

    const signature = req.headers["x-line-signature"] as string | undefined;
    const destination = req.body?.destination as string | undefined;
    const destinationTrimmed = (destination ?? "").trim();
    if (destination) console.log("[WEBHOOK] destination (trimmed):", JSON.stringify(destinationTrimmed));

    let channelToken: string | null = null;
    let channelSecretVal: string | null = null;
    let matchedChannel: import("@shared/schema").ChannelWithBrand | undefined;
    let matchedBrandId: number | undefined;

    if (destination) {
      console.log("[WEBHOOK] destination（本則訊息來自的 LINE 機器人）:", destination);
      matchedChannel = storage.getChannelByBotId(destinationTrimmed || destination);
      if (matchedChannel) {
        channelToken = matchedChannel.access_token || null;
        channelSecretVal = matchedChannel.channel_secret || null;
        matchedBrandId = matchedChannel.brand_id;
        console.log("[WEBHOOK] MATCH FOUND — channel_id:", (matchedChannel as any).id, "渠道:", matchedChannel.channel_name, "品牌:", matchedChannel.brand_name, "is_ai_enabled:", matchedChannel.is_ai_enabled ?? 0);
      } else {
        const allChannels = storage.getChannels();
        console.log("[WEBHOOK] NO MATCH：本則 destination 與下列任一渠道的 Bot ID 均不符");
        allChannels.forEach((c: any) => {
          console.log("[WEBHOOK]   渠道 channel_id=" + c.id + " | 名稱=" + (c.channel_name || "") + " | bot_id=" + (c.bot_id || "(空)"));
        });
        console.log("[WEBHOOK] 請對照上方：要收「本則訊息」的 LINE 機器人，請到後台編輯「該渠道」(channel_id)，將 Bot ID 設為本則 destination:", destination, "勿與其他渠道（如私藏生活、AQUILA 等）混用；每個機器人 destination 不同。");
        console.log("[WEBHOOK] 不 fallback，無法確認渠道時不進行自動回覆（fail-closed）");
      }
    } else {
      console.log("[WEBHOOK] No destination field in webhook body");
      console.log("[WEBHOOK] 無 destination，視為未匹配 channel，不自動回覆（fail-closed）");
    }

    if (!channelSecretVal && matchedChannel) {
      channelSecretVal = storage.getSetting("line_channel_secret");
      console.log("[WEBHOOK] Using global channel_secret (matched channel had none), exists:", !!channelSecretVal);
    } else if (!channelSecretVal && !matchedChannel) {
      console.log("[WEBHOOK] NO MATCH — 不使用 global channel_secret 驗簽（fail-closed），避免用錯機器人 secret");
    }
    if (!channelToken) {
      console.log("[WEBHOOK] 無匹配渠道 Token，後續 Profile/Media/Reply 將不使用全域 Token（fail-closed）。請到後台「渠道」為該 LINE 機器人填寫 access_token（見 docs/LINE-渠道-Token-串接說明.md）");
    }

    console.log("[WEBHOOK] Token available:", !!channelToken, "Secret available:", !!channelSecretVal);

    if (channelSecretVal && signature && (req as any).rawBody) {
      try {
        const rawBody = Buffer.isBuffer((req as any).rawBody) ? (req as any).rawBody : Buffer.from((req as any).rawBody as string);
        const hash = crypto.createHmac("SHA256", channelSecretVal).update(rawBody).digest("base64");
        if (hash !== signature) {
          console.log("[WEBHOOK] SIGNATURE MISMATCH - rejecting request. Expected:", hash, "Got:", signature);
          storage.createSystemAlert({ alert_type: "webhook_sig_fail", details: "LINE signature mismatch", brand_id: matchedBrandId || undefined });
          res.status(403).json({ message: "Invalid signature" });
          return;
        }
        console.log("[WEBHOOK] Signature verified OK");
      } catch (sigErr: any) {
        console.log("[WEBHOOK] Signature check error:", sigErr.message);
        storage.createSystemAlert({ alert_type: "webhook_sig_fail", details: `LINE sig error: ${sigErr.message}`, brand_id: matchedBrandId || undefined });
        res.status(403).json({ message: "Signature verification failed" });
        return;
      }
    } else if (channelSecretVal && !signature) {
      console.log("[WEBHOOK] Missing x-line-signature header - rejecting");
      storage.createSystemAlert({ alert_type: "webhook_sig_fail", details: "LINE missing signature header", brand_id: matchedBrandId || undefined });
      res.status(403).json({ message: "Missing signature" });
      return;
    } else {
      console.log("[WEBHOOK] Skipping signature check - no channel_secret configured");
    }

    const humanKeywordsSetting = storage.getSetting("human_transfer_keywords");
    const HUMAN_KEYWORDS = humanKeywordsSetting
      ? humanKeywordsSetting.split(",").map((k) => k.trim()).filter(Boolean)
      : ["我要轉人工", "轉人工", "找真人客服", "找主管"];

    async function fetchAndUpdateLineProfile(userId: string, contactId: number, token: string | null, channelIdForLog?: number | null) {
      if (!token || (token && token.trim() === "") || userId === "unknown") {
        const hint = channelIdForLog == null
          ? "本則 destination 未對到任何渠道或對到的渠道未填 Token。日誌上方 [WEBHOOK] NO MATCH 會列出各渠道 channel_id／名稱／bot_id，請對照後將「要收此機器人」的渠道 Bot ID 設為該 destination 並填寫 Token（勿與他渠道混用）。"
          : "請到後台 設定→品牌與渠道，找到 channel_id=" + channelIdForLog + " 的渠道並填寫 Channel Access Token。";
        console.error("[WEBHOOK] Token 防呆：access_token 為空或未定義，跳過 Get Profile 請求 — userId:", userId, "contactId:", contactId, "channelId:", channelIdForLog ?? "unknown", "→", hint);
        return;
      }
      try {
        const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (profileRes.ok) {
          const profile = await profileRes.json() as { displayName?: string; pictureUrl?: string };
          const hasName = !!profile.displayName;
          const hasAvatar = !!profile.pictureUrl;
          if (hasName || hasAvatar) {
            const contact = storage.getContact(contactId);
            const displayName = profile.displayName || (contact?.display_name ?? "LINE用戶");
            const avatarUrl = profile.pictureUrl ?? contact?.avatar_url ?? null;
            storage.updateContactProfile(contactId, displayName, avatarUrl);
            console.log("[WEBHOOK] Profile updated:", displayName, avatarUrl ? "(has avatar)" : "(no avatar)");
          }
        } else {
          const errText = await profileRes.text().catch(() => "");
          console.error("[LINE API Error] Channel ID:", channelIdForLog ?? "unknown", "Status:", profileRes.status, errText);
          console.error("[WEBHOOK] Profile fetch failed:", profileRes.status, errText);
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const cause = err?.cause != null ? (err.cause?.message ?? String(err.cause)) : "";
        const stack = err?.stack ?? "";
        console.error("[WEBHOOK] fetchAndUpdateLineProfile catch — error.message:", msg, "error.cause:", cause, "channelId:", channelIdForLog ?? "unknown", "userId:", userId);
        if (stack) console.error("[WEBHOOK] fetchAndUpdateLineProfile stack:", stack);
      }
    }

    const events = req.body?.events || [];
    try {
      for (const event of events) {
        if (event.replyToken === GHOST_REPLY_TOKEN || event.source?.userId === GHOST_USER_ID) {
          console.log("[WEBHOOK] Skipping ghost/verification event");
          continue;
        }

        const dedupeKey =
          event.webhookEventId ||
          `${event.type}-${event.timestamp}-${event.source?.userId || "u"}-${event.type === "message" && event.message && "id" in event.message ? String((event.message as { id?: string }).id ?? "na") : "na"}`;
        if (storage.isEventProcessed(dedupeKey)) {
          console.warn("[IDEMPOTENCY_SKIP] duplicate LINE webhook (processed_events):", dedupeKey);
          storage.createSystemAlert({ alert_type: "dedupe_hit", details: `LINE event ${dedupeKey}`, brand_id: matchedBrandId || undefined });
          continue;
        }
        if (!(await acquireLineWebhookEvent(dedupeKey))) {
          console.warn("[IDEMPOTENCY_SKIP] duplicate LINE inbound (short idempotency lock):", dedupeKey);
          continue;
        }
        storage.markEventProcessed(dedupeKey);

        try {
          console.log("[WEBHOOK] Processing event:", event.type, event.message?.type || "", "from:", event.source?.userId || "unknown");
          if (event.type === "message" && event.message?.type === "text") {
            const userId = event.source?.userId || "unknown";
            const text = event.message.text;
            console.log("[WEBHOOK] Text message from", userId, ":", text.substring(0, 50));
            const contact = storage.getOrCreateContact("line", userId, "LINE用戶", matchedBrandId, matchedChannel?.id);
            if (contact.display_name === "LINE用戶" || !contact.avatar_url) {
              await fetchAndUpdateLineProfile(userId, contact.id, channelToken, matchedChannel?.id);
            }
            const contactAfterProfile = storage.getContact(contact.id) ?? contact;
            console.log("[WEBHOOK] Contact id:", contactAfterProfile.id, "brand_id:", contactAfterProfile.brand_id, "needs_human:", contactAfterProfile.needs_human);
            const userMsg = storage.createMessage(contactAfterProfile.id, "line", "user", text);
            console.log("[WEBHOOK] Message saved id:", userMsg.id);
            broadcastSSE("new_message", { contact_id: contact.id, message: userMsg, brand_id: matchedBrandId || contact.brand_id });
            broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
            const needsHuman = HUMAN_KEYWORDS.some((kw) => text.includes(kw));
            if (needsHuman) {
              console.log("[WEBHOOK] needs_human=1 source=webhook_keyword msg=" + (text || "").slice(0, 80));
              applyHandoff({ contactId: contact.id, reason: "explicit_human_request", source: "line_webhook_keyword", brandId: matchedBrandId || contact.brand_id || undefined });
              const handoffText = getHandoffReplyForCustomer(HANDOFF_MANDATORY_OPENING, getUnavailableReason());
              const aiMsg = storage.createMessage(contact.id, "line", "ai", handoffText);
              broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: matchedBrandId || contact.brand_id });
              broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
              if (channelToken) {
                await pushLineMessage(contact.platform_user_id, [{ type: "text", text: handoffText }], channelToken);
              }
            } else {
              /** Phase 106.7：人工排隊中一般文字仍排入 AI，由 LLM + release_handoff_to_ai 處理 */
              const aiEnabled = matchedChannel ? matchedChannel.is_ai_enabled : 0;
              if (!matchedChannel) {
                recordAutoReplyBlocked(storage, {
                  reason: "blocked:no_channel_match",
                  contactId: contact.id,
                  platform: "line",
                  brandId: matchedBrandId ?? undefined,
                  messageSummary: text ? `用戶說：${text}` : undefined,
                });
                console.log("[WEBHOOK] 無匹配 channel，跳過文字自動回覆（fail-closed）");
              } else if (!aiEnabled) {
                recordAutoReplyBlocked(storage, {
                  reason: "blocked:channel_ai_disabled",
                  contactId: contact.id,
                  platform: "line",
                  channelId: matchedChannel.id,
                  brandId: matchedBrandId ?? undefined,
                  messageSummary: text ? `用戶說：${text}` : undefined,
                });
                console.log("[WEBHOOK] AI 已關閉 (channel:", matchedChannel.channel_name, ", is_ai_enabled=", matchedChannel.is_ai_enabled, ") - 跳過自動回覆");
              } else {
                console.log("[WEBHOOK] AI 已啟用，準備文字自動回覆 — channel:", matchedChannel?.channel_name);
                const testMode = storage.getSetting("test_mode");
                if (testMode === "true") {
                  recordAutoReplyBlocked(storage, {
                    reason: "blocked:test_mode",
                    contactId: contact.id,
                    platform: "line",
                    channelId: matchedChannel.id,
                    brandId: matchedBrandId ?? undefined,
                    messageSummary: text ? `用戶說：${text}` : undefined,
                  });
                  storage.createMessage(contact.id, "line", "system", `[模擬回覆，未實際送出] 收到您的訊息：「${text}」。`);
                } else {
                  await enqueueDebouncedAiReply("line", contact.id, text, dedupeKey, channelToken, matchedBrandId);
                }
              }
            }
          } else if (event.type === "postback") {
            const data = event.postback?.data || "";
            const params = new URLSearchParams(data);
            const postbackAction = params.get("action");
            if (postbackAction === "rate" || postbackAction === "rate_ai") {
              const ticketId = parseInt(params.get("ticket_id") || "0");
              const score = parseInt(params.get("score") || "0");
              if (ticketId > 0 && score >= 1 && score <= 5) {
                const contactForRating = storage.getContact(ticketId);
                const isAi = postbackAction === "rate_ai";
                const alreadyRated = contactForRating && (isAi ? contactForRating.ai_rating != null : contactForRating.cs_rating != null);
                if (alreadyRated) {
                  replyToLine(event.replyToken, [
                    { type: "text", text: "您已評過分囉～感謝您的回饋！每則評價僅能提交一次。" },
                  ], channelToken);
                } else {
                  if (isAi) {
                    storage.updateContactAiRating(ticketId, score);
                    storage.createMessage(ticketId, "line", "system", `(系統提示) 客戶 AI 客服評分：${"⭐".repeat(score)}（${score} 分）`);
                  } else {
                    storage.updateContactRating(ticketId, score);
                    storage.createMessage(ticketId, "line", "system", `(系統提示) 客戶真人客服評分：${"⭐".repeat(score)}（${score} 分）`);
                  }
                  const typeLabel = isAi ? "AI 客服" : "真人客服";
                  replyToLine(event.replyToken, [
                    { type: "text", text: `已收到您對${typeLabel}的 ${"⭐".repeat(score)} 評分，感謝您的寶貴意見！祝您有美好的一天。` },
                  ], channelToken);
                  broadcastSSE("contacts_updated", { contact_id: ticketId });
                }
              }
            }
          } else if (event.type === "follow" || event.type === "unfollow" || event.type === "join" || event.type === "leave" || event.type === "memberJoined" || event.type === "memberLeft") {
            // silently ignore lifecycle events
          } else if (event.type === "message" && event.message?.type === "image") {
            const userId = event.source?.userId || "unknown";
            const contact = storage.getOrCreateContact("line", userId, "LINE用戶", matchedBrandId, matchedChannel?.id);
            if (contact.display_name === "LINE用戶" || !contact.avatar_url) {
              await fetchAndUpdateLineProfile(userId, contact.id, channelToken, matchedChannel?.id);
            }
            const messageId = event.message.id;
            const imageUrl = await downloadLineContent(messageId, ".jpg", channelToken, matchedChannel?.id);
            if (imageUrl) {
              const imgMsg = storage.createMessage(contact.id, "line", "user", "[圖片訊息]", "image", imageUrl);
              broadcastSSE("new_message", { contact_id: contact.id, message: imgMsg, brand_id: matchedBrandId || contact.brand_id });
              broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
              const aiEnabledImg = matchedChannel ? matchedChannel.is_ai_enabled : 0;
              if (!matchedChannel && !contact.needs_human) console.log("[WEBHOOK] 無匹配 channel，跳過圖片自動回覆（fail-closed）");
              if (!contact.needs_human && aiEnabledImg) {
                const visionResult = await handleImageVisionFirst(imageUrl, contact.id);
                const replyText = visionResult.reply;
                const aiMsg = storage.createMessage(contact.id, "line", "ai", replyText);
                broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: matchedBrandId || contact.brand_id });
                broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
                await pushLineMessage(contact.platform_user_id, [{ type: "text", text: replyText }], channelToken);
                const recentMsgsForEscalate = storage.getMessages(contact.id).slice(-8);
                const escalate = shouldEscalateImageSupplement(recentMsgsForEscalate);
                if (escalate) {
                  applyHandoff({ contactId: contact.id, reason: "post_reply_handoff", source: "line_webhook_image_escalate", brandId: matchedBrandId || contact.brand_id || undefined });
                  broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
                }
                storage.createAiLog({
                  contact_id: contact.id,
                  message_id: aiMsg.id,
                  brand_id: matchedBrandId || contact.brand_id || undefined,
                  prompt_summary: "[圖片訊息]",
                  knowledge_hits: [],
                  tools_called: ["image_vision_first"],
                  transfer_triggered: escalate,
                  transfer_reason: escalate ? "連續無效圖片補充升級人工" : undefined,
                  result_summary: `image_vision_first | intent=${visionResult.intent ?? "—"} | ${visionResult.usedFallback ? "fallback" : "direct"}`,
                  token_usage: 0,
                  model: resolveOpenAIModel(),
                  response_time_ms: 0,
                  reply_source: "image_vision_first",
                  used_llm: 1,
                  plan_mode: null,
                  reason_if_bypassed: visionResult.usedFallback ? "image_low_confidence_fallback" : undefined,
                });
              }
            } else {
              storage.createMessage(contact.id, "line", "user", "[圖片訊息] (下載失敗)");
            }
          } else if (event.type === "message" && event.message?.type === "video") {
            const userId = event.source?.userId || "unknown";
            const contact = storage.getOrCreateContact("line", userId, "LINE用戶", matchedBrandId, matchedChannel?.id);
            if (contact.display_name === "LINE用戶" || !contact.avatar_url) {
              await fetchAndUpdateLineProfile(userId, contact.id, channelToken, matchedChannel?.id);
            }
            const messageId = event.message.id;
            const videoUrl = await downloadLineContent(messageId, ".mp4", channelToken, matchedChannel?.id);
            if (videoUrl) {
              console.log("[影片處理成功]:", videoUrl);
              const vidMsg = storage.createMessage(contact.id, "line", "user", "[影片訊息]", "video", videoUrl);
              broadcastSSE("new_message", { contact_id: contact.id, message: vidMsg, brand_id: matchedBrandId || contact.brand_id });
              broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
            } else {
              console.log("[影片處理失敗]: messageId:", messageId);
              storage.createMessage(contact.id, "line", "user", "[影片訊息] (下載失敗)");
            }
            const aiEnabledVid = matchedChannel ? matchedChannel.is_ai_enabled : 0;
            if (contact.needs_human) {
              console.log("[WEBHOOK] 案件已轉人工(needs_human=1)，跳過影片固定回覆 contact_id=", contact.id);
            } else if (!aiEnabledVid) {
              if (!matchedChannel) console.log("[WEBHOOK] 無匹配 channel，跳過影片固定回覆（fail-closed）");
              else console.log("[WEBHOOK] AI 已關閉 (channel:", matchedChannel.channel_name, ") - 跳過影片回覆");
            } else {
              storage.createMessage(contact.id, "line", "ai", "(AI 系統提示) 已收到您的影片，將為您轉交專人檢視。");
              applyHandoff({ contactId: contact.id, reason: "post_reply_handoff", source: "line_webhook_video", brandId: matchedBrandId || contact.brand_id || undefined });
              await pushLineMessage(contact.platform_user_id, [{ type: "text", text: "已收到您的影片，將為您轉交專人檢視。" }], channelToken);
            }
          } else if (event.type === "message" && event.message?.type === "sticker") {
            const userId = event.source?.userId || "unknown";
            const contact = storage.getOrCreateContact("line", userId, "LINE用戶", matchedBrandId, matchedChannel?.id);
            if (contact.display_name === "LINE用戶" || !contact.avatar_url) {
              await fetchAndUpdateLineProfile(userId, contact.id, channelToken, matchedChannel?.id);
            }
            const stickerId = (event.message as { stickerId?: string; sticker_id?: string }).stickerId
              ?? (event.message as { stickerId?: string; sticker_id?: string }).sticker_id;
            if (stickerId) {
              const stickerImageUrl = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/android/sticker.png`;
              const stickerMsg = storage.createMessage(contact.id, "line", "user", "[貼圖]", "image", stickerImageUrl);
              broadcastSSE("new_message", { contact_id: contact.id, message: stickerMsg, brand_id: matchedBrandId || contact.brand_id });
              broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
            } else {
              const fallbackMsg = storage.createMessage(contact.id, "line", "user", "[貼圖訊息]");
              broadcastSSE("new_message", { contact_id: contact.id, message: fallbackMsg, brand_id: matchedBrandId || contact.brand_id });
              broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
            }
          } else if (event.type === "message" && event.message?.type !== "text") {
            const userId = event.source?.userId || "unknown";
            const contact = storage.getOrCreateContact("line", userId, "LINE用戶", matchedBrandId, matchedChannel?.id);
            if (contact.display_name === "LINE用戶" || !contact.avatar_url) {
              await fetchAndUpdateLineProfile(userId, contact.id, channelToken, matchedChannel?.id);
            }
            const msgType = event.message?.type || "unknown";
            storage.createMessage(contact.id, "line", "user", `[${msgType === "audio" ? "音訊" : msgType === "location" ? "位置" : msgType === "file" ? "檔案" : msgType}訊息]`);
          }
        } catch (err) {
          console.error("Webhook event processing error:", err);
          throw err;
        }
      }
      console.log("[WEBHOOK] All events processed");
      res.status(200).json({ success: true });
    } catch (batchErr: unknown) {
      const msg = batchErr instanceof Error ? batchErr.message : String(batchErr);
      console.error("[WEBHOOK] Event batch processing failed:", msg, batchErr);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: "LINE webhook processing failed" });
      }
    }
  } catch (outerErr) {
    console.error("[WEBHOOK] FATAL ERROR in webhook handler:", outerErr);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "LINE webhook fatal error" });
    }
  }
}

```
## server/controllers/facebook-webhook.controller.ts（Messenger / FB）

```typescript
/**
 * Facebook Webhook 控制器
 * 負責驗簽、路由 messaging / feed events、contact 管理、AI 回覆排程、公開留言寫入。
 * 所有外部依賴皆透過 DI 注入，controller 本身不直接 import 全域 singleton。
 */
import type { Request, Response } from "express";
import crypto from "crypto";
import type { IStorage } from "../storage";
import { recordAutoReplyBlocked } from "../auto-reply-blocked";
import { shouldEscalateImageSupplement } from "../safe-after-sale-classifier";
import { applyHandoff } from "../services/handoff";
import { resolveOpenAIModel } from "../openai-model";
import type { MessagingOutboundSkipped } from "../services/messaging.service";

export interface FacebookWebhookDeps {
  storage: IStorage;
  broadcastSSE: (eventType: string, data: any) => void;
  sendFBMessage: (
    pageAccessToken: string,
    recipientId: string,
    text: string
  ) => Promise<void | MessagingOutboundSkipped>;
  downloadExternalImage: (imageUrl: string) => Promise<string | null>;
  handleImageVisionFirst: (imageFilePath: string, contactId: number) => Promise<{ reply: string; usedFallback: boolean; intent?: string; confidence?: string }>;
  enqueueDebouncedAiReply: (platform: string, contactId: number, message: string, inboundEventId: string, channelToken: string | null, matchedBrandId?: number) => Promise<void>;
  addAiReplyJob: (data: { contactId: number; message: string; channelToken: string | null; matchedBrandId?: number; platform?: string }) => Promise<unknown>;
  getHandoffReplyForCustomer: (opening: string, unavailableReason?: string | undefined) => string;
  HANDOFF_MANDATORY_OPENING: string;
  SHORT_IMAGE_FALLBACK: string;
  getUnavailableReason: () => string | undefined;
  resolveCommentMetadata: (params: { brand_id: number | null; page_id: string; post_id: string; post_name: string | null; message: string; is_sensitive_or_complaint: boolean }) => Record<string, any>;
  metaCommentsStorage: {
    createMetaComment: (data: any) => any;
    updateMetaComment: (id: number, data: any) => void;
  };
  runAutoExecution: (commentId: number) => Promise<void>;
  FB_VERIFY_TOKEN: string;
}

export function handleFacebookVerify(req: Request, res: Response, deps: FacebookWebhookDeps): void {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === deps.FB_VERIFY_TOKEN) {
    console.log("[FB Webhook] 驗證成功");
    res.status(200).send(challenge);
    return;
  }
  res.status(403).json({ message: "驗證失敗" });
}

export function handleFacebookWebhook(req: Request, res: Response, deps: FacebookWebhookDeps): void {
  const {
    storage,
    broadcastSSE,
    sendFBMessage,
    downloadExternalImage,
    handleImageVisionFirst,
    enqueueDebouncedAiReply,
    addAiReplyJob,
    getHandoffReplyForCustomer,
    HANDOFF_MANDATORY_OPENING,
    SHORT_IMAGE_FALLBACK,
    getUnavailableReason,
    resolveCommentMetadata,
    metaCommentsStorage,
    runAutoExecution,
  } = deps;

  const body = req.body;
  if (body.object !== "page") {
    console.log("[FB Webhook] 404：非 page 事件，object=", body?.object ?? "(空)");
    res.status(404).json({ message: "Not a page event" });
    return;
  }

  const fbAppSecret = storage.getSetting("fb_app_secret");
  if (fbAppSecret && req.rawBody) {
    const fbSignature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!fbSignature) {
      console.log("[FB Webhook] Missing x-hub-signature-256 - rejecting");
      res.status(403).json({ message: "Missing signature" });
      return;
    }
    try {
      const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody as string);
      const expectedSig = "sha256=" + crypto.createHmac("sha256", fbAppSecret).update(rawBody).digest("hex");
      if (expectedSig !== fbSignature) {
        console.log("[FB Webhook] SIGNATURE MISMATCH - rejecting");
        storage.createSystemAlert({ alert_type: "webhook_sig_fail", details: "FB signature mismatch" });
        res.status(403).json({ message: "Invalid signature" });
        return;
      }
    } catch (sigErr: any) {
      storage.createSystemAlert({ alert_type: "webhook_sig_fail", details: `FB sig error: ${sigErr.message}` });
      res.status(403).json({ message: "Signature verification failed" });
      return;
    }
  }

  res.status(200).send("EVENT_RECEIVED");

  const humanKeywordsSetting = storage.getSetting("human_transfer_keywords");
  const HUMAN_KW = humanKeywordsSetting
    ? humanKeywordsSetting.split(",").map((k: string) => k.trim()).filter(Boolean)
    : ["真人客服", "轉人工", "找主管", "不要機器人", "人工客服", "真人處理"];

  async function fetchAndUpdateFBProfile(psid: string, contactId: number, pageAccessToken: string | null, brandId?: number | null) {
    if (!pageAccessToken || !psid) return;
    try {
      const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(psid)}?fields=first_name,last_name,name,picture.type(large)&access_token=${encodeURIComponent(pageAccessToken)}`;
      const profileRes = await fetch(url);
      const bodyText = await profileRes.text();
      if (profileRes.ok) {
        const profile = JSON.parse(bodyText) as { first_name?: string; last_name?: string; name?: string; picture?: { data?: { url?: string } } };
        const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim() || (typeof profile.name === "string" ? profile.name.trim() : undefined);
        const avatarUrl = profile.picture?.data?.url || null;
        if (fullName || avatarUrl) {
          storage.updateContactProfile(contactId, fullName || "FB用戶", avatarUrl);
          broadcastSSE("contacts_updated", { brand_id: brandId ?? undefined });
        }
      }
    } catch (err: any) {
      console.log("[FB Webhook] Profile fetch error:", err?.message);
    }
  }

  (async () => {
    const entries = body.entry || [];
    for (const entry of entries) {
      const pageId = entry.id;
      const matchedChannel = storage.getChannelByBotId(pageId);
      const matchedBrandId = matchedChannel?.brand_id;

      if (matchedChannel) {
        console.log(`[FB Webhook] → 品牌: ${matchedChannel.brand_name}, 頻道: ${matchedChannel.channel_name}`);
      } else {
        console.log(`[FB Webhook] 未匹配頻道，Page ID: ${pageId}`);
      }

      for (const messagingEvent of entry.messaging || []) {
        const senderId = messagingEvent.sender?.id;
        if (!senderId || senderId === pageId) continue;

        const msgMid = messagingEvent.message?.mid || messagingEvent.postback?.mid || "";
        const eventId = `fb_${messagingEvent.timestamp}_${senderId}_${msgMid}`;
        if (storage.isEventProcessed(eventId)) {
          storage.createSystemAlert({ alert_type: "dedupe_hit", details: `FB event ${eventId}`, brand_id: matchedBrandId || undefined });
          continue;
        }
        storage.markEventProcessed(eventId);

        try {
          if (messagingEvent.message) {
            const text = messagingEvent.message.text || "";
            const displayName = `FB用戶_${senderId.substring(0, 6)}`;
            const contact = storage.getOrCreateContact("messenger", senderId, displayName, matchedBrandId, matchedChannel?.id);
            if (matchedChannel?.access_token && (contact.display_name === displayName || (contact.display_name || "").startsWith("FB用戶_"))) {
              fetchAndUpdateFBProfile(senderId, contact.id, matchedChannel.access_token, matchedBrandId).catch(() => {});
            }

            if (messagingEvent.message.attachments) {
              for (const att of messagingEvent.message.attachments) {
                if (att.type === "image" && att.payload?.url) {
                  const localImageUrl = await downloadExternalImage(att.payload.url);
                  const finalUrl = localImageUrl || att.payload.url;
                  const imgMsg = storage.createMessage(contact.id, "messenger", "user", "[圖片訊息]", "image", finalUrl);
                  broadcastSSE("new_message", { contact_id: contact.id, message: imgMsg, brand_id: matchedBrandId || contact.brand_id });
                  const fbAiEnabledImg = matchedChannel ? (matchedChannel.is_ai_enabled === 1) : false;
                  if (!contact.needs_human && fbAiEnabledImg && matchedChannel?.access_token) {
                    const visionResult = localImageUrl
                      ? await handleImageVisionFirst(localImageUrl, contact.id)
                      : { reply: SHORT_IMAGE_FALLBACK, usedFallback: true as const };
                    const replyText = visionResult.reply;
                    const aiMsg = storage.createMessage(contact.id, "messenger", "ai", replyText);
                    broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: matchedBrandId || contact.brand_id });
                    broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
                    sendFBMessage(matchedChannel.access_token, senderId, replyText).catch(err => console.error("[FB Webhook] 圖片回覆失敗:", err));
                    const recentMsgs = storage.getMessages(contact.id).slice(-8);
                    const escalate = shouldEscalateImageSupplement(recentMsgs);
                    if (escalate) {
                      applyHandoff({ contactId: contact.id, reason: "post_reply_handoff", source: "fb_webhook_image_escalate", brandId: matchedBrandId || contact.brand_id || undefined });
                      broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
                    }
                    storage.createAiLog({
                      contact_id: contact.id,
                      message_id: aiMsg.id,
                      brand_id: matchedBrandId || contact.brand_id || undefined,
                      prompt_summary: "[圖片訊息]",
                      knowledge_hits: [],
                      tools_called: ["image_vision_first"],
                      transfer_triggered: escalate,
                      transfer_reason: escalate ? "連續無效圖片補充升級人工" : undefined,
                      result_summary: `image_vision_first | intent=${visionResult.intent ?? "—"} | ${visionResult.usedFallback ? "fallback" : "direct"}`,
                      token_usage: 0,
                      model: resolveOpenAIModel(),
                      response_time_ms: 0,
                      reply_source: "image_vision_first",
                      used_llm: 1,
                      plan_mode: null,
                      reason_if_bypassed: visionResult.usedFallback ? "image_low_confidence_fallback" : undefined,
                    });
                  }
                } else {
                  storage.createMessage(contact.id, "messenger", "user", `[${att.type || "附件"}]`);
                }
              }
              broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
            }

            if (text) {
              const userMsg = storage.createMessage(contact.id, "messenger", "user", text);
              broadcastSSE("new_message", { contact_id: contact.id, message: userMsg, brand_id: matchedBrandId || contact.brand_id });
              broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });

              const needsHuman = HUMAN_KW.some((kw: string) => text.includes(kw));
              if (needsHuman) {
                applyHandoff({ contactId: contact.id, reason: "explicit_human_request", source: "fb_webhook_keyword", brandId: matchedBrandId || contact.brand_id || undefined });
                const handoffText = getHandoffReplyForCustomer(HANDOFF_MANDATORY_OPENING, getUnavailableReason());
                const aiMsg = storage.createMessage(contact.id, "messenger", "ai", handoffText);
                broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: matchedBrandId || contact.brand_id });
                broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
                if (matchedChannel?.access_token) {
                  sendFBMessage(matchedChannel.access_token, senderId, handoffText).catch(err => console.error("[FB Webhook] 轉人工回覆失敗:", err));
                }
              } else {
                /** Phase 106.7：人工排隊中一般文字仍排入 AI */
                if (!matchedChannel) {
                  recordAutoReplyBlocked(storage, {
                    reason: "blocked:no_channel_match",
                    contactId: contact.id,
                    platform: "messenger",
                    brandId: matchedBrandId ?? undefined,
                    messageSummary: text ? `用戶說：${text}` : undefined,
                  });
                } else {
                  const fbAiEnabled = matchedChannel.is_ai_enabled === 1;
                  if (!fbAiEnabled) {
                    recordAutoReplyBlocked(storage, {
                      reason: "blocked:channel_ai_disabled",
                      contactId: contact.id,
                      platform: "messenger",
                      channelId: matchedChannel.id,
                      brandId: matchedBrandId ?? undefined,
                      messageSummary: text ? `用戶說：${text}` : undefined,
                    });
                  } else {
                    const testMode = storage.getSetting("test_mode");
                    if (testMode === "true") {
                      recordAutoReplyBlocked(storage, {
                        reason: "blocked:test_mode",
                        contactId: contact.id,
                        platform: "messenger",
                        channelId: matchedChannel.id,
                        brandId: matchedBrandId ?? undefined,
                        messageSummary: text ? `用戶說：${text}` : undefined,
                      });
                    } else if (!matchedChannel.access_token?.trim()) {
                      recordAutoReplyBlocked(storage, {
                        reason: "blocked:no_channel_token",
                        contactId: contact.id,
                        platform: "messenger",
                        channelId: matchedChannel.id,
                        brandId: matchedBrandId ?? undefined,
                        messageSummary: text ? `用戶說：${text}` : undefined,
                      });
                    } else {
                      const inboundEventId = eventId;
                      enqueueDebouncedAiReply("messenger", contact.id, text, inboundEventId, matchedChannel.access_token ?? null, matchedBrandId).catch((err) =>
                        console.error("[FB Webhook] enqueueDebouncedAiReply failed:", err)
                      );
                    }
                  }
                }
              }
            }
          }

          if (messagingEvent.postback) {
            const text = messagingEvent.postback.title || messagingEvent.postback.payload || "[Postback]";
            const displayName = `FB用戶_${senderId.substring(0, 6)}`;
            const contact = storage.getOrCreateContact("messenger", senderId, displayName, matchedBrandId, matchedChannel?.id);
            if (matchedChannel?.access_token && (contact.display_name === displayName || (contact.display_name || "").startsWith("FB用戶_"))) {
              fetchAndUpdateFBProfile(senderId, contact.id, matchedChannel.access_token, matchedBrandId).catch(() => {});
            }
            const pbMsg = storage.createMessage(contact.id, "messenger", "user", text);
            broadcastSSE("new_message", { contact_id: contact.id, message: pbMsg, brand_id: matchedBrandId || contact.brand_id });
            broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
          }
        } catch (err) {
          console.error("[FB Webhook] 事件處理錯誤:", err);
        }
      }

      for (const change of entry.changes || []) {
        if (change.field !== "feed") continue;
        const value = change.value;
        if (!value || value.verb !== "add") continue;
        if (value.item != null && value.item !== "comment") continue;
        const commentId = value.comment_id || value.id;
        if (!commentId) continue;
        const cEventId = `fb_comment_${pageId}_${commentId}_${value.created_time || Date.now()}`;
        if (storage.isEventProcessed(cEventId)) continue;
        storage.markEventProcessed(cEventId);
        try {
          const from = value.from || {};
          const recipient = value.recipient || {};
          const message = (value.message != null && value.message !== "") ? String(value.message) : "";
          const postId = value.post_id != null ? String(value.post_id) : "";
          const createdTime = value.created_time != null ? new Date(value.created_time * 1000).toISOString() : new Date().toISOString();
          const commenterName = typeof from.name === "string" ? from.name : (from.id ? `用戶_${String(from.id).slice(0, 8)}` : "未知");
          const commenterId = from.id != null ? String(from.id) : null;
          const pageName = typeof recipient.name === "string" ? recipient.name : (pageId || "粉專");
          const rawPayload = JSON.stringify(value);
          const resolved = resolveCommentMetadata({
            brand_id: matchedBrandId ?? null,
            page_id: pageId,
            post_id: postId,
            post_name: null,
            message,
            is_sensitive_or_complaint: false,
          });
          const row = metaCommentsStorage.createMetaComment({
            brand_id: matchedBrandId ?? null,
            page_id: pageId,
            page_name: pageName,
            post_id: postId,
            post_name: null,
            comment_id: String(commentId),
            commenter_id: commenterId,
            commenter_name: commenterName,
            message: message || "(空)",
            is_simulated: 0,
            raw_webhook_payload: rawPayload,
            ...resolved,
          });
          metaCommentsStorage.updateMetaComment(row.id, { created_at: createdTime });
          console.log("[FB Webhook] 公開留言已寫入 id=%s comment_id=%s", row.id, commentId);
          broadcastSSE("meta_comments_updated", { brand_id: matchedBrandId ?? undefined });
          setImmediate(() => {
            runAutoExecution(row.id).catch((e: any) => console.error("[FB Webhook] runAutoExecution error:", e?.message));
          });
        } catch (err: any) {
          console.error("[FB Webhook] 公開留言寫入失敗:", err?.message, value?.comment_id);
        }
      }
    }
  })().catch(err => console.error("[FB Webhook] Async processing error:", err));
}

```
## server/queue/ai-reply.queue.ts

```typescript
/**
 * AI Reply Queue (BullMQ)
 *
 * 設計：
 * 1. Webhook 只做 enqueue（LPUSH 到 Redis + 排程 delayed job）後立即回 200。
 * 2. Redis debounce：同 contact 短時間多則合併為一筆 delayed job（固定 jobId）。
 * 3. 固定 jobId = ai-reply:{platform}:{contactId}，同 contact 同一時刻只有一筆 queue job。
 * 4. per-contact 串行：Redis lock（NX + PX），Worker 處理前取得、處理完釋放。
 * 5. 冪等：以 batch delivery_key（sha1 of sorted event ids）追蹤已送出批次。
 * 6. 全域並發控制：使用 BullMQ RateLimiter 限制同時 active jobs。
 *
 * Redis Key 設計：
 *   ai-reply:pending:{platform}:{contactId}   — List，尚未被 worker claim 的合併訊息
 *   lock:ai-reply:{platform}:{contactId}       — SET NX PX，per-contact 串行 lock
 */
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import crypto from "crypto";

const QUEUE_NAME = "ai-reply";
const REDIS_URL = process.env.REDIS_URL?.trim() || "redis://localhost:6379";
/** 同 contact 連發訊息合併：拉長防抖，給客人時間打完字再進 AI */
const DEBOUNCE_MS = 4000;
const LOCK_TTL_MS = 120_000;
const LOCK_KEY_PREFIX = "lock:ai-reply:";
const PENDING_KEY_PREFIX = "ai-reply:pending:";
/** Worker 心跳 key，供 /api/debug/runtime 判斷 worker 是否活著 */
export const WORKER_HEARTBEAT_KEY = "omni:worker:heartbeat";
export const WORKER_HEARTBEAT_TTL_S = 60;
const PENDING_KEY_TTL_S = 300;
const MAX_PENDING_ITEMS = 50;

/**
 * 全域最大同時 active jobs。
 * 正式環境只部署一份 worker（concurrency=5），加上 BullMQ limiter 雙重保險。
 */
export const AI_REPLY_CONCURRENCY = 5;

export interface AiReplyJobData {
  contactId: number;
  channelToken: string | null;
  matchedBrandId?: number;
  platform?: string;
  /** worker 計算 queue_wait_ms */
  enqueuedAtMs?: number;
}

export interface DebouncedMessage {
  text: string;
  eventId: string;
}

const producerRedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times: number) => Math.min(times * 200, 2000),
} as const;

/** Webhook / API 端與 BullMQ Queue 共用一條 IORedis，避免每次 enqueue 開新連線 */
let sharedProducerRedis: IORedis | null = null;

function getSharedProducerRedis(): IORedis {
  if (!sharedProducerRedis) {
    sharedProducerRedis = new IORedis(REDIS_URL, { ...producerRedisOptions });
  }
  return sharedProducerRedis;
}

function getWorkerConnection(): IORedis {
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
}

let queue: Queue<AiReplyJobData> | null = null;

export function getAiReplyQueue(): Queue<AiReplyJobData> {
  if (!queue) {
    queue = new Queue<AiReplyJobData>(QUEUE_NAME, {
      connection: getSharedProducerRedis() as import("bullmq").ConnectionOptions,
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
      },
    }) as Queue<AiReplyJobData>;
  }
  return queue;
}

function pendingKey(platform: string, contactId: number): string {
  return `${PENDING_KEY_PREFIX}${platform}:${contactId}`;
}

function lockKey(platform: string, contactId: number): string {
  return `${LOCK_KEY_PREFIX}${platform}:${contactId}`;
}

function jobId(platform: string, contactId: number): string {
  return `ai-reply:${platform}:${contactId}`;
}

/** 產生 batch delivery key：sha1(platform:contactId:sortedEventIds) */
export function computeDeliveryKey(platform: string, contactId: number, eventIds: string[]): string {
  const sorted = [...eventIds].sort();
  const raw = `${platform}:${contactId}:${sorted.join(",")}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

/** 逾此秒數視為 worker 已死，enqueue 時可記錄 blocked:worker_unavailable */
export const WORKER_HEARTBEAT_DEAD_THRESHOLD_S = 90;

/**
 * 查詢 worker heartbeat 狀態（供 enqueue 前判斷是否記錄 blocked:worker_unavailable）。
 * 若未啟用 Redis 或無法讀取則回傳 null。
 */
export async function getWorkerHeartbeatStatus(): Promise<{ alive: boolean; ageSec: number | null } | null> {
  if (!process.env.REDIS_URL?.trim()) return null;
  try {
    const { getRedisClient } = await import("../redis-client");
    const redis = getRedisClient();
    const raw = redis ? await redis.get(WORKER_HEARTBEAT_KEY) : null;
    if (!raw) {
      if (!redis) {
        const conn = getSharedProducerRedis();
        const fallbackRaw = await conn.get(WORKER_HEARTBEAT_KEY);
        if (!fallbackRaw) return { alive: false, ageSec: null };
        return parseHeartbeatRaw(fallbackRaw);
      }
      return { alive: false, ageSec: null };
    }
    return parseHeartbeatRaw(raw);
  } catch {
    return { alive: false, ageSec: null };
  }
}

function parseHeartbeatRaw(raw: string): { alive: boolean; ageSec: number | null } {
  try {
    const data = JSON.parse(raw) as { timestamp?: number };
    const ts = data?.timestamp;
    if (typeof ts !== "number") return { alive: false, ageSec: null };
    const ageSec = Math.round((Date.now() - ts) / 1000);
    const alive = ageSec <= WORKER_HEARTBEAT_DEAD_THRESHOLD_S;
    return { alive, ageSec };
  } catch {
    return { alive: false, ageSec: null };
  }
}

/**
 * 取得 BullMQ queue 計數（供 /api/debug/runtime）。
 * 若未啟用 Redis 或 queue 未初始化則回傳 null。
 */
export async function getQueueJobCounts(): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
} | null> {
  if (!process.env.REDIS_URL?.trim()) return null;
  try {
    const q = getAiReplyQueue();
    const counts = await q.getJobCounts("wait", "active", "delayed", "failed");
    const c = counts as Record<string, number | undefined>;
    return {
      waiting: c.wait ?? c.waiting ?? 0,
      active: c.active ?? 0,
      delayed: c.delayed ?? 0,
      failed: c.failed ?? 0,
    };
  } catch {
    return null;
  }
}

// ─── Producer API ───────────────────────────────────────────

/**
 * Redis debounce + 單 contact 單 job。
 *
 * 每則新訊息：
 *   1. LPUSH { text, eventId } 到 ai-reply:pending:{platform}:{contactId}
 *   2. 設定 TTL 防止永遠殘留
 *   3. 嘗試 remove 現有 delayed job，再 add 新的 delayed job（refresh delay）
 *      - 若 job 是 active：不做 remove，新訊息留在 pending list，
 *        active job 完成後 worker 會再檢查 pending list 並排新 job。
 *      - 若 job 是 waiting：保留原 job，worker 處理時會讀到最新 pending。
 */
export async function enqueueDebouncedAiReply(
  platform: string,
  contactId: number,
  message: string,
  inboundEventId: string,
  channelToken: string | null,
  matchedBrandId?: number
): Promise<void> {
  const redis = getSharedProducerRedis();
  const key = pendingKey(platform, contactId);
  const payload = JSON.stringify({ text: message, eventId: inboundEventId } as DebouncedMessage);

  await redis.lpush(key, payload);
  await redis.ltrim(key, 0, MAX_PENDING_ITEMS - 1);
  await redis.expire(key, PENDING_KEY_TTL_S);

  const q = getAiReplyQueue();
  const jid = jobId(platform, contactId);

  try {
    const existing = await q.getJob(jid);
    if (existing) {
      const state = await existing.getState();
      if (state === "delayed") {
        await existing.remove();
      } else if (state === "active") {
        /** 併發保護：AI 思考中不重排新 job，僅累積在 pending；完成後 worker 會 rescheduleIfPending */
        console.log("[Queue] job active, new message buffered in pending:", jid);
        return;
      } else if (state === "waiting") {
        /** 已在佇列：不重複觸發，worker 執行時會一次讀取最新 pending 合併內容 */
        console.log("[Queue] job waiting, pending updated:", jid);
        return;
      }
    }
  } catch (_e) { /* job may not exist */ }

  await q.add("reply", { contactId, channelToken, matchedBrandId, platform }, { jobId: jid, delay: DEBOUNCE_MS });
  console.log("[Queue] debounced job scheduled:", jid);
}

/** 舊版相容 API（無 debounce），僅供 fallback 使用 */
export async function addAiReplyJob(data: {
  contactId: number;
  message: string;
  channelToken: string | null;
  matchedBrandId?: number;
  platform?: string;
}): Promise<Job<AiReplyJobData> | null> {
  try {
    const q = getAiReplyQueue();
    const platform = data.platform ?? "line";
    const jid = `ai-reply:${platform}:${data.contactId}`;
    const existing = await q.getJob(jid);
    if (existing) {
      const state = await existing.getState();
      if (state === "active" || state === "waiting") {
        console.log("[Queue] addAiReplyJob skip, job already active/waiting:", jid);
        return null;
      }
    }
    const job = await q.add(
      "reply",
      {
        contactId: data.contactId,
        channelToken: data.channelToken,
        matchedBrandId: data.matchedBrandId,
        platform: data.platform,
        enqueuedAtMs: Date.now(),
      },
      { jobId: jid }
    );
    return job;
  } catch (err) {
    console.error("[Queue] addAiReplyJob failed:", err);
    return null;
  }
}

// ─── Worker API ─────────────────────────────────────────────

export type AiReplyJobProcessor = (job: Job<AiReplyJobData>) => Promise<void>;

let worker: Worker<AiReplyJobData> | null = null;
let workerConn: IORedis | null = null;

/**
 * 啟動 Worker。
 * 僅由獨立 worker 進程呼叫（server/workers/ai-reply.worker.ts），API 進程只 enqueue。
 * 全域並發由 concurrency + limiter 雙重控制。
 */
export function startAiReplyWorker(processor: AiReplyJobProcessor): Worker<AiReplyJobData> {
  if (worker) return worker;
  workerConn = getWorkerConnection();
  worker = new Worker<AiReplyJobData>(
    QUEUE_NAME,
    async (job) => await processor(job),
    {
      connection: workerConn as import("bullmq").ConnectionOptions,
      concurrency: AI_REPLY_CONCURRENCY,
      limiter: { max: AI_REPLY_CONCURRENCY, duration: 1000 },
    }
  );
  worker.on("completed", (job) => console.log("[Worker] completed:", job.id));
  worker.on("failed", (job, err) => console.error("[Worker] failed:", job?.id, err?.message));
  worker.on("error", (err) => console.error("[Worker] error:", err));
  console.log("[Worker] started, concurrency:", AI_REPLY_CONCURRENCY);
  return worker;
}

export function getWorkerRedis(): IORedis | null {
  return workerConn;
}

/**
 * Worker 內：原子讀取 + 清空 pending list。
 * 回傳合併後的文字、所有 eventIds、以及 delivery key。
 */
export async function consumePendingMessages(
  redis: IORedis,
  platform: string,
  contactId: number
): Promise<{ mergedText: string; eventIds: string[]; deliveryKey: string } | null> {
  const key = pendingKey(platform, contactId);
  const items = await redis.lrange(key, 0, -1);
  await redis.del(key);
  if (!items.length) return null;

  const parsed: DebouncedMessage[] = items.map((s) => {
    try { return JSON.parse(s) as DebouncedMessage; }
    catch { return { text: s, eventId: "" }; }
  });

  const eventIds = [...new Set(parsed.map(p => p.eventId).filter(Boolean))];
  const mergedText = parsed.map(p => p.text).join("\n");
  const deliveryKey = computeDeliveryKey(platform, contactId, eventIds);
  return { mergedText, eventIds, deliveryKey };
}

/**
 * Worker 完成後：檢查 pending list 是否又有新訊息（active 期間進來的），有的話排一筆新 job。
 */
export async function rescheduleIfPending(
  redis: IORedis,
  platform: string,
  contactId: number
): Promise<void> {
  const key = pendingKey(platform, contactId);
  const len = await redis.llen(key);
  if (len > 0) {
    const q = getAiReplyQueue();
    const jid = jobId(platform, contactId);
    try {
      await q.add("reply", { contactId, channelToken: null, platform }, { jobId: jid, delay: DEBOUNCE_MS });
      console.log("[Worker] rescheduled pending job:", jid, "items:", len);
    } catch (_e) { /* jobId may already exist */ }
  }
}

export async function acquireLock(redis: IORedis, platform: string, contactId: number): Promise<boolean> {
  const result = await redis.set(lockKey(platform, contactId), "1", "PX", LOCK_TTL_MS, "NX");
  return result === "OK";
}

export async function releaseLock(redis: IORedis, platform: string, contactId: number): Promise<void> {
  await redis.del(lockKey(platform, contactId));
}

export async function closeAiReplyQueue(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (workerConn) { await workerConn.quit(); workerConn = null; }
  if (queue) { await queue.close(); queue = null; }
  if (sharedProducerRedis) {
    await sharedProducerRedis.quit();
    sharedProducerRedis = null;
  }
}

```
## server/workers/ai-reply.worker.ts

```typescript
/**
 * AI Reply Worker — 獨立進程
 *
 * 只消費 ai-reply 佇列，不啟動 HTTP server。
 * 流程：claim pending → acquire lock → idempotency check → call internal API → record → release lock → reschedule
 *
 * 環境變數：
 *   REDIS_URL              — 必填
 *   INTERNAL_API_URL       — 預設 http://localhost:8080
 *   INTERNAL_API_SECRET    — 必填，與 API server 一致
 *
 * 正式環境部署：
 *   只跑一份 worker instance，concurrency=5，加 BullMQ limiter 雙重保險。
 *   若需擴展，增加 instance 數量，總並發 = instance 數 × concurrency。
 *   但因 Redis lock per-contact，同一 contact 不會並行。
 */
import os from "os";
import { storage } from "../storage";
import {
  startAiReplyWorker,
  getWorkerRedis,
  consumePendingMessages,
  rescheduleIfPending,
  acquireLock,
  releaseLock,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_S,
} from "../queue/ai-reply.queue";

const INTERNAL_API_URL = (process.env.INTERNAL_API_URL || "http://localhost:8080").replace(/\/$/, "");
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

async function callInternalRunAiReply(payload: {
  contactId: number;
  message: string;
  channelToken?: string | null;
  matchedBrandId?: number;
  platform?: string;
  enqueueTimestampMs?: number;
}): Promise<void> {
  if (!INTERNAL_API_SECRET) {
    throw new Error("INTERNAL_API_SECRET is required");
  }
  const res = await fetch(`${INTERNAL_API_URL}/internal/run-ai-reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": INTERNAL_API_SECRET },
    body: JSON.stringify(payload),
  });
  if (res.status === 504) {
    console.log(
      "[ai-reply.worker] internal API soft timeout (504) contactId=" +
        payload.contactId +
        " — fallback message already pushed by routes layer; job completes without retry"
    );
    return;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`internal/run-ai-reply ${res.status}: ${errText.slice(0, 300)}`);
  }
}

function main() {
  if (!process.env.REDIS_URL) {
    console.error("[Worker] REDIS_URL is required. Exiting.");
    process.exit(1);
  }
  if (!INTERNAL_API_SECRET) {
    console.error("[Worker] INTERNAL_API_SECRET is required. Exiting.");
    process.exit(1);
  }

  startAiReplyWorker(async (job) => {
    const redis = getWorkerRedis();
    if (!redis) throw new Error("Worker Redis connection not available");

    const platform = job.data.platform || "line";
    const contactId = job.data.contactId;

    const pending = await consumePendingMessages(redis, platform, contactId);
    if (!pending || !pending.mergedText.trim()) {
      console.log("[Worker] no pending messages for", platform, contactId);
      return;
    }

    const { mergedText, eventIds, deliveryKey } = pending;
    console.log("[Worker] processing:", deliveryKey, "platform:", platform, "contact:", contactId, "events:", eventIds.length, "text length:", mergedText.length);

    if (storage.isAiReplyDeliverySent(deliveryKey)) {
      console.log("[Worker] already sent, skip:", deliveryKey);
      return;
    }

    const acquired = await acquireLock(redis, platform, contactId);
    if (!acquired) {
      throw new Error(`lock not acquired for ${platform}:${contactId}, will retry`);
    }

    try {
      if (storage.isAiReplyDeliverySent(deliveryKey)) {
        console.log("[Worker] already sent (post-lock check), skip:", deliveryKey);
        return;
      }

      storage.createAiReplyDeliveryIfMissing(deliveryKey, platform, contactId, eventIds, mergedText);

      try {
        const enq = job.data.enqueuedAtMs ?? (job.timestamp as number);
        await callInternalRunAiReply({
          contactId,
          message: mergedText,
          channelToken: job.data.channelToken ?? undefined,
          matchedBrandId: job.data.matchedBrandId,
          platform,
          enqueueTimestampMs: typeof enq === "number" ? enq : undefined,
        });
        storage.markAiReplyDeliverySent(deliveryKey);
        console.log("[Worker] sent:", deliveryKey);
      } catch (err: any) {
        storage.markAiReplyDeliveryFailed(deliveryKey, err?.message || "unknown");
        throw err;
      }
    } finally {
      await releaseLock(redis, platform, contactId);
      await rescheduleIfPending(redis, platform, contactId);
    }
  });

  const redis = getWorkerRedis();
  if (redis) {
    const writeHeartbeat = () => {
      const payload = JSON.stringify({
        worker_id: `pid:${process.pid}`,
        timestamp: Date.now(),
        pid: process.pid,
        hostname: os.hostname(),
      });
      redis.set(WORKER_HEARTBEAT_KEY, payload, "EX", WORKER_HEARTBEAT_TTL_S).catch((err) => console.error("[Worker] heartbeat write failed:", err?.message));
    };
    writeHeartbeat();
    setInterval(writeHeartbeat, 30_000);
  }

  console.log("[Worker] ai-reply worker running.");
  console.log("[Worker] INTERNAL_API_URL:", INTERNAL_API_URL);
  console.log("[Worker] Concurrency: 5, Limiter: max 5 per 1000ms");
}

main();

```
## server/routes.ts — `POST /internal/run-ai-reply` 前後脈絡（節錄）

```typescript

  registerSandboxRoutes(app, { toolExecutor });

  app.post("/internal/run-ai-reply", (req, res) => {
    const secret = req.headers["x-internal-secret"];
    if (secret !== process.env.INTERNAL_API_SECRET) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const { contactId, message, channelToken, matchedBrandId, platform, enqueueTimestampMs } = req.body || {};
    if (!contactId || message == null) {
      return res.status(400).json({ message: "contactId and message required" });
    }
    const contact = storage.getContact(Number(contactId));
    if (!contact) {
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
```
