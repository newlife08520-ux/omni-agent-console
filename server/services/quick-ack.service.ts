/**
 * Quick Ack：主 LLM 前先送短確認；隨機池降低「固定一句像機器人」感。
 * 僅查單（ORDER_LOOKUP）與售後（AFTER_SALES）送出；一般問候（GENERAL）與商品諮詢不送。
 */
import { brandMessage } from "../phase2-output";
import type { MessagingOutboundSkipped } from "./messaging.service";

/** 是否應送 Quick Ack（與工具回合內查單 ack 共用條件） */
export function shouldSendQuickAck(params: {
  orderLookupAckEnabled: boolean;
  sentLookupAckThisTurn: boolean;
  planMode: string;
  scenarioKey: string;
  userMessage?: string;
}): boolean {
  const { orderLookupAckEnabled, sentLookupAckThisTurn, planMode, scenarioKey } = params;
  if (!orderLookupAckEnabled || sentLookupAckThisTurn) return false;
  if (planMode === "handoff" || planMode === "off_topic_guard") return false;
  return scenarioKey === "ORDER_LOOKUP" || scenarioKey === "AFTER_SALES";
}

const quickAckPools: Record<string, string[]> = {
  ORDER_LOOKUP: [
    "收到，我幫您查一下",
    "好的，查詢中請稍等",
    "了解，我來幫您看看訂單狀況",
    "收到囉，幫您確認中",
    "好，我先查一下",
  ],
  AFTER_SALES: [
    "了解，我先幫您看看",
    "收到了，我來確認一下",
    "好的，讓我幫您處理",
    "了解您的狀況，我先看一下",
    "收到，我幫您確認",
  ],
  PRODUCT_CONSULT: [
    "好的，讓我查一下",
    "收到，我幫您看看",
    "了解，幫您確認中",
    "好喔，讓我查查",
    "收到囉，稍等一下",
  ],
  GENERAL: [
    "收到，我來看看",
    "好的，讓我確認一下",
    "了解，稍等我一下",
    "收到囉",
    "好的好的",
  ],
};

export function pickRandomAck(scenario: string): string {
  const pool = quickAckPools[scenario] || quickAckPools["GENERAL"];
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export type QuickAckChannelDeps = {
  createMessage: (contactId: number, platform: string, senderType: "ai", text: string) => { id: number };
  broadcastSSE: (eventType: string, data: unknown) => void;
  pushLineMessage: (
    userId: string,
    messages: object[],
    token?: string | null
  ) => Promise<void | MessagingOutboundSkipped>;
  sendFBMessage: (
    pageAccessToken: string,
    recipientId: string,
    text: string
  ) => Promise<void | MessagingOutboundSkipped>;
};

/**
 * 若應送 Quick Ack：寫入訊息、SSE、推 LINE/FB。呼叫端負責更新 sentLookupAckThisTurn / latency 欄位。
 */
export async function sendQuickAckIfNeeded(
  deps: QuickAckChannelDeps,
  params: {
    enabled: boolean;
    alreadySent: boolean;
    planMode: string;
    scenario: string;
    userMessage?: string;
    brandId?: number;
    contactId: number;
    platform: string;
    platformUserId: string;
    channelToken: string | null;
    contactBrandId?: number | null;
    startTime: number;
    queueWaitMs?: number | null;
  }
): Promise<{ sent: boolean; ackMs: number | null; firstVisibleMs: number | null }> {
  const {
    enabled,
    alreadySent,
    planMode,
    scenario,
    userMessage,
    brandId,
    contactId,
    platform,
    platformUserId,
    channelToken,
    contactBrandId,
    startTime,
    queueWaitMs,
  } = params;

  if (
    !shouldSendQuickAck({
      orderLookupAckEnabled: enabled,
      sentLookupAckThisTurn: alreadySent,
      planMode,
      scenarioKey: scenario,
      userMessage,
    })
  ) {
    return { sent: false, ackMs: null, firstVisibleMs: null };
  }

  const defaultAck = pickRandomAck(scenario);
  const quickAckText = brandMessage(brandId, "quick_ack_" + scenario.toLowerCase(), defaultAck);
  const contactPlatformAck = platform || "line";
  const ackMsg = deps.createMessage(contactId, contactPlatformAck, "ai", quickAckText);
  deps.broadcastSSE("new_message", { contact_id: contactId, message: ackMsg, brand_id: brandId || contactBrandId });
  deps.broadcastSSE("contacts_updated", { brand_id: contactBrandId ?? undefined });
  if (channelToken && contactPlatformAck === "messenger") {
    deps.sendFBMessage(channelToken, platformUserId, quickAckText).catch(() => {});
  } else if (channelToken) {
    deps.pushLineMessage(platformUserId, [{ type: "text", text: quickAckText }], channelToken).catch(() => {});
  }

  const ackMs = Date.now() - startTime;
  console.log(
    `[phase26_latency] quick_ack_sent_ms=${ackMs} contact=${contactId} scenario=${scenario} queue_wait_ms=${queueWaitMs ?? 0}`
  );
  return { sent: true, ackMs, firstVisibleMs: ackMs };
}
