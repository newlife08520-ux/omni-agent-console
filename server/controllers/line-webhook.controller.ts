/**
 * LINE Webhook 控制器
 * 負責驗簽、渠道匹配、事件去重與分派（文字／圖片／影片／貼圖／postback），商業邏輯與原 routes 一致。
 */
import type { Request, Response } from "express";
import crypto from "crypto";
import type { Contact } from "@shared/schema";
import type { IStorage } from "../storage";
import { recordAutoReplyBlocked } from "../auto-reply-blocked";
import { isLinkRequestMessage, isLinkRequestCorrectionMessage } from "../conversation-state-resolver";
import { shouldEscalateImageSupplement } from "../safe-after-sale-classifier";
import { applyHandoff } from "../services/handoff";
import { resolveOpenAIModel } from "../openai-model";
import { acquireLineWebhookEvent } from "../webhook-idempotency";

const GHOST_REPLY_TOKEN = "00000000000000000000000000000000";
const GHOST_USER_ID = "Udeadbeefdeadbeefdeadbeefdeadbeef";

/** 由 routes 注入的依賴，controller 不直接 import 全域 singleton */
export interface LineWebhookDeps {
  storage: IStorage;
  broadcastSSE: (eventType: string, data: any) => void;
  pushLineMessage: (userId: string, messages: object[], token?: string | null) => Promise<void>;
  replyToLine: (replyToken: string, messages: object[], token?: string | null) => Promise<void>;
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
              const trimmedText = (text || "").trim();
              const inHandoffState = !!(contactAfterProfile.needs_human || contactAfterProfile.status === "awaiting_human" || contactAfterProfile.status === "high_risk");
              const allowOnlyLinkRestore = inHandoffState && (isLinkRequestMessage(trimmedText) || isLinkRequestCorrectionMessage(trimmedText));
              const shouldInvokeAi = !inHandoffState || allowOnlyLinkRestore;
              if (!shouldInvokeAi) {
                console.log(
                  "[WEBHOOK] 略過文字自動回覆：聯絡人已在人工／高風險流程，contact_id=",
                  contactAfterProfile.id,
                  "needs_human=",
                  contactAfterProfile.needs_human,
                  "status=",
                  contactAfterProfile.status
                );
              } else {
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
