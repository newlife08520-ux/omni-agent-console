// === 對話分類常數 ===
// 未來想調整門檻，改這裡就好

/**
 * 「逾時」門檻：客戶最後發言超過此時間視為逾時
 * 影響：列表 is_overdue（API）、主管/客服面板的「逾時」COUNT
 */
export const OVERDUE_THRESHOLD_MS = 60 * 60 * 1000; // 1 小時

/**
 * 「VIP 逾時加緊急」門檻：VIP 客戶最後發言超過此時間視為緊急
 * 影響：列表 is_urgent（API）、主管/客服面板的「緊急」COUNT
 */
export const URGENT_VIP_OVERDUE_MS = 60 * 60 * 1000; // 1 小時

/**
 * 「高優先級」門檻：case_priority ≤ 此值視為緊急
 * 影響：所有「緊急」判斷
 */
export const URGENT_PRIORITY_THRESHOLD = 2;

/**
 * 緊急標籤關鍵字 regex
 * 影響：列表 is_urgent（API）、主管/客服面板的「緊急」COUNT
 */
export const URGENT_TAG_PATTERN = /緊急|投訴|客訴|急/;

export interface UrgencyEvaluationContext {
  contact: {
    id?: number;
    status?: string | null;
    case_priority?: number | null;
    vip_level?: number | null;
    tags?: string | string[] | null;
    last_message_sender_type?: string | null;
    last_message_at?: string | null;
    response_sla_deadline_at?: string | null;
  };
  now: Date;
}

export interface UrgencyResult {
  isUrgent: boolean;
  reasons: string[];
}

export interface OverdueEvaluationContext {
  contact: {
    last_message_sender_type?: string | null;
    last_message_at?: string | null;
    needs_human?: number | null;
    status?: string | null;
  };
  now: Date;
}

function parseDbDateTimeMs(s: string | null | undefined): number | null {
  if (s == null || String(s).trim() === "") return null;
  const ms = new Date(String(s).replace(" ", "T")).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function parseContactTags(tags: string | string[] | null | undefined): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((t) => String(t));
  try {
    const parsed = JSON.parse(tags || "[]");
    return Array.isArray(parsed) ? parsed.map((t: unknown) => String(t)) : [];
  } catch {
    return [];
  }
}

export function evaluateContactUrgency(ctx: UrgencyEvaluationContext): UrgencyResult {
  const { contact, now } = ctx;
  const reasons: string[] = [];
  const st = contact.status != null ? String(contact.status) : "";

  if (st === "closed" || st === "resolved") {
    return { isUrgent: false, reasons: [] };
  }

  if (st === "high_risk") {
    reasons.push("high_risk_status");
  }

  const priority = contact.case_priority ?? 999;
  if (priority <= URGENT_PRIORITY_THRESHOLD) {
    reasons.push(`high_priority_${priority}`);
  }

  const tagsArray = parseContactTags(contact.tags);
  const hasUrgentTag = tagsArray.some((t) => URGENT_TAG_PATTERN.test(t));
  if (hasUrgentTag) {
    reasons.push("urgent_tag");
  }

  const isVip = (contact.vip_level ?? 0) > 0;
  const lastSenderIsUser = String(contact.last_message_sender_type || "").toLowerCase() === "user";
  const lastMessageMs = parseDbDateTimeMs(contact.last_message_at ?? null);
  const isVipOverdue =
    isVip && lastSenderIsUser && lastMessageMs != null && now.getTime() - lastMessageMs > URGENT_VIP_OVERDUE_MS;
  if (isVipOverdue) {
    reasons.push("vip_overdue_1h");
  }

  if (contact.response_sla_deadline_at) {
    const slaMs = parseDbDateTimeMs(contact.response_sla_deadline_at);
    if (slaMs != null && slaMs < now.getTime()) {
      reasons.push("sla_breach");
    }
  }

  return {
    isUrgent: reasons.length > 0,
    reasons,
  };
}

export function evaluateContactOverdue(ctx: OverdueEvaluationContext): boolean {
  const { contact, now } = ctx;
  const st = contact.status != null ? String(contact.status) : "";
  if (st === "resolved" || st === "closed") {
    return false;
  }
  if (String(contact.last_message_sender_type || "").toLowerCase() !== "user") {
    return false;
  }
  if (!contact.last_message_at) return false;
  const lastMs = parseDbDateTimeMs(contact.last_message_at);
  if (lastMs == null) return false;
  return now.getTime() - lastMs > OVERDUE_THRESHOLD_MS;
}
