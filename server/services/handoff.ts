/**
 * 統一 handoff（轉人工）入口，避免人格與多處散落改狀態互相打架。
 * reason 必須為 canonical enum；自由文字存 reason_detail。idempotent 不重複改狀態，但新事件仍留 audit。
 */

import { storage } from "../storage";

export type HandoffReason =
  | "explicit_human_request"
  | "legal_or_reputation_threat"
  | "payment_or_order_risk"
  | "policy_exception"
  | "repeat_unresolved"
  | "return_stage_3_insist"
  | "timeout_escalation"
  | "high_risk_short_circuit"
  | "awkward_repeat"
  | "post_reply_handoff";

const CANONICAL_REASONS: HandoffReason[] = [
  "explicit_human_request",
  "legal_or_reputation_threat",
  "payment_or_order_risk",
  "policy_exception",
  "repeat_unresolved",
  "return_stage_3_insist",
  "timeout_escalation",
  "high_risk_short_circuit",
  "awkward_repeat",
  "post_reply_handoff",
];

/** 自由文字對應到 canonical reason 的關鍵字（小寫比對） */
const REASON_KEYWORDS: { kw: string[]; reason: HandoffReason }[] = [
  { kw: ["high_risk", "high risk", "legal", "風險", "法務"], reason: "high_risk_short_circuit" },
  { kw: ["timeout", "逾時", "超時"], reason: "timeout_escalation" },
  { kw: ["awkward", "重複", "repeat"], reason: "awkward_repeat" },
  { kw: ["return_stage", "退換貨", "堅持退"], reason: "return_stage_3_insist" },
  { kw: ["explicit", "人工", "真人", "轉人工", "keyword"], reason: "explicit_human_request" },
  { kw: ["policy", "safe_confirm", "safe confirm"], reason: "policy_exception" },
  { kw: ["repeat_unresolved", "already_provided", "查無"], reason: "repeat_unresolved" },
  { kw: ["post_reply", "image_escalate", "video"], reason: "post_reply_handoff" },
];

export interface NormalizedHandoffReason {
  reason: HandoffReason;
  reason_detail?: string;
}

/**
 * 將自由文字轉成 canonical reason + 可選 reason_detail（原文字截短安全存）。
 */
export function normalizeHandoffReason(rawReason: string | null | undefined): NormalizedHandoffReason {
  const raw = (rawReason ?? "").trim();
  if (!raw) {
    return { reason: "explicit_human_request", reason_detail: undefined };
  }
  const lower = raw.toLowerCase();
  const alreadyCanonical = CANONICAL_REASONS.find((r) => r === lower || r === raw);
  if (alreadyCanonical) {
    return { reason: alreadyCanonical, reason_detail: undefined };
  }
  for (const { kw, reason } of REASON_KEYWORDS) {
    if (kw.some((k) => lower.includes(k))) {
      const detail = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
      return { reason, reason_detail: detail };
    }
  }
  const detail = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
  return { reason: "explicit_human_request", reason_detail: detail };
}

export interface ApplyHandoffParams {
  contactId: number;
  /** 僅接受 canonical HandoffReason */
  reason: HandoffReason;
  /** 自由文字另存，不污染 reason enum */
  reason_detail?: string;
  source: string;
  platform?: string;
  createCaseNotification?: boolean;
  markNeedsAssignment?: boolean;
  brandId?: number;
  statusOverride?: "awaiting_human" | "high_risk";
}

function writeTransferAlert(payload: {
  contactId: number;
  source: string;
  reason: HandoffReason;
  reason_detail?: string;
  brandId?: number;
  previous_status?: string;
  next_status: string;
}): void {
  const details = JSON.stringify({
    source: payload.source,
    reason: payload.reason,
    reason_detail: payload.reason_detail ?? null,
    contact_id: payload.contactId,
    previous_status: payload.previous_status ?? null,
    next_status: payload.next_status,
  });
  storage.createSystemAlert({
    alert_type: "transfer",
    details,
    contact_id: payload.contactId,
    brand_id: payload.brandId,
  });
}

/**
 * 單一真實入口：套用轉人工狀態與副作用，並寫入固定格式 alert（JSON）。
 * Idempotent：已在 handoff 時不重複改狀態，但**仍寫入新 alert**；若新 reason 為 high_risk_short_circuit 則允許升級為 high_risk。
 */
export function applyHandoff(params: ApplyHandoffParams): boolean {
  const {
    contactId,
    reason,
    reason_detail,
    source,
    createCaseNotification = true,
    brandId,
    statusOverride,
  } = params;

  const contact = storage.getContact(contactId);
  if (!contact) {
    console.warn(`[Handoff] contact ${contactId} not found, skip`);
    return false;
  }

  const effectiveBrandId = brandId ?? contact.brand_id ?? undefined;
  const targetStatus = statusOverride ?? "awaiting_human";
  const alreadyHandoff = (contact.status === "awaiting_human" || contact.status === "high_risk") && contact.needs_human === 1;
  const allowUpgrade = alreadyHandoff && reason === "high_risk_short_circuit" && contact.status !== "high_risk";

  if (alreadyHandoff && !allowUpgrade) {
    console.log(`[Handoff] contact ${contactId} already handoff (${contact.status}), skip state update; still recording event (source=${source}, reason=${reason})`);
    writeTransferAlert({
      contactId,
      source,
      reason,
      reason_detail,
      brandId: effectiveBrandId,
      previous_status: contact.status,
      next_status: contact.status,
    });
    return false;
  }

  if (allowUpgrade) {
    storage.updateContactStatus(contactId, "high_risk");
    storage.updateContactHumanFlag(contactId, 1);
    storage.updateContactAssignmentStatus(contactId, "waiting_human");
    if (createCaseNotification !== false) storage.createCaseNotification(contactId, "in_app");
    writeTransferAlert({
      contactId,
      source,
      reason,
      reason_detail,
      brandId: effectiveBrandId,
      previous_status: contact.status,
      next_status: "high_risk",
    });
    console.log(`[Handoff] contact ${contactId} upgraded to high_risk reason=${reason} source=${source}`);
    return true;
  }

  storage.updateContactStatus(contactId, targetStatus);
  storage.updateContactHumanFlag(contactId, 1);
  storage.updateContactAssignmentStatus(contactId, "waiting_human");
  if (createCaseNotification !== false) {
    storage.createCaseNotification(contactId, "in_app");
  }
  writeTransferAlert({
    contactId,
    source,
    reason,
    reason_detail,
    brandId: effectiveBrandId,
    previous_status: contact.status,
    next_status: targetStatus,
  });
  console.log(`[Handoff] contact ${contactId} reason=${reason} source=${source}`);
  return true;
}
