/**
 * 主對話組裝後、由 ai-reply 追加的「程式層」片段（非品牌語氣文案）。
 * 業務 SOP／語氣以 DB Global + Brand system_prompt 為單一真相來源。
 */

import type { ReplyPlanMode } from "../reply-plan-builder";

const GOAL_HINT: Record<string, string> = {
  return: "退換貨／表單流程",
  handoff: "轉接專人",
  order_lookup: "訂單查詢",
};

export function appendGoalLockedBlock(goalLocked: string): string {
  const label = GOAL_HINT[goalLocked] || goalLocked;
  return `\n\n--- 本輪焦點（程式標記）---\n${label}（internal=${goalLocked}）\n`;
}

export function appendHandoffModeBlock(): string {
  return `\n\n--- 本輪模式（程式）: handoff ---\n請呼叫 transfer_to_human 並簡述原因；語氣由品牌／全域指令規範。\n`;
}

export function appendOffTopicGuardBlock(): string {
  return `\n\n--- 本輪模式（程式）: off_topic_guard ---\n簡短禮貌回應即可；字數約 30～50；勿展開與當下無關的流程。\n`;
}

export function appendMustNotIncludeBlock(phrases: string[]): string {
  if (!phrases.length) return "";
  return `\n\n--- 輸出約束（不得包含）---\n${phrases.join("、")}\n`;
}

export function appendNoOrderLookupLeadBlock(): string {
  return `\n\n--- 本輪（程式）---\n勿以訂單查詢開場；優先表單／退換相關流程。\n`;
}

export function appendNoPromoExtensionBlock(mode: ReplyPlanMode): string {
  return `\n\n--- 本輪模式（程式）: ${mode} ---\n勿主動延伸與當下需求無關的促銷或活動長文。\n`;
}

export function appendImageAnalysisTaskBlock(): string {
  return `\n\n--- 圖片分析（程式任務）---\n簡述與客服相關重點；無法判斷時簡短說明；必要時可建議 transfer_to_human。\n`;
}

export function appendAlreadyProvidedCluesBlock(parts: string[]): string {
  if (!parts.length) return "";
  return `\n\n--- 已提供之查詢線索（程式注入）---\n${parts.join("；")}\n`;
}
