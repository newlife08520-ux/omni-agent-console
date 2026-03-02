export type UserRole = "super_admin" | "marketing_manager" | "cs_agent";
export type ChannelPlatform = "line" | "messenger";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  created_at: string;
}

export interface Brand {
  id: number;
  name: string;
  slug: string;
  logo_url: string;
  description: string;
  system_prompt: string;
  superlanding_merchant_no: string;
  superlanding_access_key: string;
  return_form_url: string;
  shopline_store_domain: string;
  shopline_api_token: string;
  created_at: string;
}

export interface Channel {
  id: number;
  brand_id: number;
  platform: ChannelPlatform;
  channel_name: string;
  bot_id: string;
  access_token: string;
  channel_secret: string;
  is_active: number;
  is_ai_enabled: number;
  created_at: string;
}

export interface ChannelWithBrand extends Channel {
  brand_name?: string;
  brand_slug?: string;
}

export type ContactStatus = "pending" | "processing" | "resolved" | "ai_handling" | "awaiting_human" | "high_risk" | "closed";
export type IssueType = "order_inquiry" | "product_consult" | "return_refund" | "complaint" | "order_modify" | "general" | "other";
export type OrderSource = "superlanding" | "shopline" | "unknown";

export interface Contact {
  id: number;
  platform: string;
  platform_user_id: string;
  display_name: string;
  avatar_url: string | null;
  needs_human: number;
  is_pinned: number;
  status: ContactStatus;
  tags: string;
  vip_level: number;
  order_count: number;
  total_spent: number;
  cs_rating: number | null;
  ai_rating: number | null;
  last_message_at: string | null;
  created_at: string;
  brand_id: number | null;
  channel_id: number | null;
  issue_type: IssueType | null;
  order_source: OrderSource | null;
}

export interface ContactWithPreview extends Contact {
  last_message?: string;
  brand_name?: string;
  channel_name?: string;
}

export interface Message {
  id: number;
  contact_id: number;
  platform: string;
  sender_type: "user" | "ai" | "admin" | "system";
  content: string;
  message_type: "text" | "image" | "file";
  image_url: string | null;
  created_at: string;
}

export interface Setting {
  key: string;
  value: string;
}

export interface KnowledgeFile {
  id: number;
  filename: string;
  original_name: string;
  size: number;
  content: string | null;
  created_at: string;
  brand_id: number | null;
}

export interface ImageAsset {
  id: number;
  filename: string;
  original_name: string;
  display_name: string;
  description: string;
  keywords: string;
  size: number;
  mime_type: string;
  brand_id: number | null;
  created_at: string;
}

export interface TeamMember {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  created_at: string;
}

export interface MarketingRule {
  id: number;
  keyword: string;
  pitch: string;
  url: string;
  created_at: string;
  brand_id: number | null;
}

export interface OrderInfo {
  global_order_id: string;
  status: string;
  final_total_order_amount: number;
  product_list: string;
  buyer_name: string;
  buyer_phone: string;
  buyer_email: string;
  tracking_number: string;
  created_at: string;
  shipped_at?: string;
  order_created_at?: string;
  shipping_method?: string;
  payment_method?: string;
  address?: string;
  note?: string;
  source?: OrderSource;
}

export interface AiLog {
  id: number;
  contact_id: number | null;
  message_id: number | null;
  brand_id: number | null;
  prompt_summary: string;
  knowledge_hits: string;
  tools_called: string;
  transfer_triggered: number;
  transfer_reason: string | null;
  result_summary: string;
  token_usage: number;
  model: string;
  response_time_ms: number;
  created_at: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  message: string;
  user?: { id: number; username: string; display_name: string; role: string };
}

export interface AnalyticsData {
  kpi: {
    todayInbound: number;
    completedCount: number;
    completionRate: number;
    aiInterceptRate: number;
    avgFrtAi: string;
    avgFrtHuman: string;
    aiResolutionRate: number;
    transferRate: number;
    orderQuerySuccessRate: number;
  };
  agentPerformance: { name: string; cases: number }[];
  intentDistribution: { name: string; value: number }[];
  aiInsights: {
    painPoints: string[];
    suggestions: string[];
  };
  issueTypeDistribution: { name: string; value: number }[];
  orderSourceDistribution: { name: string; value: number }[];
  transferReasons: { reason: string; count: number }[];
  platformDistribution: { name: string; value: number }[];
}

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  pending: "待處理",
  processing: "處理中",
  resolved: "已解決",
  ai_handling: "AI處理中",
  awaiting_human: "待人工",
  high_risk: "高風險",
  closed: "已關閉",
};

export const CONTACT_STATUS_COLORS: Record<ContactStatus, { bg: string; dot: string }> = {
  pending: { bg: "bg-red-50 text-red-700", dot: "bg-red-500" },
  processing: { bg: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
  resolved: { bg: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  ai_handling: { bg: "bg-blue-50 text-blue-700", dot: "bg-blue-500" },
  awaiting_human: { bg: "bg-orange-50 text-orange-700", dot: "bg-orange-500" },
  high_risk: { bg: "bg-rose-50 text-rose-700", dot: "bg-rose-600" },
  closed: { bg: "bg-stone-50 text-stone-500", dot: "bg-stone-400" },
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

export const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "超級管理員",
  marketing_manager: "行銷經理",
  cs_agent: "客服人員",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  new_order: "新訂單",
  confirming: "確認中",
  confirmed: "已確認",
  awaiting_for_shipment: "待出貨",
  shipping: "出貨中",
  shipped: "已出貨",
  delay_handling: "延遲出貨",
  other: "其他",
  refunding: "退款中",
  refunded: "已退款",
  replacement: "換貨中",
  temp: "臨時",
  returned: "已退貨",
  pending: "待處理",
  canceled: "已取消",
};
