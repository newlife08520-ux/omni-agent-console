/**
 * Phase 2.6：最後一哩對客語氣收斂（輕量，不刪訂單資料）。
 */
export type NormalizerMode = "order_lookup" | "order_followup" | "general";

export interface NormalizeCustomerFacingOptions {
  mode: NormalizerMode;
  replySource: string;
  renderer?: string;
  platform?: string;
}

export interface NormalizeCustomerFacingResult {
  text: string;
  changed: boolean;
  rulesHit: string[];
}

const AI_FILLER_OPENERS = [
  /^很(?:高興|榮幸)能為您服務[，,。.]?\s*/u,
  /^感謝您的(?:耐心|等候|等待)[，,。.]?\s*/u,
  /^希望(?:以上|這些)(?:資訊|說明)對您有幫助[，,。.]?\s*/u,
  /^如果您還有任何問題[，,。.]?\s*(?:歡迎|隨時).{0,20}$/u,
  /^我會隨時在這裡幫您[，,。.]?\s*/u,
  /^有任何需要請隨時告訴我[，,。.]?\s*/u,
];

const HOLLOW_PHRASES = [
  /若您還有任何疑問[，,]歡迎隨時告訴我[!！。.]?\s*/gu,
  /祝您有美好的一天[!！。.]?\s*/gu,
  /祝您購物愉快[!！。.]?\s*/gu,
];

function stripRepeatedEmoji(s: string): string {
  return s.replace(/([\u{1F300}-\u{1F9FF}]|[\u2600-\u26FF])\1{2,}/gu, "$1");
}

function stripLeadingComfort(s: string): string {
  let t = s.trimStart();
  const comfort = /^(別擔心|別急|沒問題的?|理解您的心情)[，,。.]\s*/u;
  if (comfort.test(t)) t = t.replace(comfort, "");
  return t;
}

export function normalizeCustomerFacingOrderReply(
  raw: string,
  opts: NormalizeCustomerFacingOptions
): NormalizeCustomerFacingResult {
  const rulesHit: string[] = [];
  if (!raw || !raw.trim()) {
    return { text: raw, changed: false, rulesHit: [] };
  }
  let text = raw;
  const hard = opts.mode === "order_lookup" || opts.mode === "order_followup";

  if (hard) {
    for (const re of AI_FILLER_OPENERS) {
      const n = text.replace(re, "");
      if (n !== text) {
        rulesHit.push("strip_ai_filler_opener");
        text = n;
      }
    }
    const c = stripLeadingComfort(text);
    if (c !== text) {
      rulesHit.push("strip_comfort_lead");
      text = c;
    }
    for (const re of HOLLOW_PHRASES) {
      const n = text.replace(re, "");
      if (n !== text) {
        rulesHit.push("strip_hollow_phrase");
        text = n;
      }
    }
    const e = stripRepeatedEmoji(text);
    if (e !== text) {
      rulesHit.push("dedupe_emoji");
      text = e;
    }
  } else {
    const e = stripRepeatedEmoji(text);
    if (e !== text) {
      rulesHit.push("dedupe_emoji");
      text = e;
    }
  }

  text = text.replace(/\n{4,}/g, "\n\n\n").trim();
  const changed = text !== raw.trimEnd() && (text !== raw || rulesHit.length > 0);
  return { text: changed ? text : raw, changed, rulesHit };
}
