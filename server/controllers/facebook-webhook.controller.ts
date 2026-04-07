/**
 * Facebook Webhook 控制器
 * 負責驗簽、路由 messaging / feed events、contact 管理、AI 回覆排程、公開留言寫入。
 * 所有外部依賴皆透過 DI 注入，controller 本身不直接 import 全域 singleton。
 */
import type { Request, Response } from "express";
import crypto from "crypto";
import type { IStorage } from "../storage";
import { recordAutoReplyBlocked } from "../auto-reply-blocked";
import {
  isLinkRequestMessage,
  isLinkRequestCorrectionMessage,
  isConversationResetRequest,
  HANDOFF_QUEUE_RESET_BLOCK_REPLY,
  isReturnFormFollowupMessage,
  isEligibleReturnFormFollowupResumeContact,
  isAiServiceRequest,
} from "../conversation-state-resolver";
import { shouldEscalateImageSupplement } from "../safe-after-sale-classifier";
import { applyHandoff } from "../services/handoff";
import { resolveOpenAIModel } from "../openai-model";

export interface FacebookWebhookDeps {
  storage: IStorage;
  broadcastSSE: (eventType: string, data: any) => void;
  sendFBMessage: (pageAccessToken: string, recipientId: string, text: string) => Promise<void>;
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
                const trimmedText = (text || "").trim();
                const inHandoffState = !!(contact.needs_human || contact.status === "awaiting_human" || contact.status === "high_risk");
                if (inHandoffState && isConversationResetRequest(trimmedText)) {
                  const canned = HANDOFF_QUEUE_RESET_BLOCK_REPLY;
                  const aiMsg = storage.createMessage(contact.id, "messenger", "ai", canned);
                  broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: matchedBrandId || contact.brand_id });
                  broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
                  if (matchedChannel?.access_token) {
                    sendFBMessage(matchedChannel.access_token, senderId, canned).catch((err) =>
                      console.error("[FB Webhook] 人工排隊中重置阻擋回覆失敗:", err)
                    );
                  }
                } else {
                const contactFresh = storage.getContact(contact.id) ?? contact;
                const allowHandoffAiResume =
                  inHandoffState &&
                  (isLinkRequestMessage(trimmedText) ||
                    isLinkRequestCorrectionMessage(trimmedText) ||
                    (isReturnFormFollowupMessage(trimmedText) &&
                      isEligibleReturnFormFollowupResumeContact(contactFresh)) ||
                    isAiServiceRequest(trimmedText));
                const shouldInvokeAi = !inHandoffState || allowHandoffAiResume;
                if (shouldInvokeAi) {
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
                        enqueueDebouncedAiReply("messenger", contact.id, text, inboundEventId, matchedChannel.access_token ?? null, matchedBrandId).catch(err =>
                          console.error("[FB Webhook] enqueueDebouncedAiReply failed:", err)
                        );
                      }
                    }
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
