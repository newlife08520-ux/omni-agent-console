/**
 * 24 小時閒置結案：客戶最後一則訊息後 24 小時未回覆則走結案流程。
 * 排除：已轉人工(awaiting_human)、高風險(high_risk)。
 * 結案分流：一般諮詢 / 待補單號 / 退換貨待填表 / 已轉人工不關閉。
 *
 * 僅在「上班時段」執行：假日、下班後、午休不跑閒置結案，避免「假日沒人回 → 被迫結案」。
 */
import type { IStorage } from "./storage";
import { getUnavailableReason } from "./assignment";

const IDLE_HOURS_DEFAULT = 24;
const MS_PER_HOUR = 60 * 60 * 1000;

export type IdleCloseScenario = "general" | "waiting_order_info" | "waiting_return_form" | "handoff_no_close";

const CLOSING_MESSAGES: Record<IdleCloseScenario, string> = {
  general:
    "先幫您整理到這邊唷😊 若之後還想確認商品、價格或下單方式，直接再傳訊息給我就可以了～",
  waiting_order_info:
    "這邊先幫您保留到這裡唷🙏 若之後找到訂單編號，或方便補商品名稱＋下單手機，再直接傳我，我就能接著幫您查。",
  waiting_return_form:
    "目前先幫您暫時整理到這邊🙏 若您之後要申請退換貨，直接填寫表單或再傳訊息給我，我這邊都能接著協助您處理。",
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

function getScenario(contact: any, lastUserAt: Date): IdleCloseScenario {
  if (contact.status === "awaiting_human" || contact.status === "high_risk") return "handoff_no_close";
  const tags = (typeof contact.tags === "string" ? (() => { try { return JSON.parse(contact.tags || "[]"); } catch { return []; } })() : contact.tags) as string[];
  if (tags.some((t: string) => t === "待訂單編號" || t === "待補單號")) return "waiting_order_info";
  if (contact.issue_type === "return_refund" || tags.some((t: string) => t.includes("退") || t.includes("換"))) return "waiting_return_form";
  return "general";
}

export function runIdleCloseJob(storage: IStorage, idleHours: number = IDLE_HOURS_DEFAULT): IdleCloseResult[] {
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
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    storage.updateContactStatus(c.id, "closed");
    storage.updateContactClosed(c.id, 0, "idle_24h");
    storage.updateContactConversationFields(c.id, { resolution_status: "closed", close_reason: "idle_24h" });
    if (closingText) {
      storage.createMessage(c.id, c.platform, "ai", closingText);
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
