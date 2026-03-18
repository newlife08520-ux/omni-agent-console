/**
 * Phase 2.7：查單 ultra-lite 獨立模組（不依賴 CATALOG/KNOWLEDGE/IMAGE builder）
 */
import { storage } from "../storage";

export function getBrandReplyMeta(brandId?: number): {
  salutationStyle: string;
  emojiPolicy: "minimal" | "allow";
  forbiddenPhrases: string[];
  terseOrderMode: boolean;
} {
  if (!brandId) {
    return { salutationStyle: "您好", emojiPolicy: "minimal", forbiddenPhrases: [], terseOrderMode: true };
  }
  const brand = storage.getBrand(brandId);
  const sp = (brand?.system_prompt || "").trim();
  const noEmoji = /勿用\s*emoji|不用\s*emoji|避免\s*emoji|少用\s*emoji/i.test(sp);
  return {
    salutationStyle: /親愛的/.test(sp) ? "親愛的顧客" : "您好",
    emojiPolicy: noEmoji ? "minimal" : "allow",
    forbiddenPhrases: [],
    terseOrderMode: true,
  };
}

export const ORDER_ULTRA_LITE_VERSION = "v1";

export function buildOrderLookupUltraLitePrompt(brandId?: number): string {
  const m = getBrandReplyMeta(brandId);
  const emojiLine = m.emojiPolicy === "minimal" ? "少用或不使用 emoji。" : "emoji 適度即可。";
  return `你是客服助理。僅依查單工具結果回答；嚴禁捏造訂單資料；不暴露內部代碼與流程。
結論先行、簡短、不冗長安撫。
稱呼以「${m.salutationStyle}」開頭即可。${emojiLine}
有單號用 lookup_order_by_id；無單號可用手機或商品+手機。查無則照實說明。`;
}

export function buildOrderFollowupUltraLitePrompt(brandId?: number): string {
  const m = getBrandReplyMeta(brandId);
  const emojiLine = m.emojiPolicy === "minimal" ? "少用 emoji。" : "";
  return `訂單上下文已存在。僅依工具回傳與對話中已有訂單摘要回答；一句結論＋必要細節；勿長篇。
${m.salutationStyle}。${emojiLine}`;
}
