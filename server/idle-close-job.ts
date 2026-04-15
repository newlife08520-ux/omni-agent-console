/**
 * 24 小時閒置結案：客戶最後一則訊息後 24 小時未回覆則走結案流程。
 * 排除：轉人工／高風險／已指派但客服尚未回覆等（見 isInHandoffOrPendingHumanReply）；待分配 needs_human 無指派另案排除。
 * 結案分流：一般諮詢 / 待補單號 / 退換貨待填表 / handoff 不關閉。
 *
 * Phase 106.15：滿 24h 的「到期瞬間」若落在非營業時間（含週末、國定假日），順延至下一營業日開門才結案；
 * 排程可持續執行本 job，由每筆 realCloseMoment 決定是否到點。
 */
import type { IStorage } from "./storage";
import {
  BUSINESS_HOURS,
  findNextBusinessMoment,
  getTaipeiComponents,
  isHoliday,
  isWithinBusinessHours,
} from "./services/business-hours";
import {
  pushLineMessage,
  sendFBMessage,
  getLineTokenForContact,
  getFbTokenForContact,
  sendRatingFlexMessage,
  isMessagingDelivered,
} from "./services/messaging.service";
import { broadcastSSE } from "./services/sse.service";
import { isRatingEligible, isAutomatedRatingFlexAllowedForContact } from "./rating-eligibility";

const IDLE_HOURS_DEFAULT = 24;
const MS_PER_HOUR = 60 * 60 * 1000;

function formatTaipeiWallClock(d: Date): string {
  return d.toLocaleString("sv-SE", {
    timeZone: BUSINESS_HOURS.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export type IdleCloseScenario = "general" | "waiting_order_info" | "waiting_return_form" | "handoff_no_close";

/** Phase 106.12：退換／取消表單情境的精準標籤白名單（整詞比對，不用 includes） */
const RETURN_FORM_PRECISE_TAGS = new Set([
  "退貨",
  "換貨",
  "退款",
  "退換貨",
  "退換",
  "申請退貨",
  "申請換貨",
  "申請退款",
]);

const CLOSING_MESSAGES: Record<IdleCloseScenario, string> = {
  general:
    "這邊好一陣子沒收到您的後續訊息，先幫您整理結案唷～\n若之後還想確認商品、價格或下單方式，直接再傳訊息給我，隨時都能繼續協助您！",
  waiting_order_info:
    "這邊好一陣子沒收到您的後續訊息，先幫您整理結案唷～\n若之後找到訂單編號或想到下單時的手機號碼，再傳訊息給我，我這邊就能接著幫您查～",
  waiting_return_form:
    "這邊好一陣子沒收到您的後續訊息，先幫您整理結案唷～\n若之後想繼續處理或填寫退換貨表單，再傳訊息給我，隨時都能接著協助您～",
  handoff_no_close:
    "", // 已轉人工不發結案語，僅內部告警
};

export interface IdleCloseResult {
  contactId: number;
  closed: boolean;
  scenario: IdleCloseScenario;
  messageSent: string | null;
  closeReason: string;
}

function parseContactTags(contact: any): string[] {
  return (typeof contact.tags === "string"
    ? (() => {
        try {
          return JSON.parse(contact.tags || "[]");
        } catch {
          return [];
        }
      })()
    : contact.tags) as string[];
}

function isInHandoffOrPendingHumanReply(contact: any): boolean {
  if (contact.status === "awaiting_human" || contact.status === "high_risk") {
    return true;
  }
  const aid = contact.assigned_agent_id;
  const hasAgent = aid != null && Number(aid) > 0;
  const lastUser = String(contact.last_message_sender_type || "").toLowerCase() === "user";
  if (hasAgent && lastUser && (contact.last_human_reply_at == null || String(contact.last_human_reply_at).trim() === "")) {
    return true;
  }
  return false;
}

function getScenario(contact: any, _lastUserAt: Date): IdleCloseScenario {
  const tags = parseContactTags(contact);

  let scenario: IdleCloseScenario;
  if (isInHandoffOrPendingHumanReply(contact)) {
    scenario = "handoff_no_close";
  } else if (tags.some((t: string) => t === "待訂單編號" || t === "待補單號")) {
    scenario = "waiting_order_info";
  } else {
    const isInReturnFormFlow =
      contact.waiting_for_customer === "return_form_submit" ||
      contact.waiting_for_customer === "exchange_form_submit" ||
      contact.waiting_for_customer === "cancel_form_submit" ||
      tags.some((t: string) => RETURN_FORM_PRECISE_TAGS.has(t));
    scenario = isInReturnFormFlow ? "waiting_return_form" : "general";
  }

  console.log("[idle-close] scenario_decision", {
    contactId: contact.id,
    scenario,
    hasWaitingFormState: !!contact.waiting_for_customer,
    waitingForCustomer: contact.waiting_for_customer,
    hasReturnFormPreciseTag: tags.some((t: string) => RETURN_FORM_PRECISE_TAGS.has(t)),
    legacyIssueType: contact.issue_type,
  });

  return scenario;
}

export async function runIdleCloseJob(storage: IStorage, idleHours: number = IDLE_HOURS_DEFAULT): Promise<IdleCloseResult[]> {
  const results: IdleCloseResult[] = [];

  const contacts = storage.getContacts(undefined, undefined, undefined, 5000);
  for (const c of contacts) {
    if (c.status === "closed" || c.status === "resolved") continue;
    /** 待分配（需人工但尚未指派）：不自動結案，留給主管分配或手動結案，避免品牌案件全變成已結案 */
    if (c.needs_human === 1 && !(c as any).assigned_agent_id) continue;
    const lastAt = c.last_message_at;
    if (!lastAt) continue;
    const lastSender = (c as any).last_message_sender_type;
    if (String(lastSender || "").toLowerCase() !== "user") continue;

    const lastMessageMs = new Date(String(lastAt).replace(" ", "T")).getTime();
    const idleMs = Date.now() - lastMessageMs;
    if (idleMs < idleHours * MS_PER_HOUR) continue;

    const lastUserAt = new Date(lastMessageMs);

    const expireMoment = new Date(lastMessageMs + idleHours * MS_PER_HOUR);
    const realCloseMoment = findNextBusinessMoment(expireMoment);
    const tpExpire = getTaipeiComponents(expireMoment);
    const postpone = Date.now() < realCloseMoment.getTime();
    console.log("[idle-close-debug]", {
      contactId: c.id,
      expireMoment: formatTaipeiWallClock(expireMoment),
      realCloseMoment: formatTaipeiWallClock(realCloseMoment),
      "isWithinBusinessHours(expireMoment)": isWithinBusinessHours(expireMoment),
      "isHoliday(expireMoment)": isHoliday(tpExpire.dateStr),
      dayOfWeek: tpExpire.dayOfWeek,
      decision: postpone ? "postponed" : "proceed",
    });
    if (postpone) {
      console.log("[idle-close] postponed by business hours/holidays", {
        contactId: c.id,
        expireMoment: expireMoment.toISOString(),
        realCloseMoment: realCloseMoment.toISOString(),
        waitMoreMs: realCloseMoment.getTime() - Date.now(),
      });
      continue;
    }

    const scenario = getScenario(c, lastUserAt);
    if (scenario === "handoff_no_close") {
      console.log("[idle-close] skip handoff contact", {
        contactId: c.id,
        status: c.status,
        needs_human: c.needs_human,
      });
      results.push({
        contactId: c.id,
        closed: false,
        scenario: "handoff_no_close",
        messageSent: null,
        closeReason: "handoff_no_auto_close",
      });
      continue;
    }

    console.log("[idle-close] ready to close", {
      contactId: c.id,
      lastMessageAt: c.last_message_at,
      expireMoment: expireMoment.toISOString(),
      realCloseMoment: realCloseMoment.toISOString(),
    });

    const closingText = CLOSING_MESSAGES[scenario];

    const chId = c.channel_id != null ? Number(c.channel_id) : NaN;
    const channel = Number.isFinite(chId) && chId > 0 ? storage.getChannel(chId) : undefined;
    let skipClosingPush = false;
    if (!channel) {
      console.warn("[idle-close] channel not found, skip closing message", { contactId: c.id, channelId: c.channel_id });
      skipClosingPush = true;
    } else if ((channel.is_ai_enabled ?? 0) !== 1) {
      console.log("[idle-close] channel AI disabled, skip closing message push", {
        contactId: c.id,
        channelId: channel.id,
        channelName: channel.channel_name,
        scenario,
      });
      storage.createSystemAlert({
        alert_type: "idle_close_skipped_ai_disabled",
        details: JSON.stringify({
          contactId: c.id,
          channelId: channel.id,
          channelName: channel.channel_name,
          reason: "channel_ai_disabled",
          scenario,
          wouldHaveSentMessage: closingText,
          timestamp: new Date().toISOString(),
        }),
        brand_id: c.brand_id ?? channel.brand_id,
        contact_id: c.id,
      });
      skipClosingPush = true;
    }

    storage.updateContactStatus(c.id, "closed");
    storage.updateContactClosed(c.id, 0, "idle_24h");
    storage.updateContactConversationFields(c.id, { resolution_status: "closed", close_reason: "idle_24h" });

    const updatedAfterClose = storage.getContact(c.id);
    const willPushClosingMessage = Boolean(closingText && !skipClosingPush);
    const willPushRatingFlex = Boolean(
      updatedAfterClose &&
        isRatingEligible({ contact: updatedAfterClose, state: null }) &&
        isAutomatedRatingFlexAllowedForContact(updatedAfterClose, storage) &&
        updatedAfterClose.platform === "line" &&
        getLineTokenForContact(updatedAfterClose as any),
    );
    console.log("[idle-close] decision", {
      contactId: c.id,
      scenario,
      channelAiEnabled: channel?.is_ai_enabled ?? null,
      willPushClosingMessage,
      willPushRatingFlex,
    });

    let aiMsg: { id: number } | null = null;
    /** Phase 106.21：無結案語要推時視為 true；有結案語時僅在 push 成功後為 true（評價邀請亦依此 gate） */
    let closingPushDelivered = !willPushClosingMessage;

    try {
      if (willPushClosingMessage && c.platform === "line" && c.platform_user_id) {
        const token = getLineTokenForContact(c as any);
        if (token) {
          const r = await pushLineMessage(c.platform_user_id, [{ type: "text", text: closingText }], token);
          if (isMessagingDelivered(r)) {
            closingPushDelivered = true;
            aiMsg = storage.createMessage(c.id, c.platform, "ai", closingText) as { id: number };
            console.log(`[idle-close] LINE 結案訊息已推送 contact=${c.id}`);
          } else {
            closingPushDelivered = false;
            console.warn(`[106.21][idle-close] LINE 結案 push 未送達，不寫入客戶可見 AI 訊息 contact=${c.id}`);
          }
        } else {
          closingPushDelivered = false;
        }
      } else if (willPushClosingMessage && c.platform === "messenger" && c.platform_user_id) {
        const token = getFbTokenForContact(c as any);
        if (token) {
          const r = await sendFBMessage(token, c.platform_user_id, closingText);
          if (isMessagingDelivered(r)) {
            closingPushDelivered = true;
            aiMsg = storage.createMessage(c.id, c.platform, "ai", closingText) as { id: number };
            console.log(`[idle-close] FB 結案訊息已推送 contact=${c.id}`);
          } else {
            closingPushDelivered = false;
            console.warn(`[106.21][idle-close] FB 結案 push 未送達 contact=${c.id}`);
          }
        } else {
          closingPushDelivered = false;
        }
      }
    } catch (e) {
      console.error(`[idle-close] 推送結案訊息失敗 contact=${c.id}:`, e);
      closingPushDelivered = false;
    }

    if (aiMsg != null && c.brand_id != null) {
      broadcastSSE("new_message", { contact_id: c.id, message: aiMsg, brand_id: c.brand_id });
      broadcastSSE("contacts_updated", { brand_id: c.brand_id });
    }

    try {
      const updatedContact = updatedAfterClose ?? storage.getContact(c.id);
      if (
        closingPushDelivered &&
        updatedContact &&
        isRatingEligible({ contact: updatedContact, state: null }) &&
        isAutomatedRatingFlexAllowedForContact(updatedContact, storage) &&
        updatedContact.platform === "line"
      ) {
        const token = getLineTokenForContact(updatedContact as any);
        if (token) {
          let ratingSent = false;
          if (updatedContact.needs_human === 1 && updatedContact.cs_rating == null) {
            ratingSent = await sendRatingFlexMessage(updatedContact as any, "human");
          } else if (!ratingSent && updatedContact.ai_rating == null) {
            ratingSent = await sendRatingFlexMessage(updatedContact as any, "ai");
          }
          if (ratingSent) {
            const now = new Date().toISOString().replace("T", " ").substring(0, 19);
            storage.updateContactConversationFields(c.id, { rating_invited_at: now });
            storage.createMessage(c.id, c.platform, "system", "(系統) 已發送滿意度評價邀請給客戶");
            console.log(`[idle-close] LINE 評價邀請已發送 contact=${c.id}`);
            broadcastSSE("contacts_updated", { contact_id: c.id, brand_id: updatedContact.brand_id ?? undefined });
          }
        }
      }
    } catch (e) {
      console.error(`[idle-close] 發送評價邀請失敗 contact=${c.id}:`, e);
    }

    results.push({
      contactId: c.id,
      closed: true,
      scenario,
      messageSent: skipClosingPush ? null : closingPushDelivered ? closingText : null,
      closeReason: "idle_24h",
    });
  }

  return results;
}

export function getIdleCloseHours(storage: IStorage): number {
  const raw = storage.getSetting("idle_close_hours");
  if (raw == null || raw === "") return IDLE_HOURS_DEFAULT;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return IDLE_HOURS_DEFAULT;
  return Math.min(168, n);
}
