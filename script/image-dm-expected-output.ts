/**
 * 圖片型私訊驗收用：依邏輯推演各情境的「預期回覆」與「預期 log」。
 * 執行：npx tsx script/image-dm-expected-output.ts
 * 實測後可對照實際回覆與 log 是否一致。
 */
import {
  SAFE_IMAGE_ONLY_REPLY,
  IMAGE_SUPPLEMENT_ESCALATE_MESSAGE,
  getImageDmReplyAndTemplateForShortCaption,
  shouldEscalateImageSupplement,
  classifyMessageForSafeAfterSale,
} from "../server/safe-after-sale-classifier";

console.log("=== 圖片型私訊驗收 — 預期輸出對照 ===\n");

// 1. 圖片 only（第一次）
console.log("【1】圖片 only（第一次）");
console.log("預期回覆（節錄）:", SAFE_IMAGE_ONLY_REPLY.slice(0, 80) + "...");
console.log("預期 log: tools_called = [\"image_dm_only\"], result_summary = \"image_only | IMAGE_DM_GENERIC\", transfer_triggered = false\n");

// 2. 圖片 + 短文字
const shortText = "幫我看";
const { text: reply2, templateName } = getImageDmReplyAndTemplateForShortCaption(shortText);
console.log("【2】圖片＋短文字（例如「幫我看」）");
console.log("預期回覆（節錄）:", reply2.slice(0, 80) + "...");
console.log("預期 log: tools_called = [\"image_dm_short_caption\"], result_summary = `image_short_caption | ${templateName}`, transfer_triggered = false\n");

// 3. 圖片 + 明確他平台文字
const platformText = "我在蝦皮買的怎麼還沒到";
const r3 = classifyMessageForSafeAfterSale(platformText);
console.log("【3】圖片＋明確他平台文字（「我在蝦皮買的怎麼還沒到」）");
console.log("classifier:", r3.matched ? r3.type : "no match");
console.log("預期: 回覆他平台訂單安全確認（reply_private），result_summary 含 safe_confirm_template 且可含 image_clear_caption");
console.log("預期 log: tools_called = [\"safe_confirm_template\"], result_summary 含 external_platform_order, transfer_triggered = false（除非另設）\n");

// 4. 圖片 + 明確詐騙文字
const fraudText = "我被假客服騙了，對方要我轉帳";
const r4 = classifyMessageForSafeAfterSale(fraudText);
console.log("【4】圖片＋明確詐騙文字（「我被假客服騙了，對方要我轉帳」）");
console.log("classifier:", r4.matched ? r4.type : "no match");
console.log("預期: 回覆詐騙蒐證引導，設為 awaiting_human，無承諾字眼");
console.log("預期 log: tools_called = [\"safe_confirm_template\"], result_summary 含 fraud_impersonation, transfer_triggered = true\n");

// 5. 連續無效後升級（近期已有 2 則圖片型補充回覆，下一則圖片應轉人工）
const mockMessagesTwoSupplements = [
  { sender_type: "user", content: "[圖片訊息]" },
  { sender_type: "ai", content: SAFE_IMAGE_ONLY_REPLY },
  { sender_type: "user", content: "[圖片訊息]" },
  { sender_type: "ai", content: SAFE_IMAGE_ONLY_REPLY },
  { sender_type: "user", content: "[圖片訊息]" },
];
const escalate = shouldEscalateImageSupplement(mockMessagesTwoSupplements);
console.log("【5】連續無效圖片／補充（近期已回過 2 次補充模板，本則應轉人工）");
console.log("預期回覆:", IMAGE_SUPPLEMENT_ESCALATE_MESSAGE);
console.log("預期: 聯絡人 awaiting_human，有 case notification");
console.log("預期 log: tools_called = [\"image_dm_only\"], result_summary = \"image_only | escalated_awaiting_human\", transfer_triggered = true");
console.log("shouldEscalateImageSupplement(近期 2 則補充) =", escalate, escalate ? "→ 會升級" : "→ 不升級");
console.log("\n※ 目前 threshold = 2：第 1、2 則圖片各得一次補充，第 3 則圖片起升級。若需求為「第 2 則就升級」請將 IMAGE_SUPPLEMENT_ESCALATE_THRESHOLD 改為 1。");
