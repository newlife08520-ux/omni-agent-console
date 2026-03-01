export type UserRole = "super_admin" | "marketing_manager" | "cs_agent";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  created_at: string;
}

export interface Contact {
  id: number;
  platform: string;
  platform_user_id: string;
  display_name: string;
  avatar_url: string | null;
  needs_human: number;
  is_pinned: number;
  status: "pending" | "processing" | "resolved";
  tags: string;
  vip_level: number;
  order_count: number;
  total_spent: number;
  cs_rating: number | null;
  last_message_at: string | null;
  created_at: string;
}

export interface ContactWithPreview extends Contact {
  last_message?: string;
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
}

export interface OrderInfo {
  global_order_id: string;
  status: string;
  final_total_order_amount: number;
  product_list: string;
  buyer_name: string;
  buyer_phone: string;
  tracking_number: string;
  created_at: string;
  shipped_at?: string;
  order_created_at?: string;
  shipping_method?: string;
  payment_method?: string;
  address?: string;
  note?: string;
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
  };
  agentPerformance: { name: string; cases: number }[];
  intentDistribution: { name: string; value: number }[];
  aiInsights: {
    painPoints: string[];
    suggestions: string[];
  };
}

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
