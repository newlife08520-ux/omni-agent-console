/**
 * Chat 頁面專用：從 @shared/schema 複製的「執行時常數」。
 * 僅在此定義，避免 chat chunk 在 runtime 依賴 @shared/schema，
 * 從而消除 ESM 循環依賴／chunk 初始化順序導致的 TDZ（Cannot access 'l' before initialization）。
 *
 * 型別仍由 chat.tsx 以 type-only 從 @shared/schema 匯入。
 */

import type { ContactStatus, IssueType, OrderSource } from "@shared/schema";

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  pending: "待處理",
  processing: "處理中",
  resolved: "已解決",
  ai_handling: "AI處理中",
  awaiting_human: "待人工接手",
  high_risk: "高風險",
  closed: "已結案",
  new_case: "新案件",
  pending_info: "待補資訊",
  pending_order_id: "待訂單編號",
  assigned: "已分配",
  waiting_customer: "等待客戶回覆",
  resolved_observe: "已解決待觀察",
  reopened: "已重開",
};

export const CONTACT_STATUS_COLORS: Record<ContactStatus, { bg: string; dot: string }> = {
  pending: { bg: "bg-red-50 text-red-700", dot: "bg-red-500" },
  processing: { bg: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
  resolved: { bg: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  ai_handling: { bg: "bg-blue-50 text-blue-700", dot: "bg-blue-500" },
  awaiting_human: { bg: "bg-orange-50 text-orange-700", dot: "bg-orange-500" },
  high_risk: { bg: "bg-rose-50 text-rose-700", dot: "bg-rose-600" },
  closed: { bg: "bg-stone-50 text-stone-500", dot: "bg-stone-400" },
  new_case: { bg: "bg-sky-50 text-sky-700", dot: "bg-sky-500" },
  pending_info: { bg: "bg-yellow-50 text-yellow-700", dot: "bg-yellow-500" },
  pending_order_id: { bg: "bg-violet-50 text-violet-700", dot: "bg-violet-500" },
  assigned: { bg: "bg-indigo-50 text-indigo-700", dot: "bg-indigo-500" },
  waiting_customer: { bg: "bg-cyan-50 text-cyan-700", dot: "bg-cyan-500" },
  resolved_observe: { bg: "bg-emerald-50 text-emerald-600", dot: "bg-emerald-400" },
  reopened: { bg: "bg-rose-50 text-rose-600", dot: "bg-rose-500" },
};

export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  order_inquiry: "訂單查詢",
  product_consult: "商品諮詢",
  return_refund: "退貨退款",
  complaint: "客訴",
  order_modify: "訂單修改",
  general: "一般諮詢",
  other: "其他",
};

export const ISSUE_TYPE_COLORS: Record<IssueType, string> = {
  order_inquiry: "bg-blue-100 text-blue-700",
  product_consult: "bg-violet-100 text-violet-700",
  return_refund: "bg-rose-100 text-rose-700",
  complaint: "bg-red-100 text-red-700",
  order_modify: "bg-amber-100 text-amber-700",
  general: "bg-stone-100 text-stone-600",
  other: "bg-gray-100 text-gray-600",
};

export const ORDER_SOURCE_LABELS: Record<OrderSource, string> = {
  superlanding: "一頁商店",
  shopline: "SHOPLINE",
  unknown: "未知",
};

/** 案件狀態（流程）：主狀態 dropdown 用，與 @shared/schema CASE_STATUS_VALUES 一致 */
export const CASE_STATUS_VALUES: ContactStatus[] = [
  "pending",
  "processing",
  "waiting_customer",
  "resolved_observe",
  "closed",
  "reopened",
];

/** 系統標記／案件屬性，與 @shared/schema SYSTEM_MARK_VALUES 一致 */
export const SYSTEM_MARK_VALUES: ContactStatus[] = [
  "awaiting_human",
  "new_case",
  "assigned",
  "pending_info",
  "pending_order_id",
  "high_risk",
];
