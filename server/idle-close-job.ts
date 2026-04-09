/**
 * 24 小時閒置結案：客戶最後一則訊息後 24 小時未回覆則走結案流程。
 * 排除：已轉人工(awaiting_human)、高風險(high_risk)。
 * 結案分流：一般諮詢 / 待補單號 / 退換貨待填表 / 已轉人工不關閉。
 *
 * 僅在「上班時段」執行：假日、下班後、午休不跑閒置結案，避免「假日沒人回 → 被迫結案」。
 */
import type { IStorage } from "./storage";
import { getUnavailableReason } from "./assignment";
import { pushLineMessage, sendFBMessage, getLineTokenForContact, getFbTokenForContact, sendRatingFlexMessage } from "./services/messaging.service";
import { broadcastSSE } from "./services/sse.service";
import { isRatingEligible, isAutomatedRatingFlexAllowedForContact } from "./rating-eligibility";

const IDLE_HOURS_DEFAULT = 24;
const MS_PER_HOUR = 60 * 60 * 1000;

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

function getScenario(contact: any, _lastUserAt: Date): IdleCloseScenario {
  const tags = parseContactTags(contact);

  let scenario: IdleCloseScenario;
  if (contact.status === "awaiting_human" || contact.status === "high_risk") {
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
  const reason = getUnavailableReason();
  if (reason === "weekend" || reason === "after_hours") {
    return [];
  }

  const cutoffTime = Date.now() - idleHours * MS_PER_HOUR;
  const results: IdleCloseResult[] = [];

  const contacts = storage.getContacts(undefined, undefined, undefined, 5000);
  for (const c of contacts) {
    if (c.status === "closed" || c.status === "resolved") continue;
    if (c.status === "awaiting_human" || c.status === "high_risk") continue;
    /** 待分配（需人工但尚未指派）：不自動結案，留給主管分配或手動結案，避免品牌案件全變成已結案 */
    if (c.needs_human === 1 && !(c as any).assigned_agent_id) continue;
    const lastAt = c.last_message_at;
    if (!lastAt) continue;
    const lastUserAt = new Date(String(lastAt).replace(" ", "T"));
    if (lastUserAt.getTime() > cutoffTime) continue;
    const lastSender = (c as any).last_message_sender_type;
    if (String(lastSender || "").toLowerCase() !== "user") continue;

    const scenario = getScenario(c, lastUserAt);
    if (scenario === "handoff_no_close") {
      results.push({ contactId: c.id, closed: false, scenario, messageSent: null, closeReason: "handoff_no_auto_close" });
      continue;
    }

    const closingText = CLOSING_MESSAGES[scenario];
    storage.updateContactStatus(c.id, "closed");
    storage.updateContactClosed(c.id, 0, "idle_24h");
    storage.updateContactConversationFields(c.id, { resolution_status: "closed", close_reason: "idle_24h" });

    let aiMsg: { id: number } | null = null;
    if (closingText) {
      aiMsg = storage.createMessage(c.id, c.platform, "ai", closingText) as { id: number };
    }

    try {
      if (closingText && c.platform === "line" && c.platform_user_id) {
        const token = getLineTokenForContact(c as any);
        if (token) {
          await pushLineMessage(c.platform_user_id, [{ type: "text", text: closingText }], token);
          console.log(`[idle-close] LINE 結案訊息已推送 contact=${c.id}`);
        }
      } else if (closingText && c.platform === "messenger" && c.platform_user_id) {
        const token = getFbTokenForContact(c as any);
        if (token) {
          await sendFBMessage(token, c.platform_user_id, closingText);
          console.log(`[idle-close] FB 結案訊息已推送 contact=${c.id}`);
        }
      }
    } catch (e) {
      console.error(`[idle-close] 推送結案訊息失敗 contact=${c.id}:`, e);
    }

    if (aiMsg != null && c.brand_id != null) {
      broadcastSSE("new_message", { contact_id: c.id, message: aiMsg, brand_id: c.brand_id });
      broadcastSSE("contacts_updated", { brand_id: c.brand_id });
    }

    try {
      const updatedContact = storage.getContact(c.id);
      if (
        updatedContact &&
        isRatingEligible({ contact: updatedContact, state: null }) &&
        isAutomatedRatingFlexAllowedForContact(updatedContact, storage) &&
        updatedContact.platform === "line"
      ) {
        const token = getLineTokenForContact(updatedContact as any);
        if (token) {
          let ratingSent = false;
          if (updatedContact.needs_human === 1 && updatedContact.cs_rating == null) {
            await sendRatingFlexMessage(updatedContact as any, "human");
            ratingSent = true;
          } else if (!ratingSent && updatedContact.ai_rating == null) {
            await sendRatingFlexMessage(updatedContact as any, "ai");
            ratingSent = true;
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
      messageSent: closingText || null,
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
